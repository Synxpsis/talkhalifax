import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/index";
import { cleanReport } from "../../src/stats";
import { env, makeStory } from "./helpers";

const SID = "a".repeat(24), ORIGIN = "https://talkhalifax.ca";
const post = (body: unknown, headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" }) =>
  worker.fetch!(new Request(`${ORIGIN}/api/stats`, { method: "POST", headers, body: JSON.stringify(body) }) as never, env, {} as ExecutionContext);
const hub = () => env.STATS.get(env.STATS.idFromName("site"));
// The hub's private state, with the plugin's deep generics out of the way
const inHub = runInDurableObject as unknown as (stub: unknown, fn: (h: any) => unknown) => Promise<any>;
// A story write is due whenever a test flushes, unless it says otherwise
const flush = async () => { await inHub(hub(), (h: any) => { h.lastStoryWriteAt = 0; }); return runDurableObjectAlarm(hub()); };
const traffic = (id: string) => env.DB.prepare("SELECT SUM(impressions) AS i, SUM(clicks) AS c FROM story_traffic WHERE story_id = ?").bind(id).first<{ i: number | null; c: number | null }>();
const lastSample = () => env.DB.prepare("SELECT online FROM online_samples ORDER BY at DESC LIMIT 1").first<{ online: number }>();

describe("what a page may report", () => {
  it("needs a well-formed random id", () => {
    expect(cleanReport({ sid: "short", shown: [] })).toBeNull();
    expect(cleanReport({ sid: "u_someones_user_id_here", shown: [] })).toBeNull();
    expect(cleanReport(null)).toBeNull();
  });
  it("drops odd story ids and duplicates, and caps how many", () => {
    const r = cleanReport({ sid: SID, shown: ["ok-1", "ok-1", "<script>", 7], opened: Array.from({ length: 50 }, (_, i) => `s${i}`) })!;
    expect(r.shown).toEqual(["ok-1"]);
    expect(r.opened).toHaveLength(10);
  });
  it("keeps nothing but the id and the story ids", () => {
    expect(Object.keys(cleanReport({ sid: SID, shown: [], email: "x@example.test" })!).sort()).toEqual(["opened", "shown", "sid"]);
  });
});

describe("the stats route", () => {
  it("refuses other sites and non-JSON", async () => {
    expect((await post({ sid: SID }, { origin: "https://example.test", "content-type": "application/json" })).status).toBe(400);
    expect((await post({ sid: SID }, { origin: ORIGIN, "content-type": "text/plain" })).status).toBe(400);
  });
  it("refuses a report without a valid id", async () => {
    expect((await post({ sid: "nope" })).status).toBe(400);
  });
  it("adds up shown and opened stories, per story, and writes them when the hub flushes", async () => {
    await makeStory("st-a");
    await flush();
    expect((await post({ sid: SID, shown: ["st-a"], opened: ["st-a"] })).status).toBe(204);
    expect((await post({ sid: "b".repeat(24), shown: ["st-a"], opened: [] })).status).toBe(204);
    expect(await traffic("st-a")).toEqual({ i: null, c: null });
    await flush();
    expect(await traffic("st-a")).toEqual({ i: 2, c: 1 });
  });
  it("adds to the same hour's row on later flushes", async () => {
    await makeStory("st-b");
    await post({ sid: SID, shown: ["st-b"] });
    await flush();
    await post({ sid: SID, shown: ["st-b"] });
    await flush();
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(impressions) AS i FROM story_traffic WHERE story_id = 'st-b'").first<{ n: number; i: number }>();
    expect(rows?.i).toBe(2);
    expect(rows!.n).toBeLessThanOrEqual(2);
  });
  it("ignores a story that doesn't exist, so readers can't fill the table with made-up ids", async () => {
    await post({ sid: SID, shown: ["no-such-story"] });
    await flush();
    expect(await traffic("no-such-story")).toEqual({ i: null, c: null });
  });
  it("counts each open page once however often it reports, and forgets pages that stop", async () => {
    await inHub(hub(), (h: any) => { h.pages.clear(); h.lastSampleAt = 0; });
    await post({ sid: "c".repeat(24) });
    await post({ sid: "c".repeat(24) });
    await post({ sid: "d".repeat(24) });
    await flush();
    expect((await lastSample())?.online).toBe(2);
    // Every page has gone quiet for over 5 minutes: the chart falls to zero and the ids are gone from memory
    await inHub(hub(), (h: any) => { for (const k of h.pages.keys()) h.pages.set(k, Date.now() - 301_000); });
    await inHub(hub(), async (h: any): Promise<void> => { await h.flush(Date.now()); });
    expect((await lastSample())?.online).toBe(0);
    const left: number = await inHub(hub(), (h: any): number => h.pages.size);
    expect(left).toBe(0);
  });
  it("refuses an oversized body even when it doesn't declare its length", async () => {
    const chunked = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"sid":"${SID}","x":"${"y".repeat(20_000)}"}`)); c.close(); } });
    const r = new Request(`${ORIGIN}/api/stats`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: chunked });
    expect(r.headers.get("content-length")).toBeNull();
    expect((await worker.fetch!(r as never, env, {} as ExecutionContext)).status).toBe(413);
  });
  it("quietly drops reports past the rate limit, keyed by address", async () => {
    await makeStory("st-limit");
    await flush();
    const keys: string[] = [];
    const limited = { ...env, STATS_LIMIT: { limit: async (o: { key: string }) => { keys.push(o.key); return { success: false }; } } };
    const r = new Request(`${ORIGIN}/api/stats`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ sid: SID, shown: ["st-limit"] }) });
    expect((await worker.fetch!(r as never, limited, {} as ExecutionContext)).status).toBe(204);
    expect(keys).toEqual(["203.0.113.9"]);
    await flush();
    expect(await traffic("st-limit")).toEqual({ i: null, c: null });
  });
  it("writes story counts every 10 minutes rather than every minute, while pages are open", async () => {
    await makeStory("st-slow");
    await post({ sid: SID, shown: ["st-slow"] });
    await flush();
    await post({ sid: SID, shown: ["st-slow"] });
    expect(await runDurableObjectAlarm(hub())).toBe(true);
    expect((await traffic("st-slow"))?.i).toBe(1);
    await flush();
    expect((await traffic("st-slow"))?.i).toBe(2);
  });
  it("writes at once when the last page has gone, so nothing waits on an empty site", async () => {
    await makeStory("st-last");
    await inHub(hub(), (h: any) => { h.lastStoryWriteAt = Date.now(); h.pages.clear(); h.counts.set("st-last", { shown: 3, opened: 1 }); });
    await inHub(hub(), async (h: any): Promise<void> => { await h.flush(Date.now()); });
    expect(await traffic("st-last")).toEqual({ i: 3, c: 1 });
  });
  it("doesn't count a draft, which readers can't see", async () => {
    await makeStory("st-draft", {}, { stage: "draft" });
    await post({ sid: SID, shown: ["st-draft"] });
    await flush();
    expect(await traffic("st-draft")).toEqual({ i: null, c: null });
  });
  it("stops taking new story ids at its cap, and writes them in one statement", async () => {
    await makeStory("st-real");
    await inHub(hub(), (h: any) => { h.counts.clear(); for (let i = 0; i < 2_000; i++) h.counts.set(`made-up-${i}`, { shown: 1, opened: 0 }); });
    await post({ sid: SID, shown: ["another-made-up"] });
    expect(await inHub(hub(), (h: any): number => h.counts.size)).toBe(2_000);
    await inHub(hub(), (h: any) => { h.counts.set("st-real", { shown: 1, opened: 0 }); });
    await flush();
    expect(await traffic("st-real")).toEqual({ i: 1, c: 0 });
    expect(await traffic("made-up-1")).toEqual({ i: null, c: null });
  });
  it("keeps the online chart going when story counts can't be written, and keeps the counts", async () => {
    await inHub(hub(), async (h: any): Promise<void> => {
      h.lastSampleAt = 0; h.lastStoryWriteAt = 0; h.counts.clear(); h.counts.set("st-keep", { shown: 2, opened: 0 });
      const realEnv = h.env, real = realEnv.DB.prepare.bind(realEnv.DB);
      h.env = { ...realEnv, DB: { prepare: (sql: string) => { if (sql.includes("story_traffic")) throw new Error("D1 is down"); return real(sql); } } };
      try {
        await expect(h.flush(Date.now())).rejects.toThrow("D1 is down");
        expect(h.lastSampleAt).toBeGreaterThan(0);
        expect(h.counts.get("st-keep")).toEqual({ shown: 2, opened: 0 });
      } finally {
        h.counts.clear();
        h.env = realEnv;
      }
    });
  });
  it("saves nothing that identifies a page: only totals reach the database", async () => {
    await makeStory("st-c");
    await post({ sid: SID, shown: ["st-c"] });
    await flush();
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM story_traffic").all()).results,
      (await env.DB.prepare("SELECT * FROM online_samples").all()).results,
    ]);
    expect(dump).not.toContain(SID);
  });
});
