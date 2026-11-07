// The admin site's Worker. Stage 1 is read-only: every route is a GET and every query a SELECT.
// It never returns email addresses, password hashes, the journalist's private persona, or Google account ids.
import { validAccessToken, validTeam } from "./access";

export interface AdminEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  /** The Access team's address, like yourteam.cloudflareaccess.com. Without it and ACCESS_AUD, everything is refused. */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's audience (AUD) tag. */
  ACCESS_AUD?: string;
  /** "1" skips the Access check on localhost only. Passed by hand for a local run, never set in production. */
  ADMIN_DEV?: string;
}

const TZ = "America/Halifax", SITE = "https://talkhalifax.ca", HOUR_MS = 36e5, DAY_MS = 864e5;
const ONLINE_FRESH_MS = 10 * 60_000, PAGE_SIZE = 100, MAX_ITEMS = 500;

const SECURITY: Record<string, string> = {
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};
const secured = (res: Response) => {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  return out;
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const isLocal = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** A refusal, or null to let the request through. With Access not configured, nobody gets in. */
async function refuse(req: Request, env: AdminEnv, url: URL, now: number): Promise<Response | null> {
  if (env.ADMIN_DEV === "1" && isLocal(url.hostname)) return null;
  if (!env.ACCESS_TEAM_DOMAIN || !validTeam(env.ACCESS_TEAM_DOMAIN) || !env.ACCESS_AUD) return new Response("The admin site isn't set up yet: its Access settings are missing or wrong.", { status: 503 });
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token || !await validAccessToken(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, now)) return new Response("Sign in through Cloudflare Access.", { status: 403 });
  return null;
}

// ---------- time buckets ----------

export type Range = "24h" | "7d" | "30d";
const RANGES: Range[] = ["24h", "7d", "30d"];
const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hour12: false });

function halifax(ms: number) {
  const p: Record<string, string> = {};
  for (const x of parts.formatToParts(ms)) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, month: +p.month, date: +p.day, hour: +p.hour % 24 };
}

/** The labels for a chart, and which label each hour belongs to. Days are Halifax days, so the clocks changing is handled. */
export function buckets(range: Range, now: number) {
  const nowHour = Math.floor(now / HOUR_MS), labels: string[] = [], index = new Map<number, number>();
  if (range === "24h") {
    for (let i = 0; i < 24; i++) {
      const h = nowHour - 23 + i, t = halifax(h * HOUR_MS);
      labels.push(`${t.hour % 12 || 12} ${t.hour < 12 ? "am" : "pm"}`);
      index.set(h, i);
    }
    return { labels, index, fromHour: nowHour - 23 };
  }
  const days = range === "7d" ? 7 : 30, keys: string[] = [], hoursByDay = new Map<string, number[]>();
  for (let h = nowHour - (days + 1) * 24; h <= nowHour; h++) {
    const t = halifax(h * HOUR_MS);
    if (!hoursByDay.has(t.day)) { hoursByDay.set(t.day, []); keys.push(t.day); }
    hoursByDay.get(t.day)!.push(h);
  }
  const kept = keys.slice(-days);
  kept.forEach((k, i) => {
    const hours = hoursByDay.get(k)!;
    const t = halifax(hours[0] * HOUR_MS);
    labels.push(`${MONTHS[t.month - 1]} ${t.date}`);
    for (const h of hours) index.set(h, i);
  });
  return { labels, index, fromHour: hoursByDay.get(kept[0])![0] };
}

function fill(n: number, index: Map<number, number>, rows: { h: number; n: number }[], how: "sum" | "max") {
  const out = new Array<number>(n).fill(0);
  for (const r of rows) {
    const i = index.get(r.h);
    if (i !== undefined) out[i] = how === "sum" ? out[i] + r.n : Math.max(out[i], r.n);
  }
  return out;
}

// ---------- what the pages show ----------

