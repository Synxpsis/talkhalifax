import { Env, json } from "./env";
import { allow, currentUser, handleAuth, makeResetToken, providers, sameOrigin } from "./auth";
import { deleteAccount, listReports, report, resolveReport, setBanned } from "./moderation";
import { addComment, archiveStory, deleteComment, evaluateStages, listComments, listDrafts, newsroom, reopenStory, reviewDraft } from "./stories";
import { mcp } from "./mcp";
import { getWeather, refreshWeather } from "./weather";
import { getAlerts, refreshAlerts } from "./alerts";
import { telegramWebhook } from "./telegram";
export { ArticleRoom } from "./room";

interface StoryRow {
  id: string; kind: string; status: string; section: string; area: string; headline: string; dek: string;
  facts: string; body: string; means: string; status_label: string; superseded_by: string | null;
  read_min: number; reason: string; source_url: string; published_at: string; version: number; updated_at: string;
  message_count: number | null; here_now: number | null; last_message_at: number | null;
  last_author_id: string | null; last_author_name: string | null;
  stage: string; developing_since: string | null; archived_at: string | null; last_newsroom_update: string | null; update_note: string;
  comment_count: number; last_comment_at: number | null;
  author_id: string | null; author_name: string | null; author_bio: string | null;
}

const storyOut = (r: StoryRow, full = false) => ({
  id: r.id, kind: r.kind, status: r.status, section: r.section, area: r.area,
  headline: r.headline, dek: r.dek, statusLabel: r.status_label, supersededBy: r.superseded_by,
  readMin: r.read_min, reason: r.reason, source: r.source_url, publishedAt: r.published_at,
  version: r.version, updatedAt: r.updated_at,
  stage: r.stage, developingSince: r.developing_since || r.published_at, archivedAt: r.archived_at,
  lastUpdate: r.last_newsroom_update, updateNote: r.update_note,
  comments: { count: r.comment_count ?? 0, lastAt: r.last_comment_at },
  room: { messages: r.message_count ?? 0, here: r.here_now ?? 0, lastAt: r.last_message_at, lastAuthor: r.last_author_name || null },
  author: r.author_id && r.author_name ? { id: r.author_id, name: r.author_name, bio: r.author_bio || "" } : null,
  ...(full ? { facts: JSON.parse(r.facts), body: JSON.parse(r.body), means: JSON.parse(r.means) } : {}),
});

const STORY_SELECT = `
  SELECT s.*, rs.message_count, rs.here_now, rs.last_message_at, rs.last_author_id, u.name AS last_author_name,
         au.name AS author_name, au.bio AS author_bio,
         (SELECT COUNT(*) FROM comments c WHERE c.story_id = s.id AND c.deleted = 0) AS comment_count,
         (SELECT MAX(created_at) FROM comments c WHERE c.story_id = s.id AND c.deleted = 0) AS last_comment_at
    FROM stories s
    LEFT JOIN room_stats rs ON rs.story_id = s.id
    LEFT JOIN users u ON u.id = rs.last_author_id
    LEFT JOIN users au ON au.id = s.author_id`;

