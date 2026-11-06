import { env as workerEnv } from "cloudflare:workers";
import { vi } from "vitest";
import type { Env, User } from "../../src/env";
import { saveStory } from "../../src/stories";

/** The test Worker's bindings: no Telegram (nothing is held for approval) and no Workers AI. */
export const env = workerEnv as unknown as Env;

export const HOUR = 36e5, DAY = 24 * HOUR;
export const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString().replace(/\.\d+Z$/, "Z");

/** The same bindings with the editor's Telegram set up, which turns approvals on. Telegram itself is stubbed. */
export function withTelegram(): Env {
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const to = String(url instanceof Request ? url.url : url);
    if (!to.includes("api.telegram.org")) throw new Error(`Unexpected request to ${to}`);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
  });
  return { ...env, TELEGRAM_BOT_TOKEN: "test", TELEGRAM_CHAT_ID: "1" } as Env;
}

export const storyInput = (over: Record<string, unknown> = {}) => ({
  kind: "article", section: "City Hall", area: "Halifax", headline: "A headline", dek: "A dek", facts: [], body: ["A sentence."], means: [],
  source: "https://www.halifax.ca/home/news/example", publishedAt: iso(), ...over,
});

/** A published story (made while approvals are off), with any columns set directly, for example to age it. */
export async function makeStory(id: string, over: Record<string, unknown> = {}, cols: Record<string, unknown> = {}) {
  await saveStory(env, id, storyInput(over), { mode: "create", author: "test" });
  const names = Object.keys(cols);
  if (names.length) await env.DB.prepare(`UPDATE stories SET ${names.map(n => `${n} = ?`).join(", ")} WHERE id = ?`).bind(...Object.values(cols), id).run();
}

export const storyRow = (id: string) => env.DB.prepare("SELECT * FROM stories WHERE id = ?").bind(id).first<Record<string, any>>();

export async function makeUser(id: string, over: Partial<User> & { provider_sub?: string } = {}): Promise<User> {
  const u = { id, name: id, avatar_url: "", email: "", role: "member", banned: 0, provider: "password", created_at: Date.now() - 30 * DAY, ...over } as User;
  await env.DB.prepare("INSERT INTO users (id, provider, provider_sub, name, role, banned, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(u.id, u.provider, over.provider_sub ?? id, u.name, u.role, u.banned, u.created_at).run();
  return u;
}
