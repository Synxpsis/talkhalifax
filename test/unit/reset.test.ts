import { describe, expect, it } from "vitest";
import { makeResetToken } from "../../src/auth";
import worker from "../../src/index";
import { env, makeUser } from "./helpers";

const ORIGIN = "https://talkhalifax.ca";
const check = (token: unknown, headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" }) =>
  worker.fetch!(new Request(`${ORIGIN}/auth/reset/check`, { method: "POST", headers, body: JSON.stringify({ token }) }) as never, env, {} as ExecutionContext);

describe("checking a password reset link", () => {
  it("names the account for a good token, without using it up", async () => {
    await makeUser("u_reset", { provider_sub: "nora" });
    const token = await makeResetToken(env, "u_reset", "u_mod");
    for (let i = 0; i < 2; i++) {
      const r = await check(token);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ username: "nora" });
    }
  });
  it("turns away a bad or missing token", async () => {
    expect((await check("nope")).status).toBe(410);
    expect((await check(undefined)).status).toBe(410);
  });
  it("refuses another site", async () => {
    expect((await check("nope", { origin: "https://example.test", "content-type": "application/json" })).status).toBe(403);
  });
  it("never takes the token in a URL, where the request logs would keep it", async () => {
    await makeUser("u_url", { provider_sub: "bo" });
    const token = await makeResetToken(env, "u_url", "u_mod");
    const r = await worker.fetch!(new Request(`${ORIGIN}/auth/reset?token=${token}`) as never, env, {} as ExecutionContext);
    expect(await r.text()).not.toContain("bo");
  });
});
