import { Env, User, json, randomId } from "./env";
import { approvalOn, offerPush, sendDraft, sendUpdate, tellEditor } from "./telegram";
import { screen } from "./screen";

// ---------- When a developing story moves down to Articles ----------
// All of these must hold, or it has been developing longer than MAX_DEVELOPING.
export const STAGE_RULES = {
  MIN_DEVELOPING_MS: 24 * 36e5,     // developing for at least a day
  QUIET_NEWSROOM_MS: 12 * 36e5,     // Claude hasn't updated it in 12 hours
  QUIET_CHAT_MS: 3 * 36e5,          // nobody has chatted in 3 hours
  MAX_DEVELOPING_MS: 7 * 864e5,     // after a week it moves regardless
};

const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const roomStub = (env: Env, id: string) => env.ROOMS.get(env.ROOMS.idFromName(id));

/** Tell a story's room something happened (article updated, chat closing). Ignored if nobody ever opened it. */
export async function tellRoom(env: Env, id: string, body: unknown) {
  await roomStub(env, id).fetch(new Request(`https://room/${encodeURIComponent(id)}/internal`, {
    method: "POST", headers: { "x-th-internal": "1", "x-th-story": id }, body: JSON.stringify(body),
  }));
}

export async function archiveStory(env: Env, id: string, reason: string) {
  const res = await env.DB.prepare("UPDATE stories SET stage = 'archived', archived_at = ? WHERE id = ? AND kind = 'article' AND stage = 'developing'")
    .bind(nowIso(), id).run();
  if (!res.meta.changes) return false;
  // The live chat doesn't carry over: the room closes and clears its history
  await tellRoom(env, id, { t: "close", reason });
  await env.DB.batch([
    env.DB.prepare("UPDATE message_index SET deleted = 1 WHERE story_id = ?").bind(id),
    env.DB.prepare("DELETE FROM room_stats WHERE story_id = ?").bind(id),
  ]);
  return true;
}

export async function reopenStory(env: Env, id: string) {
  const res = await env.DB.prepare("UPDATE stories SET stage = 'developing', developing_since = ?, archived_at = NULL WHERE id = ? AND kind = 'article' AND stage = 'archived'")
    .bind(nowIso(), id).run();
  return !!res.meta.changes;
}

