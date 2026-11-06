import { describe, expect, it } from "vitest";
import { SITE } from "../../src/env";
import worker from "../../src/index";
import { env } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const OLD = "https://talkhalifax.alexwmmolloy.workers.dev";
const get = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, { redirect: "manual", ...init }), env, ctx);
const browser = { headers: { "sec-fetch-mode": "navigate" } };

describe("the site's address", () => {
  it("is talkhalifax.ca", () => expect(SITE).toBe("https://talkhalifax.ca"));
  it("serves pages and APIs on talkhalifax.ca without redirecting", async () => {
    expect((await get(`${SITE}/`, browser)).status).toBe(200);
    expect((await get(`${SITE}/api/stories`)).status).toBe(200);
  });
  it.each(["https://talkhalifax.com", "https://www.talkhalifax.com", "https://talkhalifax.org", "https://www.talkhalifax.org", "https://www.talkhalifax.ca"])(
    "sends %s there for good, keeping the path", async host => {
      const r = await get(`${host}/some/page?x=1`);
      expect(r.status).toBe(301);
      expect(r.headers.get("location")).toBe(`${SITE}/some/page?x=1`);
    });
  it("sends browsers on the old address there", async () => {
    const r = await get(`${OLD}/`, browser);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(`${SITE}/`);
  });
  it("keeps the old address working for the agents and the Telegram webhook", async () => {
    expect((await get(`${OLD}/`)).status).toBe(200);
    expect((await get(`${OLD}/api/stories`)).status).toBe(200);
    expect((await get(`${OLD}/api/stories`, browser)).status).toBe(200);
    expect((await get(`${OLD}/mcp`, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await get(`${OLD}/telegram/webhook`, { method: "POST", body: "{}" })).status).not.toBe(302);
  });
  it("doesn't redirect what isn't a read, or other hosts", async () => {
    expect((await get("https://talkhalifax.com/api/events/ingest", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await get("http://localhost:8787/", browser)).status).toBe(200);
    expect((await get("https://evil.example/", browser)).status).toBe(200);
  });
});
