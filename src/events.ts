// What's on in Halifax, for the Events tab. The source is Halifax Public Libraries' public events feed (BiblioCommons
// RSS, which takes a date range). Events are shown as the library lists them, never rewritten, each linking back.
// The cron stores the next two weeks in feeds ('events'); /api/events reads that.
import { Env, json } from "./env";

const FEED = "https://gateway.bibliocommons.com/v2/libraries/halifax/rss/events";
const DAYS = 14, MAX_PAGES = 40, STALE_MS = 3 * 36e5;
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

/** Halifax's local date, YYYY-MM-DD, n days from now. */
const localDay = (n = 0) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "America/Halifax" });

export async function fetchEvents() {
  const from = localDay(), to = localDay(DAYS);
  const seen = new Map<string, LibraryEvent>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await fetch(`${FEED}?startDate=${from}&endDate=${to}&page=${page}`, { headers: { "user-agent": "TalkHalifax (Cloudflare Worker)" } });
    if (!r.ok) throw new Error(`Library events: HTTP ${r.status} ${(await r.text()).slice(0, 200).replace(/\s+/g, " ")}`);
    const items = (await r.text()).split("<item>").slice(1);
    let fresh = 0;
    for (const it of items) { const e = parseItem(it); if (e && !seen.has(e.id + e.start)) { seen.set(e.id + e.start, e); fresh++; } }
    if (!items.length || !fresh) break;
  }
  const events = [...seen.values()].filter(e => Date.parse(e.end || e.start) > Date.now()).sort((a, b) => a.start.localeCompare(b.start));
  return { updatedAt: new Date().toISOString(), source: "Halifax Public Libraries", sourceUrl: "https://halifax.bibliocommons.com/v2/events", from, to, events };
}

export async function refreshEvents(env: Env) {
  const body = await fetchEvents();
  if (!body.events.length) throw new Error("Library events: the feed returned no events");
  await env.DB.prepare(
    "INSERT INTO feeds (name, body, updated_at) VALUES ('events', ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
  ).bind(JSON.stringify(body), body.updatedAt).run();
  return body;
}

/** GET /api/events: the stored list without events that have ended; refreshed in the background when it's old. */
export async function events(env: Env, ctx: ExecutionContext): Promise<Response> {
  const row = await env.DB.prepare("SELECT body, updated_at FROM feeds WHERE name = 'events'").first<{ body: string; updated_at: string }>();
  let body: Awaited<ReturnType<typeof fetchEvents>> | null = null;
  if (row) {
    body = JSON.parse(row.body);
    if (Date.now() - Date.parse(row.updated_at) > STALE_MS) ctx.waitUntil(refreshEvents(env).catch(() => {}));
  } else body = await refreshEvents(env).catch(e => { console.error(e); return null; });
  if (!body) return json({ error: "The library's events list isn't answering right now." }, { status: 502 });
  const now = Date.now();
  return json({ ...body, events: body.events.filter(e => Date.parse(e.end || e.start) > now) }, { headers: { "cache-control": "public, max-age=300" } });
}

/** The cron's job: refresh only when the stored list is old, since a refresh is about 16 requests to the library. */
export async function refreshEventsIfStale(env: Env) {
  const row = await env.DB.prepare("SELECT updated_at FROM feeds WHERE name = 'events'").first<{ updated_at: string }>();
  if (!row || Date.now() - Date.parse(row.updated_at) > STALE_MS) await refreshEvents(env);
}