async function overview(env: AdminEnv, range: Range, now: number) {
  const { labels, index, fromHour } = buckets(range, now);
  const fromMs = fromHour * HOUR_MS;
  type Hourly = { h: number; n: number };
  const [signups, messages, online, traffic, latest, since] = await env.DB.batch([
    env.DB.prepare("SELECT created_at / 3600000 AS h, COUNT(*) AS n FROM users WHERE created_at >= ? AND provider NOT IN ('newsroom', 'deleted') GROUP BY h").bind(fromMs),
    env.DB.prepare("SELECT created_at / 3600000 AS h, COUNT(*) AS n FROM message_index WHERE created_at >= ? AND deleted = 0 GROUP BY h").bind(fromMs),
    env.DB.prepare("SELECT at / 3600000 AS h, MAX(online) AS n FROM online_samples WHERE at >= ? GROUP BY h").bind(fromMs),
    env.DB.prepare("SELECT hour AS h, SUM(impressions) AS i, SUM(clicks) AS c FROM story_traffic WHERE hour >= ? GROUP BY hour").bind(fromHour),
    env.DB.prepare("SELECT at, online FROM online_samples ORDER BY at DESC LIMIT 1"),
    env.DB.prepare("SELECT MIN(at) AS at FROM online_samples"),
  ]);
  const t = traffic.results as { h: number; i: number; c: number }[];
  const newest = latest.results[0] as { at: number; online: number } | undefined;
  return {
    range, labels,
    series: {
      online: fill(labels.length, index, online.results as Hourly[], "max"),
      signups: fill(labels.length, index, signups.results as Hourly[], "sum"),
      messages: fill(labels.length, index, messages.results as Hourly[], "sum"),
      impressions: fill(labels.length, index, t.map(r => ({ h: r.h, n: r.i })), "sum"),
      clicks: fill(labels.length, index, t.map(r => ({ h: r.h, n: r.c })), "sum"),
    },
    onlineNow: newest && now - newest.at < ONLINE_FRESH_MS ? newest.online : 0,
    countingSince: (since.results[0] as { at: number | null } | undefined)?.at ?? null,
  };
}

