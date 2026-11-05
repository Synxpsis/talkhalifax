// TalkHalifax: the live Transit map. Loaded by app.js the first time someone opens #transit.
// Buses and ferries come from /api/transit/vehicles (Halifax Transit's real-time feed, refreshed every 15 seconds),
// route lines from /transit/shapes.json (built by scripts/build-transit.mjs), alerts from /api/transit/alerts.
// The map is MapLibre GL with OpenFreeMap tiles (no key, OpenStreetMap data).
(function () {
  "use strict";
  const MAPLIBRE = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl";
  const STYLES = { light: "https://tiles.openfreemap.org/styles/positron", dark: "https://tiles.openfreemap.org/styles/dark" };
  const POLL_MS = 15000, GLIDE_MS = 1500;
  const HALIFAX = { center: [-63.585, 44.665], zoom: matchMedia("(max-width: 760px)").matches ? 10.3 : 11.2 };
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  let root, map, timer, glide, ready = false, open = false;
  const T = { vehicles: [], shown: new Map(), alerts: [], routes: [], shapes: {}, route: "", selected: null, updatedAt: 0, error: "" };

  // ---------- loading ----------
  const loadOnce = (() => {
    let p;
    return () => p || (p = new Promise((res, rej) => {
      const css = document.createElement("link");
      css.rel = "stylesheet"; css.href = MAPLIBRE + ".css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = MAPLIBRE + ".js"; js.onload = res; js.onerror = () => { p = null; rej(new Error("The map library didn't load.")); };
      document.head.appendChild(js);
    }));
  })();
  async function getJSON(url) {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
    return d;
  }

  // ---------- text ----------
  /** Halifax Transit's headsigns are in capitals: "320 AIRPORT VIA FALL RIVER" reads as "Airport via Fall River". */
  function headsign(v) {
    let h = String(v.headsign || "").replace(new RegExp("^" + v.short.replace(/[^\w]/g, "") + "\\s+", "i"), "");
    h = h.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase()).replace(/\b(Via|To|And|Of|At)\b/g, w => w.toLowerCase());
    return h.replace(/\bHfx\b/g, "Halifax").replace(/\bTerm\b/g, "Terminal");
  }
  const routeLabel = v => v.type === 4 ? v.name || "Ferry" : `${v.short} ${v.name}`.trim();
  const badge = v => v.type === 4 ? "⛴" : v.short;
  const ago = s => { const d = Math.max(0, Math.round(Date.now() / 1000 - s)); return d < 60 ? `${d} s ago` : `${Math.round(d / 60)} min ago`; };
  const stopName = s => String(s || "").replace(/\s*\(\d+\)$/, "");

  // ---------- page ----------
  function frame() {
    root.innerHTML = `
      <div class="tr-top">
        <div>
          <h1>Transit</h1>
          <p class="tr-status" id="trStatus" role="status">Loading live positions…</p>
        </div>
        <label class="tr-pick"><span class="sr">Route</span>
          <select id="trRoute"><option value="">All routes</option></select>
        </label>
      </div>
      <div class="tr-body">
        <div class="tr-map" id="trMap" role="region" aria-label="Map of Halifax Transit buses and ferries"></div>
        <aside class="tr-side glass" id="trSide" aria-live="polite"></aside>
      </div>
      <p class="tr-foot">Live data: <a href="https://www.halifax.ca/home/open-data" target="_blank" rel="noopener">Halifax Transit open data</a>, refreshed every 15 seconds. Positions can be a minute behind.</p>`;
    root.querySelector("#trRoute").addEventListener("change", e => setRoute(e.target.value));
  }

  function fillRoutes() {
    const sel = root.querySelector("#trRoute");
    if (!sel || sel.options.length > 1) return;
    const groups = [["Ferries", T.routes.filter(r => r.type === 4)], ["Buses", T.routes.filter(r => r.type !== 4)]];
    sel.insertAdjacentHTML("beforeend", groups.map(([label, list]) =>
      `<optgroup label="${label}">${list.map(r => `<option value="${esc(r.id)}">${esc(r.type === 4 ? r.long : r.short + " " + r.long)}</option>`).join("")}</optgroup>`).join(""));
    sel.value = T.route;
  }

  function renderStatus() {
    const el = root?.querySelector("#trStatus"); if (!el) return;
    if (T.error && !T.vehicles.length) { el.textContent = T.error; return; }
    const list = visible();
    const buses = list.filter(v => v.type !== 4).length, ferries = list.length - buses;
    const parts = [];
    if (buses || !ferries) parts.push(`${buses} bus${buses === 1 ? "" : "es"}`);
    if (ferries) parts.push(`${ferries} ferr${ferries === 1 ? "y" : "ies"}`);
    el.textContent = `${parts.join(" and ")} running now${T.updatedAt ? `, updated ${ago(T.updatedAt)}` : ""}${T.error ? ". Couldn't refresh just now" : ""}`;
  }

  function renderSide() {
    const side = root?.querySelector("#trSide"); if (!side) return;
    const v = T.selected && T.vehicles.find(x => x.id === T.selected);
    const route = v ? v.route : T.route;
    const alerts = route ? T.alerts.filter(a => a.routes.includes(route)) : [];
    let html = "";
    if (v) {
      html += `
        <div class="tr-v">
          <span class="tr-badge${v.type === 4 ? " ferry" : ""}">${esc(badge(v))}</span>
          <div><b>${esc(routeLabel(v))}</b><span>${esc(headsign(v) || "Not in service")}</span></div>
          <button type="button" class="tr-x" id="trClose" aria-label="Close">×</button>
        </div>
        <dl class="tr-dl">
          ${v.next ? `<div><dt>Next stop</dt><dd>${esc(v.next.status[0].toUpperCase() + v.next.status.slice(1))} ${esc(stopName(v.next.stop))}</dd></div>` : ""}
          ${v.kmh != null ? `<div><dt>Speed</dt><dd>${v.kmh} km/h</dd></div>` : ""}
          ${v.occupancy ? `<div><dt>Seats</dt><dd>${esc(v.occupancy[0].toUpperCase() + v.occupancy.slice(1))}</dd></div>` : ""}
          <div><dt>Last report</dt><dd>${esc(ago(v.seen))}</dd></div>
          <div><dt>Vehicle</dt><dd>${esc(v.label)}</dd></div>
        </dl>
        ${T.route !== v.route ? `<button type="button" class="tr-btn" id="trOnly">Show only ${esc(v.type === 4 ? v.name : "route " + v.short)}</button>` : ""}`;
    } else if (T.route) {
      const r = T.routes.find(x => x.id === T.route);
      html += `<div class="tr-v"><span class="tr-badge${r?.type === 4 ? " ferry" : ""}">${esc(r?.type === 4 ? "⛴" : r?.short)}</span><div><b>${esc(r ? (r.type === 4 ? r.long : r.short + " " + r.long) : T.route)}</b><span>${visible().length} running now</span></div></div>
        <button type="button" class="tr-btn" id="trAll">Show all routes</button>`;
    } else {
      html += `<p class="tr-hint">Tap a bus or ferry to see where it's going, or pick a route.</p>`;
    }
    if (route) html += alerts.length
      ? `<h2 class="tr-h">Service alerts</h2><ul class="tr-alerts">${alerts.slice(0, 6).map(a => `<li><b>${esc(a.header)}</b>${a.description && a.description !== a.header ? `<span>${esc(a.description)}</span>` : ""}</li>`).join("")}</ul>${alerts.length > 6 ? `<p class="tr-hint">And ${alerts.length - 6} more.</p>` : ""}`
      : `<p class="tr-hint">No service alerts for this route.</p>`;
    side.innerHTML = html;
    side.querySelector("#trClose")?.addEventListener("click", () => select(null));
    side.querySelector("#trOnly")?.addEventListener("click", () => setRoute(v.route));
    side.querySelector("#trAll")?.addEventListener("click", () => setRoute(""));
  }

  // ---------- map ----------
  const visible = () => T.route ? T.vehicles.filter(v => v.route === T.route) : T.vehicles;
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  /** A round marker with a pointer for the direction of travel, drawn once per colour. */
  function markerImage(fill, ring) {
    const s = 2, size = 30 * s, c = document.createElement("canvas");
    c.width = c.height = size;
    const g = c.getContext("2d"), mid = size / 2;
    g.fillStyle = fill; g.strokeStyle = ring; g.lineWidth = 2 * s;
    g.beginPath(); g.moveTo(mid, 1 * s); g.lineTo(mid + 6 * s, 9 * s); g.lineTo(mid - 6 * s, 9 * s); g.closePath(); g.fill();
    g.beginPath(); g.arc(mid, mid, 10.5 * s, 0, Math.PI * 2); g.fill(); g.stroke();
    return { width: size, height: size, data: g.getImageData(0, 0, size, size).data };
  }

  function addLayers() {
    const ink = css("--ink") || "#121417", page = css("--surface-page") || "#f5f6f7", ferry = css("--signal-ok") || "#1d6a86";
    map.addImage("th-bus", markerImage(ink, page), { pixelRatio: 2 });
    map.addImage("th-ferry", markerImage(ferry, page), { pixelRatio: 2 });
    map.addSource("th-lines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "th-lines", type: "line", source: "th-lines", layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": ink, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 5], "line-opacity": 0.8 } });
    map.addSource("th-vehicles", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({ id: "th-vehicles", type: "symbol", source: "th-vehicles", layout: {
      "icon-image": ["case", ["==", ["get", "type"], 4], "th-ferry", "th-bus"],
      "icon-rotate": ["coalesce", ["get", "bearing"], 0], "icon-rotation-alignment": "map",
      "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-size": ["interpolate", ["linear"], ["zoom"], 10, 0.75, 14, 1.05],
      "text-field": ["get", "badge"], "text-font": ["Noto Sans Bold"], "text-size": ["interpolate", ["linear"], ["zoom"], 10, 8, 14, 10.5],
      "text-allow-overlap": true, "text-ignore-placement": true,
    }, paint: { "text-color": page, "icon-opacity": ["case", ["get", "dim"], 0.35, 1], "text-opacity": ["case", ["get", "dim"], 0.35, 1] } });
    ready = true;
    drawLines(); drawVehicles(1); fitRoute(false);
  }

  function decodeLine(str) {
    const pts = []; let i = 0, lat = 0, lon = 0;
    const one = () => { let r = 0, s = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20); return r & 1 ? ~(r >> 1) : r >> 1; };
    while (i < str.length) { lat += one(); lon += one(); pts.push([lon / 1e5, lat / 1e5]); }
    return pts;
  }

  function drawLines() {
    if (!ready) return;
    const v = T.selected && T.vehicles.find(x => x.id === T.selected);
    const ids = v?.shape ? [v.shape] : T.route ? (T.routes.find(r => r.id === T.route)?.shapes || []) : [];
    map.getSource("th-lines").setData({ type: "FeatureCollection", features: ids.filter(id => T.shapes[id]).map(id => ({
      type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: decodeLine(T.shapes[id]) } })) });
  }

  /** Move each marker from where it was to where it is now over GLIDE_MS. */
  function drawVehicles(progress) {
    if (!ready) return;
    const features = [];
    for (const v of T.vehicles) {
      if (T.route && v.route !== T.route) continue;
      const from = T.shown.get(v.id) || v, t = Math.min(1, progress);
      const lon = from.lon + (v.lon - from.lon) * t, lat = from.lat + (v.lat - from.lat) * t;
      features.push({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] },
        properties: { id: v.id, type: v.type, bearing: v.bearing, badge: v.type === 4 ? "" : v.short, dim: !!T.selected && T.selected !== v.id } });
    }
    map.getSource("th-vehicles").setData({ type: "FeatureCollection", features });
  }

  function glideTo(next) {
    cancelAnimationFrame(glide);
    // Start each glide from where the marker is drawn now
    const start = performance.now(), prev = new Map(T.vehicles.map(v => [v.id, v]));
    T.shown = prev; T.vehicles = next;
    const step = now => {
      const p = (now - start) / GLIDE_MS;
      drawVehicles(p);
      if (p < 1) glide = requestAnimationFrame(step);
      else T.shown = new Map(next.map(v => [v.id, v]));
    };
    glide = requestAnimationFrame(step);
  }

  function select(id) {
    T.selected = id;
    drawLines(); drawVehicles(1); renderSide();
  }

  function setRoute(id) {
    T.route = id; T.selected = null;
    const sel = root.querySelector("#trRoute"); if (sel) sel.value = id;
    drawLines(); drawVehicles(1); renderSide(); renderStatus();
    try { history.replaceState(null, "", "#transit" + (id ? "-" + encodeURIComponent(id) : "")); } catch (e) {}
    fitRoute(true);
  }

  function fitRoute(animate) {
    if (!ready) return;
    const id = T.route;
    const coords = id ? (T.routes.find(r => r.id === id)?.shapes || []).flatMap(s => T.shapes[s] ? decodeLine(T.shapes[s]) : []) : [];
    if (coords.length) {
      const b = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(b, { padding: { top: 40, right: 60, bottom: 70, left: 40 }, maxZoom: 13.5, duration: animate ? 600 : 0 });
    } else if (!id && animate) map.easeTo({ ...HALIFAX, duration: 600 });
  }

  // ---------- data ----------
  async function poll() {
    if (!open || document.hidden) return;
    try {
      const d = await getJSON("/api/transit/vehicles");
      T.error = ""; T.updatedAt = d.updatedAt;
      if (T.selected && !d.vehicles.some(v => v.id === T.selected)) T.selected = null;
      glideTo(d.vehicles);
      renderSide();
    } catch (e) { T.error = e.message; }
    renderStatus();
  }
  async function loadAlerts() {
    try { T.alerts = (await getJSON("/api/transit/alerts")).alerts; renderSide(); } catch (e) {}
  }

  function makeMap() {
    map = new maplibregl.Map({ container: root.querySelector("#trMap"), style: dark.matches ? STYLES.dark : STYLES.light, ...HALIFAX,
      attributionControl: { compact: true } });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false }, trackUserLocation: false }), "top-right");
    map.on("style.load", addLayers);
    map.on("click", "th-vehicles", e => select(e.features[0].properties.id));
    map.on("mouseenter", "th-vehicles", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "th-vehicles", () => { map.getCanvas().style.cursor = ""; });
    map.on("click", e => { if (ready && T.selected && !map.queryRenderedFeatures(e.point, { layers: ["th-vehicles"] }).length) select(null); });
    dark.addEventListener("change", () => { ready = false; map.setStyle(dark.matches ? STYLES.dark : STYLES.light); });
  }

  window.THTransit = {
    async open(el, route) {
      open = true;
      if (root !== el) { root = el; frame(); }
      renderSide(); renderStatus();
      try {
        const [shapes] = await Promise.all([T.routes.length ? null : getJSON("/transit/shapes.json"), loadOnce()]);
        if (shapes) { T.routes = shapes.routes; T.shapes = shapes.shapes; }
        fillRoutes();
        if (route !== T.route) setRoute(route);
        if (!map) makeMap(); else map.resize();
      } catch (e) {
        root.querySelector("#trStatus").textContent = e.message || "The map couldn't load.";
        return;
      }
      clearInterval(timer);
      poll(); loadAlerts();
      timer = setInterval(poll, POLL_MS);
    },
    close() { open = false; clearInterval(timer); cancelAnimationFrame(glide); },
  };
  document.addEventListener("visibilitychange", () => { if (open && !document.hidden) poll(); });

  // ---------- styles (only this page uses them) ----------
  const style = document.createElement("style");
  style.textContent = `
    #transit { padding-bottom: 24px; }
    .tr-top { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px 20px; flex-wrap: wrap; margin-bottom: 14px; }
    .tr-top h1 { font-family: var(--f-display); font-weight: 700; font-size: 32px; line-height: 1.08; letter-spacing: -.025em; margin: 0 0 4px; }
    .tr-status { margin: 0; color: var(--muted); font-size: 14px; font-variant-numeric: tabular-nums; }
    .tr-pick select { font: inherit; font-size: 14.5px; color: var(--ink); background: var(--field); border: 1px solid var(--glass-edge); border-radius: var(--radius-s); padding: 9px 34px 9px 12px; min-height: 44px; max-width: min(320px, 100%); }
    .tr-body { display: grid; grid-template-columns: 1fr 320px; gap: 16px; height: calc(100dvh - var(--hdr, 64px) - 170px); min-height: 420px; }
    .tr-map { border-radius: var(--radius-l); overflow: hidden; border: 1px solid var(--glass-edge); background: var(--surface-sunken); min-height: 0; }
    .tr-side { border-radius: var(--radius-l); padding: 16px; overflow: auto; font-size: 14px; }
    .tr-v { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .tr-v > div { flex: 1; min-width: 0; }
    .tr-v b { display: block; font-size: 15px; }
    .tr-v span { display: block; color: var(--muted); }
    .tr-badge { flex: none; min-width: 40px; height: 40px; padding: 0 8px; border-radius: 999px; display: inline-flex !important; align-items: center; justify-content: center; background: var(--ink); color: var(--surface-page) !important; font-weight: 700; font-size: 14px; }
    .tr-badge.ferry { background: var(--ok); }
    .tr-x { all: unset; cursor: pointer; width: 44px; height: 44px; display: grid; place-items: center; font-size: 22px; color: var(--muted); border-radius: 999px; }
    .tr-x:focus-visible, .tr-btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .tr-dl { margin: 0 0 12px; display: grid; gap: 8px; }
    .tr-dl div { display: grid; grid-template-columns: 96px 1fr; gap: 8px; }
    .tr-dl dt { color: var(--muted); } .tr-dl dd { margin: 0; }
    .tr-btn { font: inherit; font-weight: 600; font-size: 14px; color: var(--ink); background: var(--field); border: 1px solid var(--glass-edge); border-radius: 999px; padding: 0 16px; min-height: 44px; cursor: pointer; }
    .tr-h { font-size: 12px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: 18px 0 8px; }
    .tr-alerts { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
    .tr-alerts b { display: block; font-weight: 600; } .tr-alerts span { color: var(--muted); }
    .tr-hint { color: var(--muted); margin: 0 0 8px; }
    .tr-foot { margin: 12px 0 0; font-size: 12.5px; color: var(--muted); }
    .tr-foot a { color: inherit; }
    .maplibregl-ctrl-group { background: var(--field) !important; }
    @media (max-width: 760px) {
      .tr-body { grid-template-columns: 1fr; grid-template-rows: 1fr auto; height: calc(100dvh - var(--hdr, 56px) - 150px); min-height: 380px; gap: 10px; }
      .tr-side { max-height: 38dvh; padding: 14px; }
      .tr-top h1 { font-size: 28px; }
      .tr-pick, .tr-pick select { width: 100%; max-width: none; }
    }`;
  document.head.appendChild(style);
})();
