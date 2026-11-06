import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { screen } from "../../src/screen";
import { DAY, env } from "./helpers";

const old = { created_at: Date.now() - 30 * DAY }, fresh = { created_at: Date.now() - 3600_000 };
const withAI = (run: () => Promise<unknown>) => ({ ...env, AI: { run } }) as unknown as Env;

describe("fixed rules", () => {
  it.each(["what a retard", "R3T@RD"])("turn away the slur in %j", async t => {
    expect(await screen(env, t, old)).toMatch(/slur/);
  });
  it.each(["call 902-555-1234", "(902) 555 1234", "+1 902.555.1234"])("turn away the phone number in %j", async t => {
    expect(await screen(env, t, old)).toMatch(/phone numbers/);
  });
  it("turn away email addresses", async () => {
    expect(await screen(env, "write me at someone@example.com", old)).toMatch(/email addresses/);
  });
  it.each(["see https://example.com", "www.example.com", "example.ca has it"])("hold back the link in %j from a new account only", async t => {
    expect(await screen(env, t, fresh)).toMatch(/new accounts/);
    expect(await screen(env, t, old)).toBeNull();
  });
  it.each(["The spicy fries at the squawking gulls' pier", "2,000 customers out since 9:30", "Bus 1 at 7 a.m. on 902 Barrington", "Is the bridge open?"])(
    "let ordinary talk through: %j", async t => { expect(await screen(env, t, fresh)).toBeNull(); });
});

describe("Llama Guard", () => {
  it("blocks the categories we block, in either answer format", async () => {
    expect(await screen(withAI(async () => ({ response: "unsafe\nS10" })), "words", old)).toMatch(/hate/);
    expect(await screen(withAI(async () => ({ response: { safe: false, categories: ["S1"] } })), "words", old)).toMatch(/threats/);
  });
  it("lets through safe answers and categories that misfire on the news", async () => {
    expect(await screen(withAI(async () => ({ response: "safe" })), "words", old)).toBeNull();
    expect(await screen(withAI(async () => ({ response: "unsafe\nS5" })), "words", old)).toBeNull();
  });
  it("treats a non-violent crime as a threat only when it's aimed at someone", async () => {
    const s2 = withAI(async () => ({ response: "unsafe\nS2" }));
    expect(await screen(s2, "I'll burn your house down", old)).toMatch(/threats/);
    expect(await screen(s2, "Police say the house was burned down", old)).toBeNull();
  });
  it("never stalls chat: a broken or slow model lets the message through", async () => {
    expect(await screen(withAI(async () => { throw new Error("down"); }), "words", old)).toBeNull();
    expect(await screen(withAI(() => new Promise(() => {})), "words", old)).toBeNull();
  }, 8000);
  it("isn't asked about what the rules already turned away", async () => {
    let asked = false;
    await screen(withAI(async () => { asked = true; return { response: "safe" }; }), "call 902-555-1234", old);
    expect(asked).toBe(false);
  });
});