async function api(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const path = url.pathname;

  if (path === "/api/me" && req.method === "GET") {
    const u = await currentUser(req, env);
    return json({
      user: u ? { id: u.id, name: u.name, avatarUrl: u.avatar_url, role: u.role, banned: !!u.banned, password: u.provider === "password" } : null,
      providers: providers(env, url),
    });
  }

  if (path === "/api/me/messages") {
    const u = await currentUser(req, env);
    if (!u) return json({ error: "Not signed in" }, { status: 401 });
    const rows = await env.DB.prepare(
      `SELECT m.id, m.story_id AS storyId, m.text, m.created_at AS at, s.headline
         FROM message_index m LEFT JOIN stories s ON s.id = m.story_id
        WHERE m.user_id = ? AND m.deleted = 0 ORDER BY m.created_at DESC LIMIT 50`,
    ).bind(u.id).all();
    const stats = await env.DB.prepare(
      `SELECT COUNT(*) AS messages, COUNT(DISTINCT story_id) AS rooms,
              SUM(CASE WHEN created_at > ? THEN 1 ELSE 0 END) AS today
         FROM message_index WHERE user_id = ? AND deleted = 0`,
    ).bind(Date.now() - 864e5, u.id).first();
    return json({ messages: rows.results, stats });
  }

  if (path === "/api/stories") {
    const rows = await env.DB.prepare(`${STORY_SELECT} WHERE s.stage IN ('developing', 'archived') ORDER BY s.published_at DESC LIMIT 200`).all<StoryRow>();
    return json({ stories: rows.results.map(r => storyOut(r)) });
  }

  const one = path.match(/^\/api\/stories\/([A-Za-z0-9_.~-]{1,200})$/);
  if (one) {
    const r = await env.DB.prepare(`${STORY_SELECT} WHERE s.id = ? AND s.stage IN ('developing', 'archived')`).bind(one[1]).first<StoryRow>();
    return r ? json({ story: storyOut(r, true) }) : json({ error: "Not found" }, { status: 404 });
  }

  // A person's public profile: name, picture, bio and, for the newsroom's journalist, the stories they wrote
  const pu = path.match(/^\/api\/users\/([A-Za-z0-9_]{1,40})$/);
  if (pu) {
    const u = await env.DB.prepare("SELECT id, name, avatar_url, bio, role, provider, created_at FROM users WHERE id = ?").bind(pu[1])
      .first<{ id: string; name: string; avatar_url: string; bio: string; role: string; provider: string; created_at: number }>();
    if (!u) return json({ error: "Not found" }, { status: 404 });
    const ai = u.provider === "newsroom";
    const stories = ai ? (await env.DB.prepare(
      `${STORY_SELECT} WHERE s.author_id = ? AND s.stage IN ('developing', 'archived') AND s.kind != 'skip' ORDER BY s.published_at DESC LIMIT 60`,
    ).bind(u.id).all<StoryRow>()).results.map(r => storyOut(r)) : [];
    const stats = await env.DB.prepare("SELECT COUNT(*) AS messages, COUNT(DISTINCT story_id) AS rooms FROM message_index WHERE user_id = ? AND deleted = 0")
      .bind(u.id).first<{ messages: number; rooms: number }>();
    // Moderators also see whether they're banned and whether a reset link can be made
    const viewer = await currentUser(req, env);
    const mod = viewer?.role === "moderator" && u.id !== viewer.id && !ai && u.role !== "moderator"
      ? { banned: !!(await env.DB.prepare("SELECT banned FROM users WHERE id = ?").bind(u.id).first<{ banned: number }>())?.banned, password: u.provider === "password" }
      : null;
    return json({
      user: { id: u.id, name: u.name, avatar: u.avatar_url, bio: u.bio, role: u.role, ai, joined: u.created_at },
      stats: { messages: stats?.messages ?? 0, rooms: stats?.rooms ?? 0 },
      stories,
      mod,
    });
  }

  // Someone deletes their own account
  if (path === "/api/me" && req.method === "DELETE") {
    if (req.headers.get("origin") !== url.origin) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u) return json({ error: "Sign in first." }, { status: 401 });
    const res = await deleteAccount(env, u);
    res.headers.append("set-cookie", `th_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${url.protocol === "https:" ? "; Secure" : ""}`);
    return res;
  }

  // Reports: anyone signed in flags a message or comment; moderators review them
  if (path === "/api/reports") {
    const u = await currentUser(req, env);
    if (req.method === "POST") {
      if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
      if (!u) return json({ error: "Sign in to report." }, { status: 401 });
      return report(req, env, u, (k, n, w) => allow(env, k, n, w));
    }
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    return listReports(env);
  }
  const rp = path.match(/^\/api\/reports\/([A-Za-z0-9_]{1,40})$/);
  if (rp && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    const { action } = await req.json<{ action?: string }>().catch(() => ({ action: "" }));
    if (action !== "remove" && action !== "dismiss") return json({ error: "action must be remove or dismiss" }, { status: 400 });
    return (await resolveReport(env, rp[1], action)) ? json({ ok: true }) : json({ error: "That report was already handled." }, { status: 409 });
  }

  // Moderators ban people and make password reset links
  const um = path.match(/^\/api\/users\/([A-Za-z0-9_]{1,40})\/(ban|reset)$/);
  if (um && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    if (um[2] === "ban") {
      const b = await req.json<{ banned?: boolean; purge?: boolean }>().catch(() => ({} as { banned?: boolean; purge?: boolean }));
      return setBanned(env, um[1], !!b.banned, !!b.purge);
    }
    const token = await makeResetToken(env, um[1], u.id);
    return token ? json({ url: `${url.origin}/#reset-${token}`, expiresIn: "1 hour" }) : json({ error: "Only accounts with a password can be reset." }, { status: 400 });
  }

  if (path === "/api/weather") return json({ weather: await getWeather(env, ctx) });
  if (path === "/api/alerts") return json({ alerts: await getAlerts(env, ctx) });

  // The newsroom (Claude) publishes and updates stories here, with its own token
  if (path.startsWith("/api/newsroom/")) return newsroom(req, env, url);

  // Threaded comments, once a story has moved to Articles
  const cm = path.match(/^\/api\/stories\/([A-Za-z0-9_.~-]{1,200})\/comments$/);
  if (cm) {
    if (req.method === "GET") return listComments(env, cm[1]);
    if (req.method !== "POST" || !sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u) return json({ error: "Sign in to comment." }, { status: 401 });
    return addComment(req, env, cm[1], u, (k, n, w) => allow(env, k, n, w));
  }
  const cd = path.match(/^\/api\/comments\/([A-Za-z0-9_]{1,40})$/);
  if (cd && req.method === "DELETE") {
    if (req.headers.get("origin") !== url.origin) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u) return json({ error: "Sign in first." }, { status: 401 });
    return deleteComment(env, cd[1], u);
  }

  // Moderators review drafts the newsroom held back (review: true)
  if (path === "/api/review") {
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    return json({ drafts: await listDrafts(env) });
  }
  const rv = path.match(/^\/api\/stories\/([A-Za-z0-9_.~-]{1,200})\/review$/);
  if (rv && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    const { action } = await req.json<{ action?: string }>().catch(() => ({ action: "" }));
    if (action !== "approve" && action !== "discard") return json({ error: "action must be approve or discard" }, { status: 400 });
    return (await reviewDraft(env, rv[1], action)) ? json({ ok: true }) : json({ error: "That draft is no longer waiting." }, { status: 409 });
  }

  // Moderators can move a story between Developing and Articles by hand
  const st = path.match(/^\/api\/stories\/([A-Za-z0-9_.~-]{1,200})\/stage$/);
  if (st && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
    const u = await currentUser(req, env);
    if (!u || u.role !== "moderator") return json({ error: "Moderators only." }, { status: 403 });
    const { stage } = await req.json<{ stage?: string }>().catch(() => ({ stage: "" }));
    const ok = stage === "archived" ? await archiveStory(env, st[1], "moderator") : stage === "developing" ? await reopenStory(env, st[1]) : false;
    return ok ? json({ ok: true }) : json({ error: "Nothing to change." }, { status: 409 });
  }

  return json({ error: "Not found" }, { status: 404 });
}

