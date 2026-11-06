import { Env } from "./env";

// The small weather line in the header and the phone menu: Environment Canada's current conditions for Halifax.
const ECCC = "https://api.weather.gc.ca/collections/citypageweather-realtime/items?f=json&identifier=ns-19";
const FALLBACK_URL = "https://weather.gc.ca/en/location/index.html?coords=44.65,-63.6";
const STALE_MS = 45 * 60_000;
// Wind chill only applies in the cold and humidex only in the heat. The feed can carry an old value outside those ranges
// (a wind chill of -6 at 14.4 C on Nov. 6, 2026), and we shouldn't print that as how it feels.
const WIND_CHILL_MAX_C = 10, HUMIDEX_MIN_C = 20;

const en = (v: any) => (v && typeof v === "object" && "en" in v ? v.en : v);
const num = (v: any) => (typeof en(v) === "number" ? (en(v) as number) : null);

/** Environment Canada's wind chill or humidex when it applies at this temperature, otherwise the temperature. */
export function feelsLike(tempC: number, windChill: number | null, humidex: number | null) {
  if (windChill !== null && tempC <= WIND_CHILL_MAX_C && windChill < tempC) return windChill;
  if (humidex !== null && tempC >= HUMIDEX_MIN_C && humidex > tempC) return humidex;
  return tempC;
}

/** Which icon suits Environment Canada's wording. */
export function weatherIcon(condition: string) {
  const c = condition.toLowerCase();
  if (/thunder/.test(c)) return "storm";
  if (/snow|flurr|ice|hail|blizzard/.test(c)) return "snow";
  if (/rain|shower|drizzle|precipitation/.test(c)) return "rain";
  if (/fog|mist|haze|smoke/.test(c)) return "fog";
  if (/partly|mainly|few clouds|increasing|decreasing/.test(c)) return "partly";
  if (/cloud|overcast/.test(c)) return "cloud";
  if (/sun|clear/.test(c)) return "clear";
  return "cloud";
}

export async function fetchWeather() {
  const r = await fetch(ECCC, { headers: { "user-agent": "TalkHalifax (Cloudflare Worker)" } });
  if (!r.ok) throw new Error(`Environment Canada ${r.status}`);
  const p = (await r.json<any>()).features[0].properties;
  const c = p.currentConditions || {};
  const tempC = num(c.temperature?.value);
  if (tempC === null) throw new Error("Environment Canada: no current temperature");
  const code = Number(c.iconCode?.value);
  const condition = String(en(c.condition) || "");
  return {
    updatedAt: new Date().toISOString(),
    observedAt: String(en(c.timestamp) || p.lastUpdated || ""),
    station: String(en(c.station?.value) || ""),
    condition, tempC: Math.round(tempC),
    feelsLikeC: Math.round(feelsLike(tempC, num(c.windChill?.value), num(c.humidex?.value))),
    icon: weatherIcon(condition),
    night: code >= 30 && code <= 39,   // Environment Canada's night icon codes
    url: String(en(p.url) || FALLBACK_URL),
  };
}

/** The cron's job. A failed fetch throws, so the last reading stays and the editor hears after two failed runs. */
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
