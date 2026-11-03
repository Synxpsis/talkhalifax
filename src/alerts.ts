import { Env } from "./env";

// "Getting around": road notices, Windsor Street Exchange work, Halifax Transit detours and weather warnings,
// shown on the home page as official titles with links. Nothing here is rewritten; the newsroom isn't involved.
const HFX = "https://www.halifax.ca";
const ECCC = "https://api.weather.gc.ca/collections/citypageweather-realtime/items?f=json&identifier=ns-19";
const ROAD_FEEDS: [string, string][] = [
  ["/news/category/rss-feed?category=20", "Roads"],
  ["/news/category/rss-feed?category=1258", "Windsor Street Exchange"],
];
const TRANSIT = HFX + "/transportation/halifax-transit/service-disruptions";
const STALE_MS = 45 * 60_000;
const UA = { "user-agent": "Mozilla/5.0 (TalkHalifax; Cloudflare Worker)" };

export interface Alert {
  cat: "Weather" | "Roads" | "Windsor Street Exchange" | "Transit";
  kind: string;          // "Traffic delay", "Detour", "Warning"…
  title: string;
  detail: string;
  until: string;         // as the source states it, or ""
  url: string;
  publishedAt: string | null;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
const unescape = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
const textOf = (h: string) => unescape(unescape(h).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s);
const en = (v: any) => (v && typeof v === "object" && "en" in v ? v.en : v);
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

async function get(url: string) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.text();
}

// ---------- dates, as Halifax sees them ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Today in Halifax as a sortable number, e.g. 20261102. */
function halifaxToday() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  return { n: Number(p.year) * 1e4 + Number(p.month) * 100 + Number(p.day), year: Number(p.year) };
}
const dayNum = (y: number, monName: string, d: number) => {
  const m = MONTHS.indexOf(monName.toLowerCase().slice(0, 3));
  return m < 0 || d < 1 || d > 31 ? null : y * 1e4 + (m + 1) * 100 + d;
};
/** "Monday, Nov. 30, 2026" → 20261130 */
function fullDay(s: string) {
  const m = s.match(/([A-Za-z]{3})[a-z]*\.? (\d{1,2}), (\d{4})/);
  return m ? dayNum(Number(m[3]), m[1], Number(m[2])) : null;
}
/** The latest "Oct. 29" / "November 2" mentioned in a road notice, assuming this year. */
function lastMentionedDay(s: string, year: number) {
  const days = [...s.matchAll(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})\b/g)]
    .map(m => dayNum(year, m[1], Number(m[2]))).filter((d): d is number => d != null);
  return days.length ? Math.max(...days) : null;
}

// ---------- sources ----------
async function roads(today: ReturnType<typeof halifaxToday>): Promise<Alert[]> {
  const out: Alert[] = [], seen = new Set<string>();
  for (const [path, cat] of ROAD_FEEDS) {
    let xml = "";
    try { xml = await get(HFX + path); } catch (e) { console.error(e); continue; }
    for (const item of xml.match(/<item>[\s\S]*?<\/item>/g) || []) {
      const tag = (k: string) => (item.match(new RegExp(`<${k}>([\\s\\S]*?)</${k}>`)) || [, ""])[1];
      const url = textOf(tag("link")), t = Date.parse(tag("pubDate"));
      if (!url || !t || seen.has(url) || Date.now() - t > 7 * 864e5) continue;
      const title = textOf(tag("title")), detail = textOf(tag("description"));
      // Drop notices whose dates have all passed; keep undated ones for 3 days
      const last = lastMentionedDay(title + " " + detail, today.year);
      if ((last && last < today.n) || (!last && Date.now() - t > 3 * 864e5)) continue;
      seen.add(url);
      // "Traffic Delay - Portland Street" → kind "Traffic delay", title "Portland Street"
      const parts = title.split(/\s+[-–]\s+/);
      const kind = parts.length > 1 ? parts[0][0].toUpperCase() + parts[0].slice(1).toLowerCase() : "Road notice";
      out.push({ cat: cat as Alert["cat"], kind, title: parts.length > 1 ? parts.slice(1).join(" – ") : title, detail: clip(detail, 220), until: "", url, publishedAt: iso(t) });
    }
  }
  return out;
}