async function summary(env: AdminEnv, now: number) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users WHERE provider NOT IN ('newsroom', 'deleted')) AS members,
            (SELECT COUNT(*) FROM users WHERE provider NOT IN ('newsroom', 'deleted') AND created_at >= ?1) AS newThisWeek,
            (SELECT COUNT(DISTINCT user_id) FROM message_index WHERE created_at >= ?1 AND deleted = 0) AS postedThisWeek,
            (SELECT COUNT(*) FROM users WHERE banned = 1) AS banned,
            (SELECT COUNT(*) FROM reports WHERE resolved IS NULL) AS openReports,
            (SELECT COUNT(*) FROM stories WHERE stage = 'draft') AS drafts,
            (SELECT COUNT(*) FROM pending_updates WHERE status = 'waiting') AS pendingUpdates,
            (SELECT COUNT(*) FROM stories WHERE stage = 'developing' AND kind = 'article') AS developing,
            (SELECT COUNT(*) FROM stories WHERE stage = 'developing' AND kind = 'notice') AS notices,
            (SELECT COUNT(*) FROM stories WHERE stage = 'archived' AND kind = 'article') AS articles,
            (SELECT COALESCE(SUM(rs.here_now), 0) FROM room_stats rs JOIN stories s ON s.id = rs.story_id WHERE s.stage = 'developing' AND s.kind = 'article') AS inRooms`,
  ).bind(now - 7 * DAY_MS).first<Record<string, number>>();
  return { ...row, events: (await upcomingEvents(env, now)).length, jobs: await jobs(env, now) };
}

interface EventRow { id: string; title: string; url: string; start: string; end: string; cancelled?: boolean }
async function eventFeed(env: AdminEnv) {
  const row = await env.DB.prepare("SELECT body, updated_at FROM feeds WHERE name = 'events'").first<{ body: string; updated_at: string }>();
  return row ? { events: (JSON.parse(row.body) as { events: EventRow[] }).events, updatedAt: row.updated_at } : { events: [] as EventRow[], updatedAt: null };
}
const upcomingEvents = async (env: AdminEnv, now: number) => (await eventFeed(env)).events.filter(e => Date.parse(e.end || e.start) > now);

async function users(env: AdminEnv, url: URL) {
  const q = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 60);
  const role = url.searchParams.get("role") || "all";
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const where = ["u.provider != 'deleted'"], binds: unknown[] = [];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
    where.push("(LOWER(u.name) LIKE ? ESCAPE '\\' OR (u.provider = 'password' AND LOWER(u.provider_sub) LIKE ? ESCAPE '\\'))");
    binds.push(like, like);
  }
  if (role === "banned") where.push("u.banned = 1");
  else if (["member", "moderator", "journalist"].includes(role)) { where.push("u.role = ?"); binds.push(role); }
  const clause = `WHERE ${where.join(" AND ")}`;
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(
      `SELECT u.id, u.name, CASE WHEN u.provider = 'password' THEN u.provider_sub END AS username, u.role, u.banned, u.created_at AS joined,
              (SELECT COUNT(*) FROM message_index m WHERE m.user_id = u.id AND m.deleted = 0) AS messages,
              (SELECT MAX(m.created_at) FROM message_index m WHERE m.user_id = u.id AND m.deleted = 0) AS lastPost,
              (SELECT COUNT(DISTINCT r.target_id) FROM reports r WHERE r.author_id = u.id AND r.resolved IS NULL) AS openReports
         FROM users u ${clause} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, PAGE_SIZE, offset),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${clause}`).bind(...binds),
  ]);
  return { users: rows.results, total: (total.results[0] as { n: number }).n, pageSize: PAGE_SIZE };
}

/** Which screen a story is on, as readers see it. */
export function screenOf(kind: string, stage: string) {
  if (kind === "notice") return "Notices";
  return stage === "archived" ? "Articles" : "Developing";
}
const statusOf = (stage: string) => stage === "draft" ? "waiting" : stage === "archived" ? "archived" : "active";
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function content(env: AdminEnv, url: URL, now: number) {
  const screen = url.searchParams.get("screen") || "all", status = url.searchParams.get("status") || "all";
  const q = (url.searchParams.get("q") || "").trim().toLowerCase().slice(0, 100);
  const fromHour = Math.floor((now - 30 * DAY_MS) / HOUR_MS);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.kind, s.stage, s.headline, s.source_url, s.updated_at, s.version, s.status_label,
            COALESCE(rs.message_count, 0) AS messages,
            COALESCE(t.impressions, 0) AS impressions, COALESCE(t.clicks, 0) AS clicks
       FROM stories s
       LEFT JOIN room_stats rs ON rs.story_id = s.id
       LEFT JOIN (SELECT story_id, SUM(impressions) AS impressions, SUM(clicks) AS clicks FROM story_traffic WHERE hour >= ? GROUP BY story_id) t ON t.story_id = s.id
      WHERE s.stage IN ('draft', 'developing', 'archived') AND s.kind != 'skip'
      ORDER BY s.updated_at DESC LIMIT ?`,
  ).bind(fromHour, MAX_ITEMS).all<{ id: string; kind: string; stage: string; headline: string; source_url: string; updated_at: string; version: number; status_label: string; messages: number; impressions: number; clicks: number }>();
  const stories = rows.results.map(r => ({
    id: r.id, title: r.headline, screen: screenOf(r.kind, r.stage), status: statusOf(r.stage), label: r.status_label, source: hostOf(r.source_url),
    updatedAt: r.updated_at, version: r.version, messages: r.messages, impressions: r.impressions, clicks: r.clicks,
    url: r.stage === "draft" ? null : `${SITE}/#article-${encodeURIComponent(r.id)}`,
  }));
  const feed = await eventFeed(env);
  const events = feed.events.filter(e => Date.parse(e.end || e.start) > now).map(e => ({
    id: e.id, title: e.title, screen: "Events", status: "active", label: e.cancelled ? "Cancelled" : "", source: "Halifax Public Libraries",
    updatedAt: feed.updatedAt, version: null, messages: null, impressions: null, clicks: null, url: /^https:\/\//.test(e.url) ? e.url : null,
  }));
  const all = [...stories, ...events];
  const items = all.filter(i => (screen === "all" || i.screen === screen) && (status === "all" || i.status === status) && (!q || i.title.toLowerCase().includes(q)));
  return { items: items.slice(0, MAX_ITEMS), total: items.length, limit: MAX_ITEMS };
}

const CRON_JOBS: { key: string; name: string; does: string; every: string }[] = [
  { key: "weather", name: "Weather", does: "Current conditions for the header", every: "30 minutes" },
  { key: "alerts", name: "Weather warnings", does: "Environment Canada banners and notices", every: "30 minutes" },
  { key: "events", name: "Events check", does: "Warns when library events stop arriving", every: "30 minutes" },
  { key: "stages", name: "Stages", does: "Moves Developing stories to Articles", every: "30 minutes" },
  { key: "transit schedule", name: "Transit schedule check", does: "Warns before the map's schedule data runs out", every: "30 minutes" },
  { key: "GitHub jobs", name: "GitHub jobs", does: "Starts the library events and Transit jobs", every: "30 minutes" },
  { key: "clean-up", name: "Clean-up", does: "Expired sessions, links, rate limits and old counts", every: "30 minutes" },
];

