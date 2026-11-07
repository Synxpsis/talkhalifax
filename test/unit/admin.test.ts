import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetKeys, validAccessToken } from "../../admin/src/access";
import { AdminEnv, buckets, handle, screenOf } from "../../admin/src/index";
import { DAY, env, HOUR, iso, makeStory, makeUser } from "./helpers";

const TEAM = "team.cloudflareaccess.com", AUD = "aud-1", NOW = Date.UTC(2026, 10, 7, 12);
const SECONDS = NOW / 1000;
const b64 = (data: string | ArrayBuffer) => btoa(typeof data === "string" ? data : String.fromCharCode(...new Uint8Array(data))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let keys: CryptoKeyPair, otherKeys: CryptoKeyPair, jwk: JsonWebKey;
const newKeys = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;

async function token(claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; alg?: string; kid?: string } = {}) {
  const head = b64(JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" }));
  const body = b64(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: SECONDS + 3600, nbf: SECONDS - 60, ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", opts.key ?? keys.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64(sig)}`;
}

const assets = { fetch: async () => new Response("<!doctype html>the page", { headers: { "content-type": "text/html" } }) } as unknown as Fetcher;
const configured = (): AdminEnv => ({ DB: env.DB, ASSETS: assets, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD });
const req = (path: string, init: RequestInit = {}, host = "https://admin.talkhalifax.ca") => new Request(host + path, init);
const asDev = (path: string) => handle(req(path, {}, "http://localhost:8790"), { DB: env.DB, ASSETS: assets, ADMIN_DEV: "1" }, NOW);
const data = async <T = any>(path: string) => (await asDev(path)).json() as Promise<T>;

beforeAll(async () => {
  keys = await newKeys();
  otherKeys = await newKeys();
  jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey) as JsonWebKey), kid: "k1" } as JsonWebKey;
});
beforeEach(() => {
  forgetKeys();
  vi.stubGlobal("fetch", async (url: string) => {
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error(`Unexpected request to ${url}`);
    return Response.json({ keys: [jwk] });
  });
});