/** Upgrade to the story's ArticleRoom, passing who this is. Client-sent x-th-* headers are never forwarded. */
async function room(req: Request, env: Env, id: string): Promise<Response> {
  if (req.headers.get("upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
  const story = await env.DB.prepare("SELECT kind, stage FROM stories WHERE id = ?").bind(id).first<{ kind: string; stage: string }>();
  if (!story || story.kind !== "article" || story.stage !== "developing") return new Response("This story has no live chat", { status: 404 });
  const u = await currentUser(req, env);
  const headers = new Headers({ upgrade: "websocket", "x-th-story": id });
  if (u) { headers.set("x-th-user", u.id); headers.set("x-th-role", u.role); headers.set("x-th-banned", u.banned ? "1" : "0"); }
  const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
  return stub.fetch(new Request(`https://room/${encodeURIComponent(id)}`, { headers }));
}

/** Forget what's no longer needed: rate-limit counters (some are keyed by IP address), expired sessions and reset links. */
async function tidyUp(env: Env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM auth_throttle WHERE window_start < ?").bind(now - 864e5),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM password_resets WHERE expires_at < ?").bind(now),
  ]);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith("/auth/")) return (await handleAuth(req, env, url)) ?? new Response("Not found", { status: 404 });
      if (url.pathname.startsWith("/api/")) return await api(req, env, url, ctx);
      // The newsroom's MCP server, for Claude agents
      if (url.pathname === "/mcp") return await mcp(req, env);
      // The editor approves drafts from Telegram
      if (url.pathname.startsWith("/telegram/")) return await telegramWebhook(req, env, url);
      const r = url.pathname.match(/^\/rooms\/([A-Za-z0-9_.~-]{1,200})\/ws$/);
      if (r) return await room(req, env, r[1]);
      return env.ASSETS.fetch(req);
    } catch (e) {
      console.error(e);
      return json({ error: "Something went wrong" }, { status: 500 });
    }
  },

  async scheduled(_event: ScheduledController, env: Env) {
    await Promise.allSettled([refreshWeather(env), refreshAlerts(env), evaluateStages(env), tidyUp(env)]);
  },
} satisfies ExportedHandler<Env>;