/** Runs on the cron: moves quiet developing stories down to Articles. */
export async function evaluateStages(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT s.id, COALESCE(s.developing_since, s.published_at) AS since, s.last_newsroom_update AS upd,
            rs.last_message_at AS last_msg, COALESCE(rs.here_now, 0) AS here
       FROM stories s LEFT JOIN room_stats rs ON rs.story_id = s.id
      WHERE s.kind = 'article' AND s.stage = 'developing'`,
  ).all<{ id: string; since: string; upd: string | null; last_msg: number | null; here: number }>();
  const now = Date.now();
  const moved: string[] = [];
  for (const r of rows.results) {
    const age = now - Date.parse(r.since);
    const quiet = age >= STAGE_RULES.MIN_DEVELOPING_MS
      && (!r.upd || now - Date.parse(r.upd) >= STAGE_RULES.QUIET_NEWSROOM_MS)
      && (!r.last_msg || now - r.last_msg >= STAGE_RULES.QUIET_CHAT_MS)
      && r.here === 0;
    if (quiet || age >= STAGE_RULES.MAX_DEVELOPING_MS) {
      if (await archiveStory(env, r.id, quiet ? "quiet" : "week")) moved.push(r.id);
    }
  }
  return moved;
}

// ---------- Newsroom: how Claude publishes and updates stories ----------
// Authenticated with the NEWSROOM_TOKEN secret (Authorization: Bearer …).
const FIELDS = ["kind", "section", "area", "headline", "dek", "facts", "body", "means", "status_label", "superseded_by", "read_min", "reason", "source_url", "published_at"] as const;
const JSON_FIELDS = new Set(["facts", "body", "means"]);
const API_NAMES: Record<string, typeof FIELDS[number]> = {
  kind: "kind", section: "section", area: "area", headline: "headline", dek: "dek", facts: "facts", body: "body", means: "means",
  statusLabel: "status_label", supersededBy: "superseded_by", readMin: "read_min", reason: "reason", source: "source_url", publishedAt: "published_at",
};

export class NewsroomError extends Error {}

// ---------- Changes that skip the editor ----------
// Notices built from the conditions tool (weather warnings, NS Power outage totals) are live data. A change to one that
// only moves numbers, times and dates (new counts, a new "updated at") goes live at once and the editor is told after.
// Anything else, a new status or new wording, still waits for a tap.
export const LIVE_NOTICE = /^(ns-power-outages-|weather-)/;
const NUMBER_ONLY_FIELDS = new Set(["headline", "dek", "facts", "body", "means", "published_at"]);
const TIME_WORDS = /\b[ap]\.m\.|\b(am|pm|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tonight|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?)\b\.?/gi;
/** The text with its numbers, times and dates blanked out, so two versions that differ only in those compare equal. */
const shape = (v: unknown) => String(v ?? "").toLowerCase().replace(TIME_WORDS, "#").replace(/\d[\d,.:+-]*/g, "#").replace(/#(\W*#)+/g, "#").replace(/\s+/g, " ").trim();
function numberOnly(current: Record<string, unknown>, cols: Record<string, unknown>) {
  const changed = Object.keys(cols).filter(c => String(cols[c]) !== String(current[c] ?? ""));
  return changed.length > 0 && changed.every(c => NUMBER_ONLY_FIELDS.has(c) && shape(cols[c]) === shape(current[c]));
}

/** Create a story (developing, or a draft held for review) or update an existing one. Shared by the REST endpoint and the MCP tools. */
export async function saveStory(env: Env, id: string, input: Record<string, unknown>,
  opts: { mode: "create" | "update" | "upsert"; review?: boolean; author?: string; approved?: boolean } = { mode: "upsert" }) {
  if (!/^[A-Za-z0-9_.~-]{1,200}$/.test(id)) throw new NewsroomError("Story ids use letters, numbers, dots, dashes, underscores and tildes (up to 200).");
  const note = String(input.note ?? "").slice(0, 300);
  const author = (opts.author || "").slice(0, 60);
  const cols: Record<string, unknown> = {};
  for (const [apiName, col] of Object.entries(API_NAMES)) {
    if (input[apiName] === undefined) continue;
    cols[col] = JSON_FIELDS.has(col) ? JSON.stringify(input[apiName]) : input[apiName];
  }
  if (cols.kind != null && !["article", "notice", "skip"].includes(String(cols.kind))) throw new NewsroomError("kind must be article, notice or skip.");
  const existing = await env.DB.prepare(`SELECT version, stage, ${FIELDS.join(", ")} FROM stories WHERE id = ?`).bind(id).first<{ version: number; stage: string } & Record<string, unknown>>();
  const now = nowIso();

  if (!existing) {
    if (opts.mode === "update") throw new NewsroomError(`No story with id ${id}. Use publish_story to create it.`);
    for (const need of ["kind", "headline", "source_url", "published_at"]) if (cols[need] == null) throw new NewsroomError(`New stories need ${need === "source_url" ? "source" : need === "published_at" ? "publishedAt" : need}.`);
    // Once the editor's Telegram is set up, every new article waits for approval; notices still publish at once
    const held = opts.review || (cols.kind === "article" && approvalOn(env));
    const stage = held && cols.kind !== "skip" ? "draft" : "developing";
    // The journalist is credited with everything it writes, once it has an account
    if (cols.kind !== "skip") { const j = await journalist(env); if (j) cols.author_id = j.id; }
    const names = Object.keys(cols);
    await env.DB.prepare(
      `INSERT INTO stories (id, ${names.join(", ")}, stage, developing_since, last_newsroom_update, update_note, version, updated_at)
       VALUES (?, ${names.map(() => "?").join(", ")}, ?, ?, ?, '', 1, ?)`,
    ).bind(id, ...names.map(n => cols[n]), stage, now, now, now).run();
    await snapshot(env, id, 1, note || (stage === "draft" ? "Drafted for review" : "Published"), author);
    if (stage !== "draft") {
      // A new live notice: the editor decides on Telegram whether it goes out as a push alert
      const alert = cols.kind === "notice" ? await offerPush(env, id) : undefined;
      return { id, version: 1, created: true, stage, ...(alert ? { alert } : {}) };
    }
    return { id, version: 1, created: true, stage, telegram: await sendDraft(env, id),
      next: "Waiting for the editor's approval. Call await_review with this id until it's approved or discarded." };
  }

  if (opts.mode === "create") throw new NewsroomError(`A story with id ${id} already exists (stage: ${existing.stage}). Use update_story to change it.`);
  if (existing.stage === "discarded") throw new NewsroomError("That story was discarded by a moderator and can't be changed.");
  if (!Object.keys(cols).length && input.reopen !== true) throw new NewsroomError("Nothing to change: pass at least one field.");
  // Once the editor's Telegram is set up, changes to published stories wait for approval too (drafts have no readers yet)
  let auto = false;
  if (!opts.approved && existing.stage !== "draft" && approvalOn(env)) {
    // One change at a time per story, so the editor never approves two that clash
    const waiting = await env.DB.prepare("SELECT n FROM pending_updates WHERE story_id = ? AND status = 'waiting' ORDER BY n DESC LIMIT 1").bind(id).first<{ n: number }>();
    if (waiting) throw new NewsroomError(`An update to this story (u${waiting.n}) is already waiting for the editor on Telegram. Leave the story as it is until they decide.`);
    auto = existing.kind === "notice" && LIVE_NOTICE.test(id) && input.reopen !== true && numberOnly(existing, cols);
  }
  if (!opts.approved && existing.stage !== "draft" && approvalOn(env) && !auto) {
    const r = await env.DB.prepare("INSERT INTO pending_updates (story_id, input, author, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, JSON.stringify(input), author, Date.now()).run();
    const n = Number(r.meta.last_row_id), ref = `u${n}`;
    return { id, pending: ref, stage: existing.stage, telegram: await sendUpdate(env, n),
      next: `Waiting for the editor's approval. Call await_review with id "${ref}" until it's approved or discarded.` };
  }
  const sets = Object.keys(cols).map(n => `${n} = ?`);
  const version = existing.version + 1;
  // An update to an archived article brings it back to Developing, chat and all
  const reopen = existing.stage === "archived" && input.reopen === true;
  await env.DB.prepare(
    `UPDATE stories SET ${[...sets, "version = ?", "updated_at = ?", "last_newsroom_update = ?", "update_note = ?"].join(", ")}
       ${reopen ? ", stage = 'developing', developing_since = ?, archived_at = NULL" : ""} WHERE id = ?`,
  ).bind(...Object.values(cols), version, now, now, note, ...(reopen ? [now] : []), id).run();
  await snapshot(env, id, version, note, author);
  // Drafts have no readers yet; everything else tells its room
  if (existing.stage !== "draft") await tellRoom(env, id, { t: "updated", version, note });
  if (auto) {
    const esc = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
    await tellEditor(env, `🔢 <b>Updated without approval</b> (numbers only, live notice)\n\n<b>${esc(String(cols.headline ?? existing.headline))}</b>\n${esc(note)}`);
    return { id, version, created: false, stage: existing.stage, autoApplied: "Numbers-only change to a live-conditions notice: published now, and the editor was told." };
  }
  return { id, version, created: false, reopened: reopen, stage: reopen ? "developing" : existing.stage };
}

export async function newsroom(req: Request, env: Env, url: URL): Promise<Response> {
  if (!newsroomAuthorized(req, env)) return json({ error: "Unauthorized" }, { status: 401 });
  const m = url.pathname.match(/^\/api\/newsroom\/stories\/([A-Za-z0-9_.~-]{1,200})$/);
  if (!m || req.method !== "PUT") return json({ error: "Use PUT /api/newsroom/stories/<id>" }, { status: 404 });
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return json({ error: "Body must be JSON" }, { status: 400 }); }
  try {
    const r = await saveStory(env, m[1], input, { mode: "upsert", review: input.review === true, author: String(input.author || "newsroom-script") });
    return json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof NewsroomError) return json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/** The newsroom journalist's TalkHalifax account, once it has made one. */
export const journalist = (env: Env) =>
  env.DB.prepare("SELECT id, name, bio, persona, created_at FROM users WHERE provider = 'newsroom' AND provider_sub = 'journalist'")
    .first<{ id: string; name: string; bio: string; persona: string; created_at: number }>();

export const newsroomAuthorized =(req: Request, env: Env) =>
  !!env.NEWSROOM_TOKEN && req.headers.get("authorization") === `Bearer ${env.NEWSROOM_TOKEN}`;

async function snapshot(env: Env, id: string, version: number, note: string, author = "") {
  const row = await env.DB.prepare(`SELECT ${FIELDS.join(", ")} FROM stories WHERE id = ?`).bind(id).first();
  await env.DB.prepare("INSERT INTO story_versions (story_id, version, snapshot, note, created_at, author) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, version, JSON.stringify(row), note, nowIso(), author).run();
}

// ---------- Review: moderators approve or discard drafts ----------
export async function listDrafts(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT s.id, s.kind, s.headline, s.dek, s.area, s.facts, s.body, s.means, s.source_url AS source, s.updated_at AS updatedAt,
            (SELECT author FROM story_versions v WHERE v.story_id = s.id ORDER BY version DESC LIMIT 1) AS author
       FROM stories s WHERE s.stage = 'draft' ORDER BY s.updated_at DESC`,
  ).all<Record<string, string>>();
  return rows.results.map(r => ({ ...r, facts: JSON.parse(r.facts), body: JSON.parse(r.body), means: JSON.parse(r.means) }));
}

