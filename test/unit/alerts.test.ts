import { describe, expect, it, vi } from "vitest";
import { getAlerts, refreshAlerts } from "../../src/alerts";
import { env } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const warning = { properties: { url: { en: "https://weather.gc.ca/halifax" }, lastUpdated: "2026-11-05T12:00:00Z", warnings: [
  { events: [{ type: { en: "warning" }, description: { en: "Wind warning" }, expiryTime: { en: "2026-11-06T12:00:00Z" } }] },
  { events: [{ type: { en: "statement" }, description: { en: "Special weather statement" } }] },
] } };

/** Environment Canada answers with these warnings; any other request fails the test. */
function stubEccc(reply: () => Response) {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const to = String(url instanceof Request ? url.url : url);
    asked.push(to);
    if (!to.includes("api.weather.gc.ca")) throw new Error(`Unexpected request to ${to}`);
    return reply();
  });
  return asked;
}
const ok = () => new Response(JSON.stringify({ features: [warning] }));

describe("weather warnings", () => {
  it("come from Environment Canada alone, as it words them", async () => {
    const asked = stubEccc(ok);
    const body = await refreshAlerts(env);
    expect(asked).toHaveLength(1);
    expect(body.items.map(i => [i.cat, i.kind, i.title])).toEqual([["Weather", "Warning", "Wind warning"], ["Weather", "Statement", "Special weather statement"]]);
    expect(body.items[0].url).toBe("https://weather.gc.ca/halifax");
    expect((await getAlerts(env, ctx)).items).toHaveLength(2);
  });
  it("stay up when a refresh fails, and the failure reaches the cron", async () => {
    stubEccc(ok);
    await refreshAlerts(env);
    stubEccc(() => new Response("down", { status: 503 }));
    await expect(refreshAlerts(env)).rejects.toThrow(/503/);
    expect((await getAlerts(env, ctx)).items).toHaveLength(2);
  });
});
