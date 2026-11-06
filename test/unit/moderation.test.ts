import { describe, expect, it } from "vitest";
import { allow } from "../../src/auth";
import worker from "../../src/index";
import { deleteAccount, setBanned } from "../../src/moderation";
import { addComment } from "../../src/stories";
import { env, makeStory, makeUser } from "./helpers";

const limit = (k: string, n: number, w: number) => allow(env, k, n, w);
const comment = (u: Awaited<ReturnType<typeof makeUser>>, text = "A fair point", story = "s") =>
  addComment(new Request("https://site/x", { method: "POST", body: JSON.stringify({ text }) }), env, story, u, limit);
const archived = () => makeStory("s", {}, { stage: "archived" });

describe("bans", () => {
  it("stop someone commenting, and unbanning lets them back", async () => {
    await archived();
    const u = await makeUser("u1");
    expect((await setBanned(env, "u1", true, false)).status).toBe(200);
    expect((await env.DB.prepare("SELECT banned FROM users WHERE id = 'u1'").first<{ banned: number }>())!.banned).toBe(1);
    expect((await comment({ ...u, banned: 1 })).status).toBe(403);
    await setBanned(env, "u1", false, false);
    expect((await comment(u)).status).toBe(200);
  });
  it("can't touch moderators or the journalist", async () => {
    await makeUser("mod", { role: "moderator" });
    await makeUser("j", { provider: "newsroom", provider_sub: "journalist" });
    expect((await setBanned(env, "mod", true, false)).status).toBe(400);
    expect((await setBanned(env, "j", true, false)).status).toBe(400);
    expect((await setBanned(env, "nobody", true, false)).status).toBe(404);
  });
  it("with purge remove what they posted; without it leave it", async () => {
    await archived();
    const a = await makeUser("a"), b = await makeUser("b");
    await comment(a);
    await comment(b);
    await setBanned(env, "a", true, true);
    await setBanned(env, "b", true, false);
    const left = await env.DB.prepare("SELECT user_id, deleted FROM comments ORDER BY user_id").all<{ user_id: string; deleted: number }>();
    expect(left.results).toEqual([{ user_id: "a", deleted: 1 }, { user_id: "b", deleted: 0 }]);
  });
});

describe("comments", () => {
  it("are only for settled articles, and go through screening", async () => {
    const u = await makeUser("u1");
    await makeStory("live");
    expect((await comment(u, "Hello", "live")).status).toBe(409);
    await archived();
    expect((await comment(u, "call 902-555-1234")).status).toBe(422);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first<{ n: number }>())!.n).toBe(0);
  });
  it("are limited to 6 a minute", async () => {
    await archived();
    const u = await makeUser("u1");
    for (let i = 0; i < 6; i++) expect((await comment(u)).status).toBe(200);
    expect((await comment(u)).status).toBe(429);
  });
});

describe("deleting an account", () => {
  it("erases the words", async () => {
    await archived();
    const u = await makeUser("u1");
    await comment(u, "Something personal");
    expect((await deleteAccount(env, u)).status).toBe(200);
    expect(await env.DB.prepare("SELECT text, deleted FROM comments").first()).toEqual({ text: "", deleted: 1 });
    expect(await env.DB.prepare("SELECT name, provider, role FROM users WHERE id = 'u1'").first()).toEqual({ name: "Deleted account", provider: "deleted", role: "member" });
  });
  it("isn't open to the journalist", async () => {
    const j = await makeUser("j", { provider: "newsroom", provider_sub: "journalist" });
    expect((await deleteAccount(env, j)).status).toBe(400);
  });
});

describe("rate limits", () => {
  it("count per key up to the limit", async () => {
    for (let i = 0; i < 3; i++) expect(await allow(env, "k", 3, 60_000)).toBe(true);
    expect(await allow(env, "k", 3, 60_000)).toBe(false);
    expect(await allow(env, "other", 3, 60_000)).toBe(true);
  });
  it("start over once the window has passed", async () => {
    for (let i = 0; i < 2; i++) await allow(env, "k", 2, 60_000);
    expect(await allow(env, "k", 2, 60_000)).toBe(false);
    await env.DB.prepare("UPDATE auth_throttle SET window_start = ? WHERE key = 'k'").bind(Date.now() - 61_000).run();
    expect(await allow(env, "k", 2, 60_000)).toBe(true);
  });
  it("hold sign-up to 5 an hour per connection, and refuse other sites", async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const signup = (username: string, ip: string, origin = "https://site.test") => worker.fetch(new Request("https://site.test/auth/signup", {
      method: "POST", headers: { origin, "content-type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify({ username, password: "long-enough-password" }),
    }), env, ctx);
    expect((await signup("elsewhere", "1.1.1.1", "https://evil.test")).status).toBe(403);
    for (let i = 0; i < 5; i++) expect((await signup(`reader${i}`, "1.1.1.1")).status).toBe(200);
    expect((await signup("reader5", "1.1.1.1")).status).toBe(429);
    expect((await signup("reader6", "2.2.2.2")).status).toBe(200);
  });
});
