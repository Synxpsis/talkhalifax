import { Env, User, json, randomId } from "./env";

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
async function tellRoom(env: Env, id: string, body: unknown) {
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

export async function newsroom(req: Request, env: Env, url: URL): Promise<Response> {
  const token = env.NEWSROOM_TOKEN;
  if (!token || req.headers.get("authorization") !== `Bearer ${token}`) return json({ error: "Unauthorized" }, { status: 401 });
  const m = url.pathname.match(/^\/api\/newsroom\/stories\/([A-Za-z0-9_.~-]{1,200})$/);
  if (!m || req.method !== "PUT") return json({ error: "Use PUT /api/newsroom/stories/<id>" }, { status: 404 });
  const id = m[1];
  let input: Record<string, unknown>;
  try { input = await req.json(); } catch { return json({ error: "Body must be JSON" }, { status: 400 }); }
  const note = String(input.note ?? "").slice(0, 300);

  const cols: Record<string, unknown> = {};
  for (const [apiName, col] of Object.entries(API_NAMES)) {
    if (input[apiName] === undefined) continue;
    cols[col] = JSON_FIELDS.has(col) ? JSON.stringify(input[apiName]) : input[apiName];
  }
  const existing = await env.DB.prepare("SELECT version, stage FROM stories WHERE id = ?").bind(id).first<{ version: number; stage: string }>();
  const now = nowIso();

  if (!existing) {
    for (const need of ["kind", "headline", "source_url", "published_at"]) if (cols[need] == null) return json({ error: `New stories need ${need}` }, { status: 400 });
    const names = Object.keys(cols);
    await env.DB.prepare(
      `INSERT INTO stories (id, ${names.join(", ")}, stage, developing_since, last_newsroom_update, update_note, version, updated_at)
       VALUES (?, ${names.map(() => "?").join(", ")}, 'developing', ?, ?, '', 1, ?)`,
    ).bind(id, ...names.map(n => cols[n]), now, now, now).run();
    await snapshot(env, id, 1, note || "Published");
    return json({ ok: true, id, version: 1, created: true });
  }

  const sets = Object.keys(cols).map(n => `${n} = ?`);
  const version = existing.version + 1;
  // An update to an archived article brings it back to Developing, chat and all
  const reopen = existing.stage === "archived" && input.reopen === true;
  await env.DB.prepare(
    `UPDATE stories SET ${[...sets, "version = ?", "updated_at = ?", "last_newsroom_update = ?", "update_note = ?"].join(", ")}
       ${reopen ? ", stage = 'developing', developing_since = ?, archived_at = NULL" : ""} WHERE id = ?`,
  ).bind(...Object.values(cols), version, now, now, note, ...(reopen ? [now] : []), id).run();
  await snapshot(env, id, version, note);
  await tellRoom(env, id, { t: "updated", version, note });
  return json({ ok: true, id, version, reopened: reopen });
}

async function snapshot(env: Env, id: string, version: number, note: string) {
  const row = await env.DB.prepare(`SELECT ${FIELDS.join(", ")} FROM stories WHERE id = ?`).bind(id).first();
  await env.DB.prepare("INSERT INTO story_versions (story_id, version, snapshot, note, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, version, JSON.stringify(row), note, nowIso()).run();
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