async function jobs(env: AdminEnv, now: number) {
  const rows = await env.DB.prepare("SELECT name, body, updated_at FROM feeds WHERE name IN ('cron-health', 'github-jobs')").all<{ name: string; body: string; updated_at: string }>();
  const by = new Map(rows.results.map(r => [r.name, r]));
  const health = by.get("cron-health"), fails: Record<string, number> = health ? JSON.parse(health.body) : {};
  const started: Record<string, number> = by.has("github-jobs") ? JSON.parse(by.get("github-jobs")!.body) : {};
  const lastRun = health ? Date.parse(health.updated_at) : null;
  // The cron runs every 30 minutes, so an hour of silence means it has stopped
  const cronLate = lastRun === null || now - lastRun > HOUR_MS;
  const list = CRON_JOBS.map(j => {
    const f = fails[j.key] || 0;
    return { name: j.name, does: j.does, every: j.every, lastAt: lastRun, state: f ? "failing" : cronLate ? "late" : "ok", failures: f };
  });
  const dispatched = (file: string, name: string, does: string, every: string, limitMs: number) => {
    const at = started[file] ?? null;
    return { name, does, every, lastAt: at, state: at === null || now - at > limitMs ? "late" : "ok", failures: 0 };
  };
  list.push(dispatched("events.yml", "Library events", "Fetches events and posts them to the site", "6 hours", 7 * HOUR_MS));
  list.push(dispatched("transit.yml", "Transit schedule", "Rebuilds the map's data for a new schedule", "7 days", 8 * DAY_MS));
  return list;
}

const SOURCE_NAMES: Record<string, string> = {
  "halifax.ca": "halifax.ca", "halifaxwater.ca": "Halifax Water", "news.novascotia.ca": "Province of Nova Scotia", "novascotia.ca": "Province of Nova Scotia",
  "rcmp.ca": "RCMP", "rcmp-grc.gc.ca": "RCMP", "weather.gc.ca": "Environment Canada",
};

async function dataView(env: AdminEnv, now: number) {
  const [stories, feeds] = await env.DB.batch([
    env.DB.prepare("SELECT source_url, published_at FROM stories WHERE stage IN ('developing', 'archived') AND kind != 'skip'"),
    env.DB.prepare("SELECT name, updated_at FROM feeds WHERE name IN ('weather', 'alerts', 'events')"),
  ]);
  const hosts = new Map<string, { name: string; stories: number; last: string }>();
  for (const r of stories.results as { source_url: string; published_at: string }[]) {
    const host = hostOf(r.source_url);
    if (!host) continue;
    const name = SOURCE_NAMES[host] || host;
    const h = hosts.get(name) || { name, stories: 0, last: "" };
    h.stories++;
    if (r.published_at > h.last) h.last = r.published_at;
    hosts.set(name, h);
  }
  const feed = (key: string, name: string, shows: string, staleAfter: number) => {
    const row = (feeds.results as { name: string; updated_at: string }[]).find(f => f.name === key);
    const at = row ? Date.parse(row.updated_at) : null;
    return { name, shows, lastAt: at, state: at === null ? "missing" : now - at > staleAfter ? "late" : "ok" };
  };
  return {
    feeds: [
      feed("weather", "Environment Canada, conditions", "Weather line", 2 * HOUR_MS),
      feed("alerts", "Environment Canada, warnings", "Banners and Notices", 2 * HOUR_MS),
      feed("events", "Halifax Public Libraries", "Events", 26 * HOUR_MS),
    ],
    sources: [...hosts.values()].sort((a, b) => b.last.localeCompare(a.last)),
  };
}

async function api(url: URL, env: AdminEnv, now: number): Promise<Response> {
  switch (url.pathname) {
    case "/api/summary": return json(await summary(env, now));
    case "/api/overview": {
      const r = url.searchParams.get("range") as Range;
      return json(await overview(env, RANGES.includes(r) ? r : "7d", now));
    }
    case "/api/users": return json(await users(env, url));
    case "/api/content": return json(await content(env, url, now));
    case "/api/data": return json(await dataView(env, now));
    case "/api/jobs": return json({ jobs: await jobs(env, now) });
    default: return json({ error: "Not found" }, 404);
  }
}

export async function handle(req: Request, env: AdminEnv, now = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  const no = await refuse(req, env, url, now);
  if (no) return secured(no);
  if (req.method !== "GET" && req.method !== "HEAD") return secured(new Response("This site is read-only.", { status: 405, headers: { allow: "GET, HEAD" } }));
  try {
    return secured(url.pathname.startsWith("/api/") ? await api(url, env, now) : await env.ASSETS.fetch(req));
  } catch (e) {
    console.error(e);
    return secured(json({ error: "Something went wrong" }, 500));
  }
}

export default { fetch: (req: Request, env: AdminEnv) => handle(req, env) } satisfies ExportedHandler<AdminEnv>;
