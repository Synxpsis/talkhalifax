import { describe, expect, it, vi } from "vitest";
import type { Env } from "../../src/env";
import worker from "../../src/index";
import { env } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const on = { ...env, TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET: "secret-key" } as Env;
const signup = (e: Env, username: string, turnstile?: string) => worker.fetch(new Request("https://site.test/auth/signup", {
  method: "POST", headers: { origin: "https://site.test", "content-type": "application/json", "cf-connecting-ip": "3.3.3.3" },
  body: JSON.stringify({ username, password: "long-enough-password", turnstile }),
}), e, ctx);
const providers = async (e: Env) => (await (await worker.fetch(new Request("https://site.test/api/me"), e, ctx)).json<{ providers: { turnstile: string | null } }>()).providers;

/** Cloudflare's check answers as given, and records what it was sent. */
function stubVerify(success: boolean | Error) {
  const sent: URLSearchParams[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toContain("challenges.cloudflare.com/turnstile/v0/siteverify");
    if (success instanceof Error) throw success;
    sent.push(init!.body as URLSearchParams);
    return new Response(JSON.stringify({ success }));
  });
  return sent;
}

describe("Turnstile on sign-up", () => {
  it("is off until both keys are set", async () => {
    expect((await providers(env)).turnstile).toBeNull();
    expect((await providers({ ...env, TURNSTILE_SITE_KEY: "site-key" } as Env)).turnstile).toBeNull();
    expect((await signup(env, "noturnstile")).status).toBe(200);
  });
  it("gives the page only the public site key", async () => {
    const p = await providers(on);
    expect(p.turnstile).toBe("site-key");
    expect(JSON.stringify(p)).not.toContain("secret-key");
  });
  it("lets through a token Cloudflare accepts, sending it with the secret and the reader's address", async () => {
    const sent = stubVerify(true);
    expect((await signup(on, "person", "good-token")).status).toBe(200);
    expect(sent[0].get("response")).toBe("good-token");
    expect(sent[0].get("secret")).toBe("secret-key");
    expect(sent[0].get("remoteip")).toBe("3.3.3.3");
  });
  it("turns away a missing or rejected token, and makes no account", async () => {
    stubVerify(false);
    expect((await signup(on, "notoken")).status).not.toBe(200);
    expect((await signup(on, "badtoken", "bad-token")).status).not.toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n).toBe(0);
  });
  it("fails closed when Cloudflare's check can't be reached", async () => {
    stubVerify(new Error("network down"));
    expect((await signup(on, "nocheck", "good-token")).status).not.toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n).toBe(0);
  });
});