describe("the admin site's front door", () => {
  it("refuses everyone when Access isn't configured, pages and data alike", async () => {
    const bare: AdminEnv = { DB: env.DB, ASSETS: assets };
    for (const path of ["/", "/admin.js", "/api/users"]) expect((await handle(req(path), bare, NOW)).status).toBe(503);
    expect((await handle(req("/"), { ...bare, ACCESS_TEAM_DOMAIN: TEAM }, NOW)).status).toBe(503);
  });
  it("refuses a request with no token, including the page itself", async () => {
    for (const path of ["/", "/admin.js", "/api/users", "/api/summary"]) expect((await handle(req(path), configured(), NOW)).status).toBe(403);
  });
  it("lets through a token Access signed for this application", async () => {
    const r = await handle(req("/", { headers: { "cf-access-jwt-assertion": await token() } }), configured(), NOW);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("the page");
  });
  it("refuses a token signed by anyone else", async () => {
    const t = await token({}, { key: otherKeys.privateKey });
    expect((await handle(req("/", { headers: { "cf-access-jwt-assertion": t } }), configured(), NOW)).status).toBe(403);
  });
  it("refuses a token for another application, from another team, or out of date", async () => {
    expect(await validAccessToken(await token({ aud: ["someone-else"] }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({ iss: "https://evil.cloudflareaccess.com" }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({ exp: SECONDS - 3600 }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({ nbf: SECONDS + 3600 }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({ exp: undefined }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token(), TEAM, AUD, NOW)).toBe(true);
  });
  it("refuses a token that picks its own algorithm, or that's nonsense", async () => {
    expect(await validAccessToken(await token({}, { alg: "none" }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken(await token({}, { alg: "HS256" }), TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken("not.a.token", TEAM, AUD, NOW)).toBe(false);
    expect(await validAccessToken("", TEAM, AUD, NOW)).toBe(false);
  });
  it("refuses a tampered token", async () => {
    const [h, , s] = (await token()).split(".");
    const forged = b64(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: SECONDS + 9999 }));
    expect(await validAccessToken(`${h}.${forged}.${s}`, TEAM, AUD, NOW)).toBe(false);
  });
  it("refuses when Access's keys can't be fetched", async () => {
    vi.stubGlobal("fetch", async () => new Response("down", { status: 500 }));
    expect(await validAccessToken(await token(), TEAM, AUD, NOW)).toBe(false);
  });
  it("refuses everyone if the team address isn't an Access team's own", async () => {
    for (const team of ["evil.test", "evil.test/x?", `https://${TEAM}`, `${TEAM}/`, `${TEAM}.evil.test`, "TEAM.cloudflareaccess.com"]) {
      const t = await token();
      expect((await handle(req("/", { headers: { "cf-access-jwt-assertion": t } }), { ...configured(), ACCESS_TEAM_DOMAIN: team }, NOW)).status).toBe(503);
    }
  });
  it("doesn't follow redirects when fetching Access's keys", async () => {
    const seen: (RequestInit | undefined)[] = [];
    vi.stubGlobal("fetch", async (_: string, init?: RequestInit) => { seen.push(init); return Response.json({ keys: [jwk] }); });
    await validAccessToken(await token(), TEAM, AUD, NOW);
    expect(seen[0]?.redirect).toBe("error");
  });
  it("picks up a rotated key, but bad tokens can't force a key fetch on every request", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", async () => { fetches++; return Response.json({ keys: [jwk] }); });
    const unknown = await token({}, { kid: "nobody" });
    await validAccessToken(unknown, TEAM, AUD, NOW);
    expect(fetches).toBe(1);
    for (let i = 0; i < 5; i++) expect(await validAccessToken(unknown, TEAM, AUD, NOW + i)).toBe(false);
    expect(fetches).toBe(1);
    await validAccessToken(unknown, TEAM, AUD, NOW + 61_000);
    expect(fetches).toBe(2);
  });
  it("keeps the good keys if a refresh comes back empty", async () => {
    expect(await validAccessToken(await token(), TEAM, AUD, NOW)).toBe(true);
    vi.stubGlobal("fetch", async () => Response.json({ keys: [] }));
    expect(await validAccessToken(await token({}, { kid: "nobody" }), TEAM, AUD, NOW + 61_000)).toBe(false);
    expect(await validAccessToken(await token(), TEAM, AUD, NOW + 62_000)).toBe(true);
  });
  it("only skips the check for a local run, never on the real address", async () => {
    const dev: AdminEnv = { DB: env.DB, ASSETS: assets, ADMIN_DEV: "1" };
    expect((await handle(req("/", {}, "http://localhost:8790"), dev, NOW)).status).toBe(200);
    expect((await handle(req("/", {}, "https://admin.talkhalifax.ca"), dev, NOW)).status).toBe(503);
  });
  it("is read-only in stage 1", async () => {
    const t = await token();
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect((await handle(req("/api/users", { method, headers: { "cf-access-jwt-assertion": t } }), configured(), NOW)).status).toBe(405);
  });
  it("sends its security headers, on refusals too", async () => {
    for (const r of [await handle(req("/"), configured(), NOW), await asDev("/")]) {
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(r.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("what the admin site shows", () => {
  it("never returns email addresses, password hashes, personas or Google ids", async () => {
    await makeUser("u_pw", { provider_sub: "nora", name: "Nora" });
    await makeUser("u_goog", { provider: "google", provider_sub: "google-sub-123", name: "Gia" });
    await env.DB.prepare("UPDATE users SET email = 'private@example.test', password_hash = 'hash-value', persona = 'secret persona'").run();
    const body = JSON.stringify(await data("/api/users"));
    for (const hidden of ["private@example.test", "hash-value", "secret persona", "google-sub-123"]) expect(body).not.toContain(hidden);
    expect(body).toContain("nora");
  });
  it("searches names and usernames, treating wildcards as plain text", async () => {
    await makeUser("u_a", { provider_sub: "harbour", name: "Ann" });
    await makeUser("u_b", { provider_sub: "bedford", name: "Bo" });
    expect((await data("/api/users?q=harb")).users.map((u: any) => u.id)).toEqual(["u_a"]);
    expect((await data("/api/users?q=%25")).users).toEqual([]);
  });
  it("won't find a Google account by its Google id", async () => {
    await makeUser("u_g", { provider: "google", provider_sub: "secret-google-id", name: "Gia" });
    expect((await data("/api/users?q=secret-google")).users).toEqual([]);
  });
  it("filters by role and by ban, and shows what each person posted", async () => {
    await makeUser("u_m", { role: "moderator" });
    await makeUser("u_x", { banned: 1 });
    await makeUser("u_n");
    await env.DB.prepare("INSERT INTO message_index (id, story_id, user_id, text, created_at) VALUES ('m1', 's', 'u_n', 'hi', ?)").bind(NOW).run();
    expect((await data("/api/users?role=moderator")).users.map((u: any) => u.id)).toEqual(["u_m"]);
    expect((await data("/api/users?role=banned")).users.map((u: any) => u.id)).toEqual(["u_x"]);
    expect((await data("/api/users")).users.find((u: any) => u.id === "u_n").messages).toBe(1);
  });
  it("puts each story on the screen readers see it on", () => {
    expect(screenOf("article", "developing")).toBe("Developing");
    expect(screenOf("article", "archived")).toBe("Articles");
    expect(screenOf("notice", "developing")).toBe("Notices");
  });
  it("lists stories and upcoming events, not discarded ones, and links only what's public", async () => {
    await makeStory("c-dev", { headline: "Developing one" });
    await makeStory("c-arch", { headline: "Archived one" }, { stage: "archived" });
    await makeStory("c-draft", { headline: "Draft one" }, { stage: "draft" });
    await makeStory("c-gone", { headline: "Discarded one" }, { stage: "discarded" });
    const soon = new Date(NOW + DAY).toISOString(), past = new Date(NOW - DAY).toISOString();
    await env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('events', ?, ?)").bind(JSON.stringify({ events: [
      { id: "e1", title: "Story time", url: "https://example.test/e1", start: soon, end: soon },
      { id: "e2", title: "Finished event", url: "https://example.test/e2", start: past, end: past },
    ] }), iso()).run();
    const { items } = await data("/api/content");
    const titles = items.map((i: any) => i.title);
    expect(titles).toEqual(expect.arrayContaining(["Developing one", "Archived one", "Draft one", "Story time"]));
    expect(titles).not.toContain("Discarded one");
    expect(titles).not.toContain("Finished event");
    expect(items.find((i: any) => i.title === "Draft one").url).toBeNull();
    expect(items.find((i: any) => i.title === "Draft one").status).toBe("waiting");
    expect((await data("/api/content?screen=Events")).items.map((i: any) => i.title)).toEqual(["Story time"]);
    expect((await data("/api/content?status=archived")).items.map((i: any) => i.title)).toEqual(["Archived one"]);
  });
  it("adds up each story's clicks and impressions from the last 30 days", async () => {
    await makeStory("c-t", { headline: "Counted" });
    const hour = Math.floor(NOW / HOUR);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO story_traffic (hour, story_id, impressions, clicks) VALUES (?, 'c-t', 5, 2)").bind(hour),
      env.DB.prepare("INSERT INTO story_traffic (hour, story_id, impressions, clicks) VALUES (?, 'c-t', 3, 1)").bind(hour - 1),
      env.DB.prepare("INSERT INTO story_traffic (hour, story_id, impressions, clicks) VALUES (?, 'c-t', 100, 100)").bind(hour - 31 * 24),
    ]);
    const item = (await data("/api/content")).items.find((i: any) => i.id === "c-t");
    expect([item.impressions, item.clicks]).toEqual([8, 3]);
  });
  it("reports a job failing from the cron's own record, and a stopped cron as late", async () => {
    await env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('cron-health', ?, ?)").bind(JSON.stringify({ weather: 3, stages: 0 }), new Date(NOW - 10 * 60_000).toISOString()).run();
    const jobs = (await data("/api/jobs")).jobs;
    expect(jobs.find((j: any) => j.name === "Weather")).toMatchObject({ state: "failing", failures: 3 });
    expect(jobs.find((j: any) => j.name === "Stages").state).toBe("ok");
    await env.DB.prepare("UPDATE feeds SET updated_at = ? WHERE name = 'cron-health'").bind(new Date(NOW - 2 * HOUR).toISOString()).run();
    expect((await data("/api/jobs")).jobs.find((j: any) => j.name === "Stages").state).toBe("late");
  });
});

describe("the charts", () => {
  it("makes 24 hourly buckets ending now, labelled in Halifax time", () => {
    const b = buckets("24h", NOW);
    expect(b.labels).toHaveLength(24);
    expect(b.labels[23]).toBe("8 am"); // noon UTC is 8 a.m. in Halifax (AST) on Nov. 7
  });
  it("makes Halifax days, with today last", () => {
    const b = buckets("7d", NOW);
    expect(b.labels).toHaveLength(7);
    expect(b.labels[6]).toBe("Nov. 7");
    expect(b.labels[0]).toBe("Nov. 1");
  });
  it("gets through the day the clocks change", () => {
    const fallBack = Date.UTC(2026, 10, 2, 12); // the day after clocks went back on Nov. 1, 2026
    const b = buckets("7d", fallBack);
    expect(b.labels).toHaveLength(7);
    expect(new Set(b.labels).size).toBe(7);
  });
  it("adds up sign-ups and messages, and takes the peak for people online", async () => {
    await makeUser("u_new", { created_at: NOW - HOUR });
    await makeUser("u_old", { created_at: NOW - 40 * DAY });
    await makeUser("u_ai", { provider: "newsroom", created_at: NOW - HOUR });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO message_index (id, story_id, user_id, text, created_at) VALUES ('m1', 's', 'u', 'a', ?)").bind(NOW - HOUR),
      env.DB.prepare("INSERT INTO message_index (id, story_id, user_id, text, created_at, deleted) VALUES ('m2', 's', 'u', 'b', ?, 1)").bind(NOW - HOUR),
      env.DB.prepare("INSERT INTO online_samples (at, online) VALUES (?, 4)").bind(NOW - HOUR),
      env.DB.prepare("INSERT INTO online_samples (at, online) VALUES (?, 9)").bind(NOW - HOUR + 5 * 60_000),
      env.DB.prepare("INSERT INTO online_samples (at, online) VALUES (?, 6)").bind(NOW - 60_000),
    ]);
    const o = await data("/api/overview?range=24h");
    const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
    expect(sum(o.series.signups)).toBe(1);
    expect(sum(o.series.messages)).toBe(1);
    expect(Math.max(...o.series.online)).toBe(9);
    expect(o.onlineNow).toBe(6);
    expect(o.labels).toHaveLength(24);
  });
  it("leaves deleted accounts out of sign-ups, member counts and the list", async () => {
    await makeUser("u_here", { created_at: NOW - HOUR });
    await makeUser("u_gone", { provider: "deleted", created_at: NOW - HOUR });
    const o = await data("/api/overview?range=24h");
    expect(o.series.signups.reduce((x: number, y: number) => x + y, 0)).toBe(1);
    expect((await data("/api/summary")).members).toBe(1);
    const list = await data("/api/users");
    expect(list.users.map((u: any) => u.id)).toEqual(["u_here"]);
    expect(list.total).toBe(1);
  });
  it("says nobody is online when the newest sample is old", async () => {
    await env.DB.prepare("INSERT INTO online_samples (at, online) VALUES (?, 12)").bind(NOW - HOUR).run();
    expect((await data("/api/overview")).onlineNow).toBe(0);
  });
  it("falls back to 7 days for an unknown range", async () => {
    expect((await data("/api/overview?range=forever")).range).toBe("7d");
  });
});