export async function reviewDraft(env: Env, id: string, action: "approve" | "discard") {
  const now = nowIso();
  const res = action === "approve"
    ? await env.DB.prepare("UPDATE stories SET stage = 'developing', developing_since = ?, updated_at = ? WHERE id = ? AND stage = 'draft'").bind(now, now, id).run()
    : await env.DB.prepare("UPDATE stories SET stage = 'discarded', updated_at = ? WHERE id = ? AND stage = 'draft'").bind(now, id).run();
  if (!res.meta.changes) return false;
  if (action === "approve") {
    const s = await env.DB.prepare("SELECT kind FROM stories WHERE id = ?").bind(id).first<{ kind: string }>();
    if (s?.kind === "notice") await offerPush(env, id);
  }
  return true;
}

/** The editor's decision on a held update. Claims it first, so a double tap can't apply it twice. */
export async function reviewUpdate(env: Env, n: number, action: "approve" | "discard") {
  const p = await env.DB.prepare("SELECT story_id, input, author FROM pending_updates WHERE n = ? AND status = 'waiting'").bind(n).first<{ story_id: string; input: string; author: string }>();
  if (!p) return false;
  const res = await env.DB.prepare("UPDATE pending_updates SET status = ?, decided_at = ? WHERE n = ? AND status = 'waiting'")
    .bind(action === "approve" ? "approved" : "discarded", Date.now(), n).run();
  if (!res.meta.changes) return false;
  if (action === "approve") await saveStory(env, p.story_id, JSON.parse(p.input), { mode: "update", author: p.author, approved: true });
  return true;
}

