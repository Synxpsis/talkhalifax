// Fetches Halifax Public Libraries' public events feed for the next two weeks and posts the raw RSS pages to the site,
// which parses and stores them (src/events.ts). The feed refuses requests from Cloudflare, so this runs on GitHub
// Actions every 6 hours (.github/workflows/events.yml). By hand:
//   EVENTS_TOKEN=... node scripts/fetch-events.mjs            (SITE defaults to the live site)
const FEED = "https://gateway.bibliocommons.com/v2/libraries/halifax/rss/events";
const SITE = (process.env.SITE || "https://talkhalifax.alexwmmolloy.workers.dev").replace(/\/$/, "");
const TOKEN = process.env.EVENTS_TOKEN;
const DAYS = 14, MAX_PAGES = 40;
if (!TOKEN) { console.error("EVENTS_TOKEN isn't set."); process.exit(1); }

const localDay = (n = 0) => new Date(Date.now() + n * 864e5).toLocaleDateString("en-CA", { timeZone: "America/Halifax" });
const from = localDay(), to = localDay(DAYS);
const wait = ms => new Promise(r => setTimeout(r, ms));

// Page until a page is empty or adds nothing new (the feed repeats its last page past the end)
const pages = [], seen = new Set();
for (let page = 1; page <= MAX_PAGES; page++) {
  const r = await fetch(`${FEED}?startDate=${from}&endDate=${to}&page=${page}`, { headers: { "user-agent": `TalkHalifax events (+${SITE})` } });
  if (!r.ok) { console.error(`Library feed: HTTP ${r.status} on page ${page}`); process.exit(1); }
  const xml = await r.text();
  const keys = [...xml.matchAll(/<item>[\s\S]*?<link>([^<]+)<\/link>[\s\S]*?<bc:start_date>([^<]+)<\/bc:start_date>/g)].map(m => m[1] + m[2]);
  const fresh = keys.filter(k => !seen.has(k));
  if (!fresh.length) break;
  fresh.forEach(k => seen.add(k));
  pages.push(xml);
  await wait(500);
}
if (!pages.length) { console.error("The library feed returned no events."); process.exit(1); }

const r = await fetch(`${SITE}/api/events/ingest`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ from, to, pages }),
});
const d = await r.json().catch(() => ({}));
if (!r.ok) { console.error(`The site refused the events: HTTP ${r.status} ${d.error || ""}`); process.exit(1); }
console.log(`Posted ${pages.length} pages; the site stored ${d.events} events from ${d.from} to ${d.to}.`);
