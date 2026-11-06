// What's on in Halifax, for the Events tab. The source is Halifax Public Libraries' public events feed (BiblioCommons
// RSS, which takes a date range). Events are shown as the library lists them, never rewritten, each linking back.
// The feed refuses requests from Cloudflare, so a GitHub Action (scripts/fetch-events.mjs, every 6 hours) fetches the
// next two weeks and posts the raw pages to /api/events/ingest. They're parsed here and stored in feeds ('events');
// /api/events reads that.
import { Env, json } from "./env";

const MAX_PAGES = 40, MAX_PAGE_BYTES = 1_000_000, STALE_MS = 26 * 36e5;
const AUDIENCES = ["Preschoolers", "Kids", "Teens", "Adults", "All Ages"];
const LANGUAGES = /^(English|French|Arabic|Spanish|Mandarin|Cantonese|Persian|Farsi|Ukrainian|Hindi|Punjabi|Tagalog|Korean|Portuguese|ASL|Mi'kmaw|Gaelic)$/i;
// The library's stock banner for each event type isn't a picture of the event, so it doesn't count as an image
const STOCK_IMAGE = /Biblio-Events-V2-|-events-\d+x\d+/i;
const HIGHLIGHT_TYPES = new Set(["Special Events", "Performances", "Celebrations & Commemorations", "Authors & Writing", "Music", "Movies"]);

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1").trim() : "";
};
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
const decode = (s: string) => s.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : entities[e.toLowerCase()] ?? m);
/** The description as plain text, up to the first rule (the library puts ages and fine print after an <hr>). */
const summary = (html: string) => {
  const main = html.split(/<hr\s*\/?>/i)[0];
  const t = decode(main.replace(/<\/(p|li|h\d)>|<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
  return t.length > 280 ? t.slice(0, 280).replace(/\s+\S*$/, "") + "…" : t;
};

export interface LibraryEvent {
  id: string; title: string; url: string; start: string; end: string; startLocal: string; endLocal: string;
  place: string; room: string; city: string; lat: number | null; lon: number | null;
  audiences: string[]; types: string[]; image: string | null;
  featured: boolean; highlight: boolean; cancelled: boolean; virtual: boolean;
  registration: "required" | "full" | null; summary: string;
}

function parseItem(item: string): LibraryEvent | null {
  const url = tag(item, "link"), id = url.split("/").pop() || "";
  const start = tag(item, "bc:start_date"), title = decode(tag(item, "title"));
  if (!id || !start || !title) return null;
  const cats = [...item.matchAll(/<category>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/category>/g)].map(m => decode(m[1]).trim()).filter(Boolean);
  const audiences = cats.filter(c => AUDIENCES.includes(c));
  const types = cats.filter(c => !AUDIENCES.includes(c) && !LANGUAGES.test(c));
  const img = item.match(/<enclosure[^>]*url="([^"]+)"/)?.[1]?.replace(/^http:/, "https:") || null;
  const loc = tag(item, "bc:location"), reg = tag(item, "bc:registration_info");
  const featured = tag(item, "bc:is_featured") === "true" || tag(item, "bc:is_featured_at_location") === "true";
  const lat = parseFloat(tag(loc, "bc:latitude")), lon = parseFloat(tag(loc, "bc:longitude"));
  return {
    id, title, url: url.replace(/^http:/, "https:"),
    start, end: tag(item, "bc:end_date"), startLocal: tag(item, "bc:start_date_local"), endLocal: tag(item, "bc:end_date_local"),
    place: decode(tag(loc, "bc:name")), room: decode(tag(loc, "bc:location_details")), city: decode(tag(loc, "bc:city")),
    lat: isFinite(lat) ? lat : null, lon: isFinite(lon) ? lon : null,
    audiences, types, image: img && !STOCK_IMAGE.test(img) ? img : null,
    featured, highlight: featured || types.some(t => HIGHLIGHT_TYPES.has(t)),
    cancelled: tag(item, "bc:is_cancelled") === "true", virtual: tag(item, "bc:is_virtual") === "true",
    registration: tag(reg, "bc:is_full") === "true" ? "full" : tag(reg, "bc:is_required") === "true" ? "required" : null,
    summary: summary(tag(item, "description")),
  };
}

/** The events in the feed's RSS pages, de-duplicated, without any that have ended. */
function parsePages(pages: string[], from: string, to: string) {
  const seen = new Map<string, LibraryEvent>();
  for (const page of pages) for (const it of page.split("<item>").slice(1)) {
    const e = parseItem(it);
    if (e && !seen.has(e.id + e.start)) seen.set(e.id + e.start, e);
  }
  const events = [...seen.values()].filter(e => Date.parse(e.end || e.start) > Date.now()).sort((a, b) => a.start.localeCompare(b.start));
  return { updatedAt: new Date().toISOString(), source: "Halifax Public Libraries", sourceUrl: "https://halifax.bibliocommons.com/v2/events", from, to, events };
}
type EventsBody = ReturnType<typeof parsePages>;

/** POST /api/events/ingest (Bearer EVENTS_TOKEN): { from, to, pages: [rss, ...] } from the GitHub Action. */
export async function ingestEvents(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, { status: 405 });
  if (!env.EVENTS_TOKEN || req.headers.get("authorization") !== `Bearer ${env.EVENTS_TOKEN}`) return json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json().catch(() => null) as { from?: unknown; to?: unknown; pages?: unknown } | null;
  const day = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!b || !day(b.from) || !day(b.to) || !Array.isArray(b.pages) || !b.pages.length || b.pages.length > MAX_PAGES
    || !b.pages.every(p => typeof p === "string" && p.length <= MAX_PAGE_BYTES)) return json({ error: "Bad request" }, { status: 400 });
  const body = parsePages(b.pages as string[], b.from as string, b.to as string);
  // An empty or broken fetch keeps the last good list rather than wiping the tab
  if (!body.events.length) return json({ error: "No events in those pages; the stored list is unchanged." }, { status: 422 });
  await env.DB.prepare(
    "INSERT INTO feeds (name, body, updated_at) VALUES ('events', ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
  ).bind(JSON.stringify(body), body.updatedAt).run();
  return json({ events: body.events.length, from: body.from, to: body.to });
}

/** GET /api/events: the stored list without events that have ended. */
export async function events(env: Env): Promise<Response> {
  const row = await env.DB.prepare("SELECT body FROM feeds WHERE name = 'events'").first<{ body: string }>();
  if (!row) return json({ error: "The events list hasn't loaded yet. Check back soon." }, { status: 503 });
  const body: EventsBody = JSON.parse(row.body), now = Date.now();
  return json({ ...body, events: body.events.filter(e => Date.parse(e.end || e.start) > now) }, { headers: { "cache-control": "public, max-age=300" } });
}

/** The cron's job: fail (so the editor hears after two runs) when the GitHub Action hasn't delivered for over a day. */
export async function checkEvents(env: Env) {
  const row = await env.DB.prepare("SELECT updated_at FROM feeds WHERE name = 'events'").first<{ updated_at: string }>();
  if (!row) throw new Error("Library events have never arrived. Run the Events workflow on GitHub (Actions tab).");
  if (Date.now() - Date.parse(row.updated_at) > STALE_MS) throw new Error(`Library events haven't arrived since ${row.updated_at}. Check the Events workflow on GitHub (Actions tab).`);
}
