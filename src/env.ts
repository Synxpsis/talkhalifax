export interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace;
  /** One StatsHub: anonymous counts of who has the site open and which stories are shown and opened. */
  STATS: DurableObjectNamespace;
  /** Caps anonymous count reports per IP address. If it's missing, reports aren't capped. */
  STATS_LIMIT?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  ASSETS: Fetcher;
  /** Comma-separated Google emails that get the moderator role. A secret, because the repo is public. */
  ADMIN_EMAILS?: string;
  /** Comma-separated usernames that get the moderator role. */
  ADMIN_USERNAMES: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Bearer token the newsroom (Claude) uses to publish and update stories. A secret. */
  NEWSROOM_TOKEN?: string;
  /** Bearer token the GitHub Action uses to post library events (scripts/events-token.mjs sets it). A secret. */
  EVENTS_TOKEN?: string;
  /** GitHub token (fine-grained, this repo, Actions read and write) the cron uses to start the Events and Transit jobs. A secret. */
  GITHUB_ACTIONS_TOKEN?: string;
  /** Telegram bot (@BotFather) that sends the editor new drafts to approve. A secret. */
  TELEGRAM_BOT_TOKEN?: string;
  /** The editor's Telegram chat id; the bot replies with it on /start. With the token set, new articles need approval. */
  TELEGRAM_CHAT_ID?: string;
  /** Workers AI, for screening chat messages and comments (Llama Guard). */
  AI?: Ai;
  /** Cloudflare Turnstile on sign-up. The site key is public (a var); the secret is a secret. Both set turns it on. */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Web Push (VAPID) keys, base64url, for alerts on urgent notices. Both secrets; `node scripts/vapid-keys.mjs` sets them. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  /** "1" enables the localhost-only dev sign-in. Set in .dev.vars, never in production. */
  DEV_LOGIN?: string;
}

export interface User {
  id: string;
  name: string;
  avatar_url: string;
  email: string;
  role: "member" | "moderator";
  banned: number;
  provider: string;
  created_at: number;
}

/** The site's public address. Links in alerts and Telegram use it, and other addresses redirect to it. */
export const SITE = "https://talkhalifax.ca";

export const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...(init.headers || {}) },
  });

export const randomId = (prefix: string, bytes = 16) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
};
