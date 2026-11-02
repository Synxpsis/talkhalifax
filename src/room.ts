import { DurableObject } from "cloudflare:workers";
import { Env, randomId } from "./env";

/**
 * One ArticleRoom per story: its live chat.
 *
 * Wire protocol (JSON text frames)
 *   client → room   { t: "send", text } | { t: "typing", on } | { t: "del", id }
 *   room → client   { t: "hello", you, messages, profiles, here }
 *                   { t: "msg", m, profile } | { t: "del", id } | { t: "here", here } | { t: "error", text }
 *
 * The Worker authenticates before upgrading and passes the person in x-th-* headers; a socket with no
 * user id is a reader. Names are looked up from D1, so a renamed account shows its current name.
 */

interface Attachment {
  uid: string | null;
  role: string;
  banned: boolean;
  typing: boolean;
  sent: number[];      // timestamps of recent sends, for rate limiting
}
interface Message { id: string; uid: string; text: string; at: number }
type Profile = { id: string; name: string; avatar: string };

/** Author id for the newsroom's own notes in the chat ("Article updated: …"). */
const NEWSROOM = "newsroom";
const MAX_LEN = 1000;
const HISTORY = 200;
const RATE = { count: 5, windowMs: 10_000 };

export class ArticleRoom extends DurableObject<Env> {
  private storyId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, uid TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL)`);
      this.storyId = (await this.ctx.storage.get<string>("storyId")) ?? null;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const storyId = req.headers.get("x-th-story")!;
    if (!this.storyId) { this.storyId = storyId; await this.ctx.storage.put("storyId", storyId); }
    // Signals from the Worker itself (never reachable from the internet: only the Worker can address this object)
    if (req.headers.get("x-th-internal") === "1") return this.internal(await req.json());
    if (req.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const uid = req.headers.get("x-th-user") || null;
    const att: Attachment = { uid, role: req.headers.get("x-th-role") || "member", banned: req.headers.get("x-th-banned") === "1", typing: false, sent: [] };
    this.ctx.acceptWebSocket(server, uid ? [uid] : []);
    server.serializeAttachment(att);

    const messages = this.ctx.storage.sql.exec<Message & Record<string, string | number>>(
      "SELECT id, uid, text, at FROM messages ORDER BY at DESC LIMIT ?", HISTORY).toArray().reverse() as Message[];
    const profiles = await this.profiles([...new Set(messages.map(m => m.uid))]);
    server.send(JSON.stringify({ t: "hello", you: uid ? { id: uid, role: att.role, banned: att.banned } : null, messages, profiles }));
    // Everyone (this socket included) gets the new "here" list with profiles
    await this.announceHere();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: { t?: string; text?: unknown; on?: unknown; id?: unknown };
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const att = ws.deserializeAttachment() as Attachment;
    const error = (text: string) => ws.send(JSON.stringify({ t: "error", text }));

    if (msg.t === "send") {
      if (!att.uid) return error("Sign in to join the chat.");
      if (att.banned) return error("Your account can't post right now.");
      const text = String(msg.text ?? "").replace(/\r\n/g, "\n").trim().slice(0, MAX_LEN);
      if (!text) return;
      const now = Date.now();
      att.sent = att.sent.filter(t => now - t < RATE.windowMs);
      if (att.sent.length >= RATE.count) return error("You're sending messages quickly. Wait a few seconds and try again.");
      att.sent.push(now);
      att.typing = false;
      ws.serializeAttachment(att);
      const m: Message = { id: randomId("m_", 8), uid: att.uid, text, at: now };
      this.ctx.storage.sql.exec("INSERT INTO messages (id, uid, text, at) VALUES (?, ?, ?, ?)", m.id, m.uid, m.text, m.at);
      const profile = (await this.profiles([m.uid]))[m.uid];
      this.broadcast({ t: "msg", m, profile });
      await this.env.DB.prepare("INSERT INTO message_index (id, story_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(m.id, this.storyId, m.uid, m.text, m.at).run();
      await this.updateStats();
      await this.announceHere();
      return;
    }

    if (msg.t === "typing") {
      if (!att.uid) return;
      const on = !!msg.on;
      if (att.typing === on) return;
      att.typing = on;
      ws.serializeAttachment(att);
      await this.announceHere();
      return;
    }

    if (msg.t === "del") {
      const id = String(msg.id ?? "");
      const row = this.ctx.storage.sql.exec<{ uid: string }>("SELECT uid FROM messages WHERE id = ?", id).toArray()[0];
      if (!row) return;
      // Authors delete their own; moderators remove anyone's
      if (row.uid !== att.uid && att.role !== "moderator") return error("You can only delete your own messages.");
      this.ctx.storage.sql.exec("DELETE FROM messages WHERE id = ?", id);
      this.broadcast({ t: "del", id });
      await this.env.DB.prepare("UPDATE message_index SET deleted = 1 WHERE id = ?").bind(id).run();
      await this.updateStats();
    }
  }

  async webSocketClose(ws: WebSocket) { ws.close(); await this.announceHere(); }
  async webSocketError() { await this.announceHere(); }

  /**
   * "updated": the newsroom changed the article. Readers refetch it, and a note goes into the chat.
   * "close":   the story moved to Articles. Everyone is told, sockets close, and the chat history is cleared.
   */
  private async internal(sig: { t: string; version?: number; note?: string }) {
    if (sig.t === "updated") {
      const note = String(sig.note || "").slice(0, 300);
      const m: Message = { id: randomId("m_", 8), uid: NEWSROOM, text: note ? `Article updated: ${note}` : "Article updated.", at: Date.now() };
      this.ctx.storage.sql.exec("INSERT INTO messages (id, uid, text, at) VALUES (?, ?, ?, ?)", m.id, m.uid, m.text, m.at);
      this.broadcast({ t: "article", version: sig.version, note });
      this.broadcast({ t: "msg", m, profile: null });
      await this.updateStats();
    } else if (sig.t === "close") {
      this.broadcast({ t: "closed" });
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, "Moved to Articles"); } catch { /* already closing */ } }
      this.ctx.storage.sql.exec("DELETE FROM messages");
    }
    return new Response("ok");
  }

  // ---------- helpers ----------

  private broadcast(data: unknown) {
    const s = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch { /* closing */ } }
  }

  /** Signed-in people here now (one entry per person, however many tabs), plus a count of signed-out readers. */
  private here() {
    const people = new Map<string, { id: string; typing: boolean }>();
    let readers = 0;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING) continue;
      const a = ws.deserializeAttachment() as Attachment;
      if (!a.uid) { readers++; continue; }
      const prev = people.get(a.uid);
      people.set(a.uid, { id: a.uid, typing: a.typing || !!prev?.typing });
    }
    return { here: [...people.values()], readers };
  }

  private async announceHere() {
    const { here, readers } = this.here();
    const profiles = await this.profiles(here.map(h => h.id));
    this.broadcast({ t: "here", here, profiles, readers });
    await this.env.DB.prepare(
      `INSERT INTO room_stats (story_id, here_now, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(story_id) DO UPDATE SET here_now = excluded.here_now, updated_at = excluded.updated_at`,
    ).bind(this.storyId, here.length, Date.now()).run();
  }

  private async updateStats() {
    const s = this.ctx.storage.sql.exec<{ n: number; last: number | null }>("SELECT COUNT(*) AS n, MAX(at) AS last FROM messages").toArray()[0];
    const lastAuthor = s.last ? this.ctx.storage.sql.exec<{ uid: string }>("SELECT uid FROM messages ORDER BY at DESC LIMIT 1").toArray()[0]?.uid ?? null : null;
    await this.env.DB.prepare(
      `INSERT INTO room_stats (story_id, message_count, last_message_at, last_author_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(story_id) DO UPDATE SET message_count = excluded.message_count, last_message_at = excluded.last_message_at,
         last_author_id = excluded.last_author_id, updated_at = excluded.updated_at`,
    ).bind(this.storyId, s.n, s.last, lastAuthor, Date.now()).run();
  }

  private async profiles(ids: string[]): Promise<Record<string, Profile>> {
    if (!ids.length) return {};
    const rows = await this.env.DB.prepare(
      `SELECT id, name, avatar_url AS avatar FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).bind(...ids).all<Profile>();
    return Object.fromEntries(rows.results.map(r => [r.id, r]));
  }
}
