// Builds the Transit map's fixed data from Halifax Transit's GTFS schedule (https://gtfs.halifax.ca/static/google_transit.zip).
// Run it when Halifax Transit publishes a new schedule (a few times a year; the feed's end date is in the output):
//   node scripts/build-transit.mjs
// Writes:
//   src/transit-data.json     for the Worker: routes, each trip's headsign and shape, stop names
//   public/transit/shapes.json for the page: each route's lines, simplified and polyline-encoded
import { writeFileSync, mkdirSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const URL_ = "https://gtfs.halifax.ca/static/google_transit.zip";
const TOLERANCE = 0.00008; // about 8 m: keeps the lines on the streets at city zoom, drops 90%+ of the points

// ---------- zip and csv, just enough for a GTFS file ----------
function unzip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n--;) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42), name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8").replace(/^﻿/, "");
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

function csv(text) {
  const rows = [];
  let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.length > 1);
  return body.map(r => Object.fromEntries(head.map((h, i) => [h.trim(), (r[i] ?? "").trim()])));
}

// ---------- lines ----------
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    let worst = -1, at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > worst) { worst = d; at = i; }
    }
    if (worst > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Google's encoded polyline format, lat/lon at 5 decimals. */
function encode(pts) {
  let out = "", plat = 0, plon = 0;
  const one = v => { v = v < 0 ? ~(v << 1) : v << 1; while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } out += String.fromCharCode(v + 63); };
  for (const [lat, lon] of pts) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    one(a - plat); one(b - plon); plat = a; plon = b;
  }
  return out;
}

// ---------- build ----------
const res = await fetch(URL_);
if (!res.ok) throw new Error(`${URL_}: ${res.status}`);
const f = unzip(Buffer.from(await res.arrayBuffer()));
const info = csv(f["feed_info.txt"] || "")[0] || {};
const routes = csv(f["routes.txt"]), trips = csv(f["trips.txt"]), stops = csv(f["stops.txt"]);

const points = {};
for (const s of csv(f["shapes.txt"])) (points[s.shape_id] ??= []).push([+s.shape_pt_sequence, +s.shape_pt_lat, +s.shape_pt_lon]);

const headsigns = [], hsIndex = new Map(), shapeIds = [], shIndex = new Map();
const idx = (list, map, v) => { if (!map.has(v)) { map.set(v, list.length); list.push(v); } return map.get(v); };
const routeShapes = {};
const tripData = {};
for (const t of trips) {
  tripData[t.trip_id] = [idx(headsigns, hsIndex, t.trip_headsign), idx(shapeIds, shIndex, t.shape_id)];
  (routeShapes[t.route_id] ??= new Set()).add(t.shape_id);
}

const worker = {
  source: URL_, feedVersion: info.feed_version || "", feedEnd: info.feed_end_date || "", built: new Date().toISOString().slice(0, 10),
  // route id -> [short name, long name, GTFS route_type (3 bus, 4 ferry)]
  routes: Object.fromEntries(routes.map(r => [r.route_id, [r.route_short_name, r.route_long_name, +r.route_type]])),
  headsigns, shapeIds,
  // trip id -> [headsign index, shape index]
  trips: tripData,
  stops: Object.fromEntries(stops.map(s => [s.stop_id, s.stop_name])),
};

const lines = {};
for (const id of shapeIds) {
  const pts = (points[id] || []).sort((a, b) => a[0] - b[0]).map(p => [p[1], p[2]]);
  lines[id] = encode(simplify(pts, TOLERANCE));
}
const page = {
  source: URL_, feedEnd: worker.feedEnd,
  routes: routes.map(r => ({ id: r.route_id, short: r.route_short_name, long: r.route_long_name, type: +r.route_type, shapes: [...(routeShapes[r.route_id] || [])] }))
    .sort((a, b) => a.type - b.type || a.short.localeCompare(b.short, "en", { numeric: true })),
  shapes: lines,
};

mkdirSync("public/transit", { recursive: true });
writeFileSync("src/transit-data.json", JSON.stringify(worker));
writeFileSync("public/transit/shapes.json", JSON.stringify(page));
const kb = s => (Buffer.byteLength(JSON.stringify(s)) / 1024).toFixed(0) + " KB";
console.log(`Halifax Transit ${worker.feedVersion} (until ${worker.feedEnd}): ${routes.length} routes, ${trips.length} trips, ${stops.length} stops, ${shapeIds.length} shapes`);
console.log(`src/transit-data.json ${kb(worker)}, public/transit/shapes.json ${kb(page)}`);
