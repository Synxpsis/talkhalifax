// Anonymous counts for the admin site: how many people have the site open, and how often each story is shown and opened.
// Open pages report to one StatsHub about every 2 minutes. It holds the totals in memory and writes story counts to D1
// in one statement every 10 minutes, so a busy site costs a few writes per story per hour rather than one per reader.
// The hub wakes each minute while anything is waiting: that also keeps its memory from being cleared between reports.
//
// Privacy: a page's report carries a random id made when the page loads and thrown away when it closes. The id lives
// only in the hub's memory, for at most about 6 minutes, to avoid counting one page twice. Nothing about a person reaches
// D1. The rate limit below is keyed on the IP address, in Cloudflare's own counter: we don't store it.
import { DurableObject } from "cloudflare:workers";
import { Env, json } from "./env";

const TICK_MS = 60_000, STORY_WRITE_MS = 10 * 60_000, SAMPLE_MS = 5 * 60_000, ONLINE_WINDOW_MS = 5 * 60_000, HOUR_MS = 36e5;
const MAX_PAGES = 50_000, MAX_STORIES = 2_000, MAX_SHOWN = 60, MAX_OPENED = 10, MAX_BODY = 16_384;
const SID = /^[a-f0-9]{16,32}$/, STORY_ID = /^[A-Za-z0-9_.~-]{1,200}$/;

export interface StatsReport { sid: string; shown: string[]; opened: string[] }

/** What a page may report, or null. Anything odd is dropped: these are only counts, so there's no one to send an error to. */
export function cleanReport(b: unknown): StatsReport | null {
  const r = b as Partial<StatsReport> | null;
  if (!r || typeof r.sid !== "string" || !SID.test(r.sid)) return null;
  const ids = (v: unknown, max: number) => Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && STORY_ID.test(x)))].slice(0, max) : [];
  return { sid: r.sid, shown: ids(r.shown, MAX_SHOWN), opened: ids(r.opened, MAX_OPENED) };
}

const accepted = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

/** The body as text, or null past the limit. A chunked request has no content-length, so the bytes are what's counted. */
async function readCapped(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader(), decoder = new TextDecoder();
  let text = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.length;
    if (size > MAX_BODY) { await reader.cancel(); return null; }
    text += decoder.decode(value, { stream: true });
  }
}

/** POST /api/stats. Same-origin JSON only, checked by the caller, though anyone can forge those headers: hence the rate limit. */
export async function statsReport(req: Request, env: Env): Promise<Response> {
  // Over the limit looks like success, so there's nothing to learn from it. A page ignores the answer anyway.
  if (env.STATS_LIMIT && !(await env.STATS_LIMIT.limit({ key: req.headers.get("cf-connecting-ip") || "unknown" })).success) return accepted();
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return json({ error: "Too large" }, { status: 413 });
  const text = await readCapped(req);
  if (text === null) return json({ error: "Too large" }, { status: 413 });
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* cleanReport refuses it */ }
  const report = cleanReport(body);
  if (!report) return json({ error: "Bad request" }, { status: 400 });
  const hub = env.STATS.get(env.STATS.idFromName("site"));
  await hub.fetch(new Request("https://stats/report", { method: "POST", body: JSON.stringify(report) }));
  return accepted();
}

export class StatsHub extends DurableObject<Env> {
  private pages = new Map<string, number>();
  private counts = new Map<string, { shown: number; opened: number }>();
  private lastSampleAt = 0;
  private lastOnline = 0;
  private lastStoryWriteAt = 0;

  async fetch(req: Request): Promise<Response> {
    const r = await req.json<StatsReport>();
    if (this.pages.size < MAX_PAGES || this.pages.has(r.sid)) this.pages.set(r.sid, Date.now());
    const add = (id: string, key: "shown" | "opened") => {
      const c = this.counts.get(id);
      if (c) c[key]++;
      else if (this.counts.size < MAX_STORIES) this.counts.set(id, { shown: key === "shown" ? 1 : 0, opened: key === "opened" ? 1 : 0 });
    };
    r.shown.forEach(id => add(id, "shown"));
    r.opened.forEach(id => add(id, "opened"));
    if (await this.ctx.storage.getAlarm() === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
    return new Response(null, { status: 204 });
  }

  async alarm() {
    await this.flush(Date.now());
    if (this.pages.size || this.counts.size) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  /** Forget closed pages, then write what's due. A failed story write doesn't stop the online sample, or the reverse. */
  private async flush(now: number) {
    for (const [sid, at] of this.pages) if (now - at > ONLINE_WINDOW_MS) this.pages.delete(sid);
    const online = this.pages.size;
    const results = await Promise.allSettled([this.writeStories(now, online), this.writeSample(now, online)]);
    for (const r of results) if (r.status === "rejected") throw r.reason; // The alarm's own retry tries again
  }

  /** Story ids come from readers' browsers, so one statement, whatever the count, and rows only for stories readers can see. */
  private async writeStories(now: number, online: number) {
    if (!this.counts.size || (online > 0 && now - this.lastStoryWriteAt < STORY_WRITE_MS)) return;
    const waiting = this.counts;
    this.counts = new Map();
    try {
      await this.env.DB.prepare(
        `INSERT INTO story_traffic (hour, story_id, impressions, clicks)
         SELECT ?1, s.id, json_extract(j.value, '$[1]'), json_extract(j.value, '$[2]')
           FROM json_each(?2) j JOIN stories s ON s.id = json_extract(j.value, '$[0]')
          WHERE s.stage IN ('developing', 'archived')
         ON CONFLICT (hour, story_id) DO UPDATE SET impressions = impressions + excluded.impressions, clicks = clicks + excluded.clicks`,
      ).bind(Math.floor(now / HOUR_MS), JSON.stringify([...waiting].map(([id, c]) => [id, c.shown, c.opened]))).run();
      this.lastStoryWriteAt = now;
    } catch (e) {
      for (const [id, c] of waiting) {
        const newer = this.counts.get(id);
        if (newer) { newer.shown += c.shown; newer.opened += c.opened; }
        else if (this.counts.size < MAX_STORIES) this.counts.set(id, c);
      }
      throw e;
    }
  }

  /** A new 5 minutes gets a sample, and so does the moment the last reader leaves, so the chart falls to zero. */
  private async writeSample(now: number, online: number) {
    const sampleAt = Math.floor(now / SAMPLE_MS) * SAMPLE_MS;
    if (sampleAt === this.lastSampleAt && !(online === 0 && this.lastOnline > 0)) return;
    await this.env.DB.prepare("INSERT OR REPLACE INTO online_samples (at, online) VALUES (?, ?)").bind(sampleAt, online).run();
    this.lastSampleAt = sampleAt;
    this.lastOnline = online;
  }
}