async function transit(today: ReturnType<typeof halifaxToday>): Promise<Alert[]> {
  let page = await get(TRANSIT);
  const main = page.indexOf("<main");
  if (main > 0) page = page.slice(main);
  const lines = unescape(page.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, "\n"))
    .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const HEAD = /^(Detour|Stop closure|Closure|Ferry)[^:]*:/;
  const out: Alert[] = [];
  lines.forEach((l, i) => {
    if (!HEAD.test(l)) return;
    let end = lines.findIndex((x, j) => j > i && HEAD.test(x));
    if (end < 0) end = Math.min(lines.length, i + 30);
    const block = lines.slice(i + 1, end);
    const field = (label: string) => { const k = block.findIndex(x => x.replace(/:$/, "") === label); return k >= 0 ? block[k + 1] || "" : ""; };
    const endDate = field("End Date");
    const endDay = fullDay(endDate);
    if (endDay && endDay < today.n) return;
    const routes = field("Route(s)");
    const [kind, ...rest] = l.split(":");
    out.push({
      cat: "Transit", kind: kind.trim(), title: rest.join(":").trim() + (routes ? ` (Route${/[,\s]/.test(routes) ? "s" : ""} ${routes})` : ""),
      detail: clip(block.find(x => x.length > 60) || "", 220),
      until: endDate && !/^N\/A/i.test(endDate) ? endDate : "until further notice",
      url: TRANSIT, publishedAt: null,
    });
  });
  return out;
}

export async function weatherWarnings(): Promise<Alert[]> {
  const p = JSON.parse(await get(ECCC)).features[0].properties;
  const out: Alert[] = [];
  for (const w of p.warnings || []) {
    for (const e of (w && Array.isArray(w.events) ? w.events : [w])) {
      const title = textOf(String(en(e?.description) || en(e?.type) || "Weather alert"));
      const type = String(en(e?.type) || "");
      out.push({
        cat: "Weather", kind: /warning/i.test(type + title) ? "Warning" : /watch/i.test(type + title) ? "Watch" : "Statement",
        title, detail: "", until: String(en(e?.expiryTime) || ""), url: String(en(e?.url) || en(p.url) || "https://weather.gc.ca"),
        publishedAt: en(e?.eventIssue?.timeStamp) || p.lastUpdated || null,
      });
    }
  }
  return out;
}

export async function refreshAlerts(env: Env) {
  const today = halifaxToday();
  const parts = await Promise.allSettled([weatherWarnings(), roads(today), transit(today)]);
  parts.forEach(r => { if (r.status === "rejected") console.error("alerts:", r.reason); });
  // If every source failed, keep what we had rather than showing an empty strip
  if (parts.every(r => r.status === "rejected")) return null;
  const items = parts.flatMap(r => (r.status === "fulfilled" ? r.value : []));
  const body = { updatedAt: iso(Date.now()), items };
  await env.DB.prepare(
    "INSERT INTO feeds (name, body, updated_at) VALUES ('alerts', ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
  ).bind(JSON.stringify(body), body.updatedAt).run();
  return body;
}

/** Stored alerts; refreshed in the background when older than 45 minutes (covers local dev, where cron doesn't run). */
export async function getAlerts(env: Env, ctx: ExecutionContext) {
  const row = await env.DB.prepare("SELECT body, updated_at FROM feeds WHERE name = 'alerts'").first<{ body: string; updated_at: string }>();
  if (!row) return await refreshAlerts(env).catch(() => null);
  if (Date.now() - Date.parse(row.updated_at) > STALE_MS) ctx.waitUntil(refreshAlerts(env).catch(() => {}));
  return JSON.parse(row.body);
}
