import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { env, makeStory } from "./helpers";

const ORIGIN = "https://talkhalifax.ca";
const get = (url: string, init?: RequestInit) => worker.fetch!(new Request(url, init) as never, env, {} as ExecutionContext);

function expectSecured(r: Response) {
  expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  expect(r.headers.get("permissions-policy")).toBe("geolocation=(self), camera=(), microphone=()");
  expect(r.headers.get("content-security-policy-report-only")).toContain("frame-ancestors 'none'");
}

describe("security headers", () => {
  it("are on the page, the data, errors and refusals", async () => {
    for (const path of ["/", "/app.js", "/api/stories", "/auth/nothing-here", "/no-such-file"]) expectSecured(await get(ORIGIN + path));
    expectSecured(await get(`${ORIGIN}/api/stats`, { method: "POST", body: "{}" }));
  });
  it("are on redirects, which still redirect", async () => {
    const r = await get("https://talkhalifax.com/some/page");
    expect(r.status).toBe(301);
    expect(r.headers.get("location")).toBe(`${ORIGIN}/some/page`);
    expectSecured(r);
  });
  it("keep what the response already had", async () => {
    const r = await get(`${ORIGIN}/api/stories`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect((await r.json() as { stories: unknown[] }).stories).toBeInstanceOf(Array);
  });
  it("only report on the content policy for now, and leave HSTS to the zone", async () => {
    const r = await get(`${ORIGIN}/`);
    expect(r.headers.get("content-security-policy")).toBeNull();
    expect(r.headers.get("strict-transport-security")).toBeNull();
  });
  it("leave a chat's WebSocket upgrade untouched", async () => {
    await makeStory("hdr-room");
    const r = await get(`${ORIGIN}/rooms/hdr-room/ws`, { headers: { upgrade: "websocket" } });
    expect(r.status).toBe(101);
    expect(r.webSocket).toBeTruthy();
    expect(r.headers.get("x-frame-options")).toBeNull();
    r.webSocket!.accept();
    r.webSocket!.close();
  });
});
