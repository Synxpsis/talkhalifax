// Halifax Water's own notices, alerts and news: water main repairs, shut-offs, boil-water advisories and traffic advisories.
// The site has no feed, so read its listing pages. Every page carries a site-wide alert banner above the content, which
// can be a year old, so nothing is read from above a page's own headline.
export const HALIFAX_WATER = "https://www.halifaxwater.ca";
// Six older notices to a page; two pages reach back about a week
export const WATER_PAGES = ["/notices-and-news", "/notices-and-news?page=1", "/alerts"];

export interface WaterItem { path: string; type: "notice" | "alert" | "news"; title: string; publishedAt: string; summary: string }

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
const text = (h: string) => decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");

/** "2:34 PM | November 2, 2026", in Halifax time, as ISO UTC. Null if it doesn't read that way. */
export function waterDate(s: string): string | null {
  const m = s.match(/(\d{1,2}):(\d{2})\s*([AP])M\s*\|\s*([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  const month = m ? MONTHS.indexOf(m[4].toLowerCase()) : -1;
  if (!m || month < 0) return null;
  const hour = (+m[1] % 12) + (m[3].toUpperCase() === "P" ? 12 : 0);
  const asIfUtc = Date.UTC(+m[6], month, +m[5], hour, +m[2]);
  // Halifax's offset on that date: -4 hours in winter, -3 in summer
  const zone = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", timeZoneName: "shortOffset" })
    .formatToParts(new Date(asIfUtc)).find(p => p.type === "timeZoneName")?.value || "GMT-4";
  const offset = Number(zone.replace("GMT", "") || 0);
  return iso(asIfUtc - offset * 36e5);
}

/** The items on a listing page: the full cards for what's current, then the plain rows for everything else. */
export function parseWaterListing(html: string): WaterItem[] {
  const found = new Map<string, WaterItem>();
  for (const m of html.matchAll(/<article about="(\/(notice|alert|news)\/[^"]+)"[\s\S]*?<\/article>/g)) {
    const title = text(m[0].match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] || "");
    const publishedAt = waterDate(text(m[0].match(/class='date-published'>([\s\S]*?)<\/div>/)?.[1] || ""));
    const body = m[0].match(/field--name-field-body[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)?.[1] || "";
    if (title && publishedAt) found.set(m[1], { path: m[1], type: m[2] as WaterItem["type"], title, publishedAt, summary: text(body).slice(0, 280) });
  }
  for (const m of html.matchAll(/<a href="(\/(notice|alert|news)\/[^"]+)" hreflang="en">([^<]+)<\/a>[\s\S]{0,300}?<time datetime="([^"]+)"/g)) {
    const t = Date.parse(m[4]);
    if (!found.has(m[1]) && t) found.set(m[1], { path: m[1], type: m[2] as WaterItem["type"], title: text(m[3]), publishedAt: iso(t), summary: "" });
  }
  return [...found.values()];
}

/** How soon the newsroom should get to it: anything affecting water or roads in the next hours comes first. */
export function waterCategory(item: Pick<WaterItem, "type" | "title">) {
  if (item.type === "alert") return "right-now" as const;
  if (item.type === "news") return "decisions" as const;
  return /boil|water quality|water service|emergency|shut.?(down|off)|water main|main break|traffic advisory/i.test(item.title) ? "right-now" as const : "decisions" as const;
}

/** A notice or alert page from its own headline down, without the site-wide banner above it. */
export function waterPageBody(page: string) {
  const h1 = page.indexOf("<h1");
  return h1 >= 0 ? page.slice(h1) : page;
}

/** When the page itself says it was published. */
export function waterPublished(body: string) {
  const near = body.match(/Published:[\s\S]{0,600}/)?.[0] || "";
  const stamp = near.match(/<time[^>]*datetime="([^"]+)"/)?.[1];
  if (stamp && Date.parse(stamp)) return iso(Date.parse(stamp));
  return waterDate(text(near));
}
