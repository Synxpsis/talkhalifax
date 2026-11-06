import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { upsertUser } from "../../src/auth";
import worker from "../../src/index";
import { env, makeUser } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const signup = (username: string) => worker.fetch(new Request("https://site.test/auth/signup", {
  method: "POST", headers: { origin: "https://site.test", "content-type": "application/json", "cf-connecting-ip": "4.4.4.4" },
  body: JSON.stringify({ username, password: "long-enough-password" }),
}), env, ctx);
const google = (sub: string, email: string) => ({ provider: "google", sub, name: sub, avatar: "", email });
const role = async (id: string) => (await env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(id).first<{ role: string }>())!.role;

describe("who is a moderator", () => {
  it("a username in ADMIN_USERNAMES, and nobody else", async () => {
    expect((await signup("admin")).status).toBe(200);
    expect((await signup("reader")).status).toBe(200);
    const rows = await env.DB.prepare("SELECT name, role FROM users ORDER BY name").all();
    expect(rows.results).toEqual([{ name: "admin", role: "moderator" }, { name: "reader", role: "member" }]);
  });
  it("nobody by email when no list is set", async () => {
    expect(env.ADMIN_EMAILS).toBeUndefined();
    expect(await role(await upsertUser(env, google("a", "someone@example.com")))).toBe("member");
  });
  it("an email in the ADMIN_EMAILS secret, whatever its case", async () => {
    const e = { ...env, ADMIN_EMAILS: "Editor@Example.com, second@example.com" } as Env;
    expect(await role(await upsertUser(e, google("a", "editor@example.COM")))).toBe("moderator");
    expect(await role(await upsertUser(e, google("b", "other@example.com")))).toBe("member");
  });
  it("stays a moderator after the list changes", async () => {
    await makeUser("mod", { provider: "google", provider_sub: "m", role: "moderator" });
    expect(await role(await upsertUser(env, google("m", "gone@example.com")))).toBe("moderator");
  });
});
