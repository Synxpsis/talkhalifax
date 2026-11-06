import { Env } from "./env";

// Environment Canada's warnings, watches and statements for Halifax: the banners on Home, the Notices page and the
// conditions tool. Shown as official titles with links. Nothing here is rewritten; the newsroom isn't involved.
const ECCC = "https://api.weather.gc.ca/collections/citypageweather-realtime/items?f=json&identifier=ns-19";
const STALE_MS = 45 * 60_000;
const UA = { "user-agent": "Mozilla/5.0 (TalkHalifax; Cloudflare Worker)" };

export interface Alert {
  cat: "Weather";
  kind: string;          // "Warning", "Watch" or "Statement"
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
const en = (v: any) => (v && typeof v === "object" && "en" in v ? v.en : v);
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

export async function weatherWarnings(): Promise<Alert[]> {
  const r = await fetch(ECCC, { headers: UA });
  if (!r.ok) throw new Error(`${ECCC} ${r.status}`);
  const p = JSON.parse(await r.text()).features[0].properties;
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

/** The cron's job. A failed fetch throws, so the last list stays up and the editor hears after two failed runs. */
export async function refreshAlerts(env: Env) {
  const body = { updatedAt: iso(Date.now()), items: await weatherWarnings() };
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
