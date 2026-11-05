// Halifax Transit in real time, for the Transit map: where every bus and ferry is, and active service alerts.
// The source is Halifax Transit's GTFS-realtime feeds (protocol buffers). The Worker fetches and decodes them, at most
// once per CACHE_MS per isolate however many people are watching, and the page polls the small JSON it returns.
// Route names, headsigns and stop names come from the schedule, built by scripts/build-transit.mjs.
import { json } from "./env";
import DATA from "./transit-data.json";

const FEEDS = {
  vehicles: "https://gtfs.halifax.ca/realtime/Vehicle/VehiclePositions.pb",
  alerts: "https://gtfs.halifax.ca/realtime/Alert/Alerts.pb",
};
const CACHE_MS = { vehicles: 12_000, alerts: 120_000 };
const STALE_VEHICLE_S = 10 * 60; // a bus that hasn't reported in 10 minutes is off the map

// ---------- just enough protocol buffers for GTFS-realtime ----------
type Msg = Map<number, (number | Uint8Array)[]>;
const utf8 = new TextDecoder();

function decode(b: Uint8Array): Msg {
  const m: Msg = new Map();
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 0;
  const varint = () => { let r = 0, s = 1, x; do { x = b[i++]; r += (x & 127) * s; s *= 128; } while (x & 128 && i < b.length); return r; };
  while (i < b.length) {
    const key = varint(), field = Math.floor(key / 8), type = key & 7;
    let v: number | Uint8Array;
    if (type === 0) v = varint();
    else if (type === 2) { const n = varint(); v = b.subarray(i, i + n); i += n; }
    else if (type === 5) { v = view.getFloat32(i, true); i += 4; }
    else if (type === 1) { v = view.getFloat64(i, true); i += 8; }
    else break; // groups (3, 4) aren't used by GTFS-realtime
    const list = m.get(field);
    if (list) list.push(v); else m.set(field, [v]);
  }
  return m;
}
const msg = (m: Msg | undefined, f: number) => { const v = m?.get(f)?.[0]; return v instanceof Uint8Array ? decode(v) : undefined; };
const msgs = (m: Msg | undefined, f: number) => (m?.get(f) || []).filter((v): v is Uint8Array => v instanceof Uint8Array).map(decode);
const str = (m: Msg | undefined, f: number) => { const v = m?.get(f)?.[0]; return v instanceof Uint8Array ? utf8.decode(v) : ""; };
const num = (m: Msg | undefined, f: number) => { const v = m?.get(f)?.[0]; return typeof v === "number" ? v : null; };
/** A TranslatedString: the English text, or the first one. */
const text = (m: Msg | undefined, f: number) => {
  const all = msgs(msg(m, f), 1);
  return str(all.find(x => str(x, 2).startsWith("en")) || all[0], 1);
};

// ---------- the feeds ----------
const D = DATA as unknown as {
  feedEnd: string; routes: Record<string, [string, string, number]>; headsigns: string[]; shapeIds: string[];
  trips: Record<string, [number, number]>; stops: Record<string, string>;
};
const STATUS = ["arriving at", "stopped at", "on the way to"];
const OCCUPANCY = ["empty", "many seats", "few seats", "standing room only", "crushed standing room only", "full", "not accepting passengers"];

async function feed(url: string) {
  const r = await fetch(url, { cf: { cacheTtl: 10 } } as RequestInit);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return decode(new Uint8Array(await r.arrayBuffer()));
}

async function vehicles() {
  const m = await feed(FEEDS.vehicles);
  const at = num(msg(m, 1), 3) || Math.floor(Date.now() / 1000);
  const list = [];
  for (const e of msgs(m, 2)) {
    const v = msg(e, 4); if (!v) continue;
    const pos = msg(v, 2), trip = msg(v, 1), desc = msg(v, 8);
    const lat = num(pos, 1), lon = num(pos, 2), ts = num(v, 5) || at;
    if (lat == null || lon == null || at - ts > STALE_VEHICLE_S) continue;
    const tripId = str(trip, 1), routeId = str(trip, 5), route = D.routes[routeId], t = D.trips[tripId];
    const speed = num(pos, 5), status = num(v, 4), occ = num(v, 9), stop = str(v, 7);
    list.push({
      id: str(desc, 1) || str(e, 1), label: str(desc, 2) || str(desc, 1),
      route: routeId, short: route?.[0] || routeId, name: route?.[1] || "", type: route?.[2] ?? 3,
      headsign: t ? D.headsigns[t[0]] : "", shape: t ? D.shapeIds[t[1]] : null,
      lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5,
      bearing: num(pos, 3), kmh: speed == null ? null : Math.round(speed * 3.6),
      next: stop ? { status: STATUS[status ?? 2] || "on the way to", stop: D.stops[stop] || stop } : null,
      occupancy: occ == null ? null : OCCUPANCY[occ] || null,
      seen: ts,
    });
  }
  return { updatedAt: at, scheduleUntil: D.feedEnd, vehicles: list };
}

async function alerts() {
  const m = await feed(FEEDS.alerts);
  const now = Math.floor(Date.now() / 1000);
  const list = [];
  for (const e of msgs(m, 2)) {
    const a = msg(e, 5); if (!a) continue;
    const periods = msgs(a, 1).map(p => [num(p, 1) || 0, num(p, 2) || Infinity]);
    if (periods.length && !periods.some(([s, end]) => s <= now && now < end)) continue;
    const sel = msgs(a, 5);
    list.push({
      id: str(e, 1),
      header: text(a, 10), description: text(a, 11),
      routes: [...new Set(sel.map(s => str(s, 2)).filter(Boolean))],
      stops: [...new Set(sel.map(s => str(s, 5)).filter(Boolean))].map(id => ({ id, name: D.stops[id] || id })),
      until: periods.map(p => p[1]).filter(t => t !== Infinity && t < 4e9).sort()[0] ?? null,
    });
  }
  return { updatedAt: num(msg(m, 1), 3), alerts: list };
}

// One fetch at a time per feed per isolate, reused for CACHE_MS
const memo: Record<string, { at: number; body: Promise<unknown> }> = {};
function cached(name: keyof typeof FEEDS, build: () => Promise<unknown>) {
  const hit = memo[name];
  if (hit && Date.now() - hit.at < CACHE_MS[name]) return hit.body;
  const body = build();
  memo[name] = { at: Date.now(), body };
  body.catch(() => { if (memo[name]?.body === body) delete memo[name]; });
  return body;
}

/** GET /api/transit/vehicles and /api/transit/alerts */
export async function transit(path: string): Promise<Response> {
  const name = path === "/api/transit/vehicles" ? "vehicles" : path === "/api/transit/alerts" ? "alerts" : null;
  if (!name) return json({ error: "Not found" }, { status: 404 });
  try {
    const body = await cached(name, name === "vehicles" ? vehicles : alerts);
    return json(body, { headers: { "cache-control": `public, max-age=${name === "vehicles" ? 10 : 60}` } });
  } catch (e) {
    console.error(e);
    return json({ error: "Halifax Transit's live data isn't answering right now." }, { status: 502 });
  }
}
