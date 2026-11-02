// Telegram approvals: new drafts go to the editor's Telegram chat with Approve / Discard buttons.
// The bot's webhook (/telegram/webhook) handles the taps; the journalist waits on await_review meanwhile.
// Secrets: TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID (the editor's chat; the bot tells you it on /start).
import { Env, json } from "./env";
import { newsroomAuthorized, reviewDraft } from "./stories";

const SITE = "https://talkhalifax.alexwmmolloy.workers.dev";
const html = (s: unknown) => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/** New articles need the editor's approval once the bot is set up. */
export const approvalOn = (env: Env) => !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

async function tg(env: Env, method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  type Reply = { ok: boolean; description?: string; result?: any };
  const d: Reply = await r.json<Reply>().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!d.ok) throw new Error(`Telegram ${method}: ${d.description}`);
  return d.result;
}

/** The webhook's secret header, derived from the bot token so there's no extra secret to keep. */
async function hookSecret(env: Env) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("talkhalifax-webhook:" + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(h)].slice(0, 24).map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Send a draft to the editor. Returns "sent", or why it wasn't. */
export async function sendDraft(env: Env, id: string): Promise<string> {
  if (!approvalOn(env)) return "Telegram isn't set up";
  const s = await env.DB.prepare("SELECT rowid AS n, kind, headline, dek, area, section, facts, body, means, source_url FROM stories WHERE id = ?")
    .bind(id).first<Record<string, any>>();
  if (!s) return "no such story";
  const facts: { k: string; v: string }[] = JSON.parse(s.facts || "[]"), body: string[] = JSON.parse(s.body || "[]"), means: string[] = JSON.parse(s.means || "[]");
  const head = [
    `📝 <b>New ${s.kind === "notice" ? "notice" : "article"} waiting for your approval</b>`,
    "",
    `<b>${html(s.headline)}</b>`,
    s.dek ? `<i>${html(s.dek)}</i>` : "",
    [s.section, s.area].filter(Boolean).map(html).join(" · "),
    "",
    ...facts.map(f => `• <b>${html(f.k)}:</b> ${html(f.v)}`),
  ];
  const tail = [
    ...(means.length ? ["", `<b>${s.kind === "notice" ? "What to do" : "What this means"}</b>`, ...means.map(m => "• " + html(m))] : []),
    "",
    `Source: <a href="${html(s.source_url)}">halifax.ca release</a>`,
  ];
  // Telegram caps a message at 4096 characters; the body gives way first
  let text = "";
  for (let keep = body.length; keep >= 0; keep--) {
    text = [...head, "", ...body.slice(0, keep).map(html), keep < body.length ? "…" : "", ...tail].filter((l, i, a) => l || a[i - 1]).join("\n");
    if (text.length <= 4000) break;
  }
  try {
    await tg(env, "sendMessage", {
      chat_id: env.TELEGRAM_CHAT_ID, text: text.slice(0, 4096), parse_mode: "HTML", link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: "✅ Approve and publish", callback_data: `ap:${s.n}` }, { text: "🗑 Discard", callback_data: `dc:${s.n}` }]] },
    });
    return "sent";
  } catch (e) { return String((e as Error).message); }
}

/** Telegram calls this with every message to the bot and every button tap. */
export async function telegramWebhook(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) return new Response("Not found", { status: 404 });

  // POST /telegram/setup (newsroom token): point the bot's webhook here
  if (url.pathname === "/telegram/setup") {
    if (req.method !== "POST" || !newsroomAuthorized(req, env)) return json({ error: "Unauthorized" }, { status: 401 });
    await tg(env, "setWebhook", { url: `${url.origin}/telegram/webhook`, secret_token: await hookSecret(env), allowed_updates: ["message", "callback_query"] });
    const me = await tg(env, "getMe", {});
    return json({ ok: true, bot: "@" + me.username, chatSet: !!env.TELEGRAM_CHAT_ID });
  }

  if (url.pathname !== "/telegram/webhook" || req.method !== "POST") return new Response("Not found", { status: 404 });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== await hookSecret(env)) return new Response("Forbidden", { status: 403 });
  const u = await req.json<any>().catch(() => ({}));
  const editor = (chatId: unknown) => !!env.TELEGRAM_CHAT_ID && String(chatId) === String(env.TELEGRAM_CHAT_ID);

  if (u.message?.text?.startsWith("/start")) {
    const chat = u.message.chat.id;
    // Until the editor's chat is set, the bot only tells people their chat id; strangers get nothing after that
    if (!env.TELEGRAM_CHAT_ID) await tg(env, "sendMessage", { chat_id: chat, text: `This chat's id is ${chat}. Set it as the TELEGRAM_CHAT_ID secret to get TalkHalifax drafts here.` });
    else if (editor(chat)) await tg(env, "sendMessage", { chat_id: chat, text: "Connected. New TalkHalifax drafts will arrive here for your approval." });
    return json({ ok: true });
  }

  const cq = u.callback_query;
  if (cq) {
    const m = String(cq.data || "").match(/^(ap|dc):(\d+)$/);
    if (!m || !editor(cq.message?.chat?.id)) { await tg(env, "answerCallbackQuery", { callback_query_id: cq.id }); return json({ ok: true }); }
    const s = await env.DB.prepare("SELECT id, headline, stage FROM stories WHERE rowid = ?").bind(Number(m[2])).first<{ id: string; headline: string; stage: string }>();
    const approve = m[1] === "ap";
    const done = !!s && await reviewDraft(env, s.id, approve ? "approve" : "discard");
    const note = !s ? "That story no longer exists."
      : !done ? `Already handled: this story is ${s.stage === "draft" ? "a draft" : s.stage === "discarded" ? "discarded" : "published"}.`
      : approve ? `✅ Published: <a href="${SITE}/#article-${encodeURIComponent(s.id)}">${html(s.headline)}</a>` : `🗑 Discarded: ${html(s.headline)}`;
    await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: done ? (approve ? "Published" : "Discarded") : "Already handled" });
    await tg(env, "editMessageReplyMarkup", { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    await tg(env, "sendMessage", { chat_id: cq.message.chat.id, text: note, parse_mode: "HTML", reply_parameters: { message_id: cq.message.message_id } });
  }
  return json({ ok: true });
}
