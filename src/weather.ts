import { Env } from "./env";

// Environment and Climate Change Canada city page for Halifax, and DFO tide predictions for the Halifax station.
const ECCC = "https://api.weather.gc.ca/collections/citypageweather-realtime/items?f=json&identifier=ns-19";
const DFO_STATION = "5cebf1df3d0f4a073c4bbcbb";
const STALE_MS = 45 * 60_000;

const en = (v: any) => (v && typeof v === "object" && "en" in v ? v.en : v);

export async function fetchWeather() {
  const res = await fetch(ECCC, { headers: { "user-agent": "TalkHalifax (Cloudflare Worker)" } });
  if (!res.ok) throw new Error(`ECCC ${res.status}`);
  const p = (await res.json<any>()).features[0].properties;
  const c = p.currentConditions || {};
  const wind = c.wind || {};
  const now = Date.now();

  let tides: { at: string; m: number; kind: "high" | "low" }[] = [];
  try {
    const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, "Z");
    const url = `https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/${DFO_STATION}/data?time-series-code=wlp-hilo&from=${iso(now - 3 * 36e5)}&to=${iso(now + 30 * 36e5)}`;
    const pts = await (await fetch(url)).json<{ eventDate: string; value: number }[]>();
    tides = pts.map((t, i) => {
      const nb = [pts[i - 1], pts[i + 1]].filter(Boolean).map(x => x.value);
      return { at: t.eventDate, m: Math.round(t.value * 100) / 100, kind: nb.every(v => t.value > v) ? "high" : "low" };
    });
  } catch { /* tides are a nice-to-have */ }

  return {
    updatedAt: new Date(now).toISOString(),
    source: "Environment and Climate Change Canada; Fisheries and Oceans Canada (tides)",
    current: {
      condition: en(c.condition) || "",
      tempC: en(c.temperature?.value) ?? null,
      windKmh: en(wind.speed?.value) ?? null,
      gustKmh: en(wind.gust?.value) ?? null,
      windDir: en(wind.direction?.value) || "",
    },
    forecasts: (p.forecastGroup?.forecasts || []).slice(0, 3).map((f: any) => ({ period: en(f.period?.textForecastName), summary: en(f.textSummary) })),
    sunrise: en(p.riseSet?.sunrise) || null,
    sunset: en(p.riseSet?.sunset) || null,
    tides,
  };
}

export async function refreshWeather(env: Env) {
  const body = await fetchWeather();
  await env.DB.prepare(
    "INSERT INTO feeds (name, body, updated_at) VALUES ('weather', ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at",
  ).bind(JSON.stringify(body), body.updatedAt).run();
  return body;
}

/** Stored weather; refreshed in the background when older than 45 minutes (covers local dev, where cron doesn't run). */
export async function getWeather(env: Env, ctx: ExecutionContext) {
  const row = await env.DB.prepare("SELECT body, updated_at FROM feeds WHERE name = 'weather'").first<{ body: string; updated_at: string }>();
  if (!row) return await refreshWeather(env).catch(() => null);
  if (Date.now() - Date.parse(row.updated_at) > STALE_MS) ctx.waitUntil(refreshWeather(env).catch(() => {}));
  return JSON.parse(row.body);
}
