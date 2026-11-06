import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { feelsLike, getWeather, refreshWeather, weatherIcon } from "../../src/weather";
import { env } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const v = (n: number) => ({ value: { en: n, fr: n } });
const feed = (over: Record<string, unknown> = {}) => ({ features: [{ properties: {
  url: { en: "https://weather.gc.ca/en/location/index.html?coords=44.65,-63.6" }, lastUpdated: "2026-11-06T13:39:14Z",
  currentConditions: { condition: { en: "Mist" }, temperature: v(14.4), iconCode: { value: 24 }, timestamp: { en: "2026-11-06T13:36:00Z" },
    station: { value: { en: "Halifax Stanfield Int'l Airport" } }, ...over },
} }] });
const stub = (reply: () => Response) => vi.stubGlobal("fetch", async (url: string | URL | Request) => {
  expect(String(url)).toContain("api.weather.gc.ca");
  return reply();
});

describe("how it feels", () => {
  it("is the wind chill in the cold", () => expect(feelsLike(-5, -14, null)).toBe(-14));
  it("is the humidex in the heat", () => expect(feelsLike(27, null, 34)).toBe(34));
  it("is the temperature when neither is published", () => expect(feelsLike(14.4, null, null)).toBe(14.4));
  it("ignores a wind chill that can't apply: -6 at 14.4 C, as the feed really said", () => expect(feelsLike(14.4, -6, null)).toBe(14.4));
  it("ignores a humidex that can't apply", () => {
    expect(feelsLike(5, null, 30)).toBe(5);
    expect(feelsLike(25, null, 20)).toBe(25);
  });
  it("ignores a wind chill warmer than the air", () => expect(feelsLike(2, 6, null)).toBe(2));
});

describe("the icon", () => {
  it.each([["Sunny", "clear"], ["Clear", "clear"], ["Mainly Sunny", "partly"], ["Partly Cloudy", "partly"], ["A few clouds", "partly"], ["Mostly Cloudy", "cloud"], ["Cloudy", "cloud"],
    ["Light Rain", "rain"], ["Rain Shower", "rain"], ["Drizzle", "rain"], ["Light Snow", "snow"], ["Flurries", "snow"], ["Freezing Rain", "rain"], ["Thunderstorm", "storm"],
    ["Mist", "fog"], ["Fog", "fog"], ["Something new", "cloud"]])("%s shows %s", (condition, icon) => expect(weatherIcon(condition)).toBe(icon));
});

describe("the feed", () => {
  it("reads Environment Canada's current conditions, rounded", async () => {
    stub(() => new Response(JSON.stringify(feed({ windChill: v(-6) }))));
    expect(await refreshWeather(env)).toMatchObject({
      condition: "Mist", tempC: 14, feelsLikeC: 14, icon: "fog", night: false, observedAt: "2026-11-06T13:36:00Z",
      station: "Halifax Stanfield Int'l Airport", url: "https://weather.gc.ca/en/location/index.html?coords=44.65,-63.6",
    });
  });
  it("knows night from Environment Canada's icon code", async () => {
    stub(() => new Response(JSON.stringify(feed({ condition: { en: "Clear" }, iconCode: { value: 30 } }))));
    expect(await refreshWeather(env)).toMatchObject({ icon: "clear", night: true });
  });
  it("keeps the last reading when a refresh fails, and the failure reaches the cron", async () => {
    stub(() => new Response(JSON.stringify(feed())));
    await refreshWeather(env);
    stub(() => new Response("down", { status: 503 }));
    await expect(refreshWeather(env)).rejects.toThrow(/503/);
    expect((await getWeather(env, ctx)).tempC).toBe(14);
  });
  it("refuses a reading with no temperature rather than making one up", async () => {
    stub(() => new Response(JSON.stringify(feed({ temperature: {} }))));
    await expect(refreshWeather(env)).rejects.toThrow(/no current temperature/);
  });
  it("answers with nothing, not an error, when there's no reading at all", async () => {
    stub(() => new Response("down", { status: 503 }));
    const r = await worker.fetch(new Request("https://site.test/api/weather"), env, ctx);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ weather: null });
  });
});
