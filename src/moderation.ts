import { Env, User, json, randomId } from "./env";
import { tellRoom } from "./stories";
import { tellEditor } from "./telegram";

/**
 * Reports, removals, bans and account deletion.
 * Chat messages live in each story's room; message_index holds a copy of each, which is what reports read.
 */

const tgEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A reader flags a chat message or comment. The editor hears about the first report on each item. */
export async function report(req: Request, env: Env, user: User, allow: (key: string, limit: number, windowMs: number) => Promise<boolean>) {
  if (user.banned) return json({ error: "Your account can't report right now." }, { status: 403 });
  let body: { kind?: unknown; id?: unknown } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const kind = body.kind === "comment" ? "comment" : body.kind === "message" ? "message" : null;
  const id = String(body.id ?? "");
  if (!kind || !id) return json({ error: "Bad request" }, { status: 400 });
  const item = await env.DB.prepare(kind === "message"
    ? "SELECT story_id, user_id, text FROM message_index WHERE id = ? AND deleted = 0"
    : "SELECT story_id, user_id, text FROM comments WHERE id = ? AND deleted = 0").bind(id).first<{ story_id: string; user_id: string; text: string }>();
  if (!item) return json({ error: "That was already removed." }, { status: 404 });
  if (item.user_id === user.id) return json({ error: "That's yours. You can delete it instead." }, { status: 400 });
  if (!(await allow(`report:${user.id}`, 20, 3600_000))) return json({ error: "You've sent a lot of reports. Try again in an hour." }, { status: 429 });
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO reports (id, kind, target_id, story_id, author_id, text, reporter_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(randomId("r_", 8), kind, id, item.story_id, item.user_id, item.text, user.id, Date.now()).run();
  if (res.meta.changes) {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE target_id = ? AND resolved IS NULL").bind(id).first<{ n: number }>();
    if (n?.n === 1) {
      const who = await env.DB.prepare("SELECT name FROM users WHERE id = ?").bind(item.user_id).first<{ name: string }>();
      await tellEditor(env, `🚩 <b>Reported ${kind}</b> by ${tgEsc(who?.name || "someone")}:\n\n${tgEsc(item.text.slice(0, 500))}\n\nReview it under Reports on your profile.`);
    }
  }
  return json({ ok: true });
}

/** Open reports, one row per reported item, newest first. */
export async function listReports(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT r.kind, r.target_id AS id, r.story_id AS storyId, r.author_id AS authorId, r.text, COUNT(*) AS reports, MIN(r.created_at) AS at,
            u.name AS author, u.banned, s.headline
       FROM reports r LEFT JOIN users u ON u.id = r.author_id LEFT JOIN stories s ON s.id = r.story_id
      WHERE r.resolved IS NULL GROUP BY r.target_id ORDER BY at DESC LIMIT 100`,
  ).all();
  return json({ reports: rows.results });
}

/** A moderator removes the reported item or dismisses the reports. */
export async function resolveReport(env: Env, targetId: string, action: "remove" | "dismiss") {
  const r = await env.DB.prepare("SELECT kind, story_id FROM reports WHERE target_id = ? AND resolved IS NULL LIMIT 1")
    .bind(targetId).first<{ kind: string; story_id: string }>();
  if (!r) return false;
  if (action === "remove") {
    if (r.kind === "message") await removeMessages(env, r.story_id, [targetId]);
    else await env.DB.prepare("UPDATE comments SET deleted = 1 WHERE id = ?").bind(targetId).run();
  }
  await env.DB.prepare("UPDATE reports SET resolved = ? WHERE target_id = ? AND resolved IS NULL").bind(action === "remove" ? "removed" : "dismissed", targetId).run();
  return true;
}

/** Take messages out of a story's live chat (everyone's screen updates) and mark them deleted. */
async function removeMessages(env: Env, storyId: string, ids: string[]) {
  await tellRoom(env, storyId, { t: "remove", ids });
  for (let i = 0; i < ids.length; i += 50) {
    const part = ids.slice(i, i + 50);
    await env.DB.prepare(`UPDATE message_index SET deleted = 1 WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).run();
  }
}

/** Everything someone has posted: chat messages in every room, and comments. */
async function removeEverything(env: Env, userId: string) {
  const rows = (await env.DB.prepare("SELECT id, story_id FROM message_index WHERE user_id = ? AND deleted = 0").bind(userId).all<{ id: string; story_id: string }>()).results;
  const byStory = new Map<string, string[]>();
  for (const r of rows) byStory.set(r.story_id, [...(byStory.get(r.story_id) || []), r.id]);
  for (const [storyId, ids] of byStory) await removeMessages(env, storyId, ids);
  await env.DB.prepare("UPDATE comments SET deleted = 1 WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("UPDATE reports SET resolved = 'removed' WHERE author_id = ? AND resolved IS NULL").bind(userId).run();
}

/** Ban or unban someone; `purge` also removes everything they've posted. Moderators and the journalist can't be banned. */
export async function setBanned(env: Env, userId: string, banned: boolean, purge: boolean) {
  const u = await env.DB.prepare("SELECT role, provider FROM users WHERE id = ?").bind(userId).first<{ role: string; provider: string }>();
  if (!u) return json({ error: "Not found" }, { status: 404 });
  if (u.role === "moderator" || u.provider === "newsroom") return json({ error: "Moderators and the journalist can't be banned." }, { status: 400 });
  await env.DB.prepare("UPDATE users SET banned = ? WHERE id = ?").bind(banned ? 1 : 0, userId).run();
  if (banned && purge) await removeEverything(env, userId);
  return json({ ok: true, banned });
}

/** Someone deletes their own account: their posts go, the account is emptied and every session ends. */
export async function deleteAccount(env: Env, user: User) {
  if (user.provider === "newsroom") return json({ error: "The journalist's account can't be deleted here." }, { status: 400 });
  await removeEverything(env, user.id);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET name = 'Deleted account', avatar_url = '', email = '', bio = '', provider = 'deleted', provider_sub = id,
              password_hash = NULL, role = 'member' WHERE id = ?`,
    ).bind(user.id),
    // The words themselves are erased, not just hidden
    env.DB.prepare("UPDATE message_index SET deleted = 1, text = '' WHERE user_id = ?").bind(user.id),
    env.DB.prepare("UPDATE comments SET deleted = 1, text = '' WHERE user_id = ?").bind(user.id),
    env.DB.prepare("UPDATE reports SET text = '' WHERE author_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM reports WHERE reporter_id = ?").bind(user.id),
  ]);
  return json({ ok: true });
}