// ---------- Comments on Articles ----------
const COMMENT_MAX = 2000;

export async function listComments(env: Env, storyId: string) {
  const rows = await env.DB.prepare(
    `SELECT c.id, c.parent_id AS parentId, c.user_id AS uid, c.text, c.created_at AS at, u.name, u.avatar_url AS avatar
       FROM comments c JOIN users u ON u.id = c.user_id
      WHERE c.story_id = ? AND c.deleted = 0 ORDER BY c.created_at ASC LIMIT 1000`,
  ).bind(storyId).all();
  return json({ comments: rows.results });
}

export async function addComment(req: Request, env: Env, storyId: string, user: User, allow: (key: string, limit: number, windowMs: number) => Promise<boolean>) {
  if (user.banned) return json({ error: "Your account can't post right now." }, { status: 403 });
  const story = await env.DB.prepare("SELECT stage, kind FROM stories WHERE id = ?").bind(storyId).first<{ stage: string; kind: string }>();
  if (!story || story.kind !== "article") return json({ error: "Not found" }, { status: 404 });
  if (story.stage !== "archived") return json({ error: "This story is still developing. Join the live chat instead." }, { status: 409 });
  let body: { text?: unknown; parentId?: unknown } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const text = String(body.text ?? "").replace(/\r\n/g, "\n").trim().slice(0, COMMENT_MAX);
  if (!text) return json({ error: "Write something first." }, { status: 400 });
  let parentId: string | null = body.parentId ? String(body.parentId) : null;
  if (parentId) {
    // Replies attach to the top of their thread, so threads stay one level deep
    const p = await env.DB.prepare("SELECT id, parent_id FROM comments WHERE id = ? AND story_id = ? AND deleted = 0").bind(parentId, storyId).first<{ id: string; parent_id: string | null }>();
    if (!p) return json({ error: "That comment was removed." }, { status: 404 });
    parentId = p.parent_id || p.id;
  }
  if (!(await allow(`comment:${user.id}`, 6, 60_000))) return json({ error: "You're commenting quickly. Wait a minute and try again." }, { status: 429 });
  const why = await screen(env, text, user);
  if (why) return json({ error: why }, { status: 422 });
  const id = randomId("c_", 8);
  const at = Date.now();
  await env.DB.prepare("INSERT INTO comments (id, story_id, parent_id, user_id, text, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, storyId, parentId, user.id, text, at).run();
  return json({ comment: { id, parentId, uid: user.id, text, at, name: user.name, avatar: user.avatar_url } });
}

export async function deleteComment(env: Env, commentId: string, user: User) {
  const c = await env.DB.prepare("SELECT user_id FROM comments WHERE id = ? AND deleted = 0").bind(commentId).first<{ user_id: string }>();
  if (!c) return json({ error: "Not found" }, { status: 404 });
  if (c.user_id !== user.id && user.role !== "moderator") return json({ error: "You can only delete your own comments." }, { status: 403 });
  await env.DB.prepare("UPDATE comments SET deleted = 1 WHERE id = ?").bind(commentId).run();
  return json({ ok: true });
}
