import { describe, expect, it, vi } from "vitest";
import { parseWaterListing, waterCategory, waterDate, waterPageBody, waterPublished } from "../../src/halifax-water";
import { mcp } from "../../src/mcp";
import { alertKind, KINDS } from "../../src/push";
import worker from "../../src/index";
import { env } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// The markup as Halifax Water really serves it, trimmed
const card = (path: string, title: string, when: string, body: string) => `<article about="${path}" class="node node--type-alerts node--display-mode-teaser"> <h2> <a href="${path}" rel="bookmark"><span>${title}</span> </a> </h2> <div class="node__content"> <div class='date-body-image-container'> <div class='date-published'> <span class='field-label'>Published: </span> <span class='field-value'>${when}</span> </div> <div class="field field--name-field-body field--type-text-long field--label-hidden"> <div class="field__item"><p>${body}</p></div></div></div></div></article>`;
const row = (path: string, title: string, at: string) => `<div class="view__row even"> <div class="views-field views-field-title"><span class="field-content"><a href="${path}" hreflang="en">${title}</a></span></div><div class="views-field views-field-changed"><span class="field-content"><time datetime="${at}">9:32 AM | November 4, 2026</time> </span></div> </div>`;
const LISTING = card("/notice/woodys-lane-emergency-water-service-shut-down", "Woodys Lane – Emergency Water Service Shut Down", "2:34 PM | November 2, 2026", "Halifax Water crews have temporarily shut down water service near 19 Woodys Lane.")
  + row("/notice/woodys-lane-emergency-water-service-shut-down", "Woodys Lane – Emergency Water Service Shut Down", "2026-11-02T14:40:00-04:00")
  + row("/notice/traffic-advisory-quinpool-road-1", "Traffic Advisory – Quinpool Road", "2026-11-04T09:32:39-04:00")
  + row("/news/halifax-water-rates-finalized-nsrab", "Halifax Water Rates Finalized &amp; Approved", "2026-02-05T14:25:00-04:00");
const BANNER = `<main><div class="alert"><a href="/alert/seasonal-disinfection">Seasonal Disinfection</a> <time datetime="2025-11-03T09:08:00-04:00">9:08 AM | November 3, 2025</time> Dismiss You have read all of the active alerts View all Alerts</div>`;
const PAGE = `<html>${BANNER}<h1><span>Woodys Lane – Emergency Water Service Shut Down</span> </h1><div>Published: <span>2:34 PM | November 2, 2026</span></div><p>Halifax Water crews have temporarily shut down water service near 19 Woodys Lane, Middle Sackville.</p><h2>Footer menu</h2><p>About Us</p></main></html>`;

describe("reading Halifax Water's listings", () => {
  const items = parseWaterListing(LISTING);
  it("finds every item once, preferring the card over the plain row", () => {
    expect(items.map(i => i.path)).toEqual(["/notice/woodys-lane-emergency-water-service-shut-down", "/notice/traffic-advisory-quinpool-road-1", "/news/halifax-water-rates-finalized-nsrab"]);
    expect(items[0]).toMatchObject({ type: "notice", title: "Woodys Lane – Emergency Water Service Shut Down", publishedAt: "2026-11-02T18:34:00Z" });
    expect(items[0].summary).toContain("19 Woodys Lane");
  });
  it("reads plain rows, with their times and entities", () => {
    expect(items[1]).toMatchObject({ type: "notice", publishedAt: "2026-11-04T13:32:39Z", summary: "" });
    expect(items[2].title).toBe("Halifax Water Rates Finalized & Approved");
  });
  it("reads Halifax's clock in winter and in summer", () => {
    expect(waterDate("2:34 PM | November 2, 2026")).toBe("2026-11-02T18:34:00Z");
    expect(waterDate("9:08 AM | July 2, 2026")).toBe("2026-07-02T12:08:00Z");
    expect(waterDate("12:05 AM | January 1, 2026")).toBe("2026-01-01T04:05:00Z");
    expect(waterDate("12:05 PM | January 1, 2026")).toBe("2026-01-01T16:05:00Z");
    expect(waterDate("soon")).toBeNull();
  });
});

describe("how soon the newsroom gets to it", () => {
  it.each(["Woodys Lane – Emergency Water Service Shut Down", "Gourok Avenue Emergency Water Shut Down", "Boil Water Advisory", "Clifford Drive Water Main Repair", "Traffic Advisory – Quinpool Road", "Water Service Advisory – Aerotech Business Park"])(
    "%s comes first", title => expect(waterCategory({ type: "notice", title })).toBe("right-now"));
  it.each(["Colby Drive Water Valve Repair", "Hollis Street Manhole Repair", "Southwood Drive Third Party Construction Work", "Thanksgiving Long Weekend Service Level Adjustments"])(
    "%s can wait", title => expect(waterCategory({ type: "notice", title })).toBe("decisions"));
  it("puts any alert first and news with decisions", () => {
    expect(waterCategory({ type: "alert", title: "Mandatory restriction" })).toBe("right-now");
    expect(waterCategory({ type: "news", title: "Emergency rates" })).toBe("decisions");
  });
});

describe("reading one page", () => {
  it("starts at the page's own headline, leaving the year-old banner behind", () => {
    const body = waterPageBody(PAGE);
    expect(body).not.toContain("Seasonal Disinfection");
    expect(body.startsWith("<h1")).toBe(true);
  });
  it("takes the page's own date, not the banner's", () => {
    expect(waterPublished(waterPageBody(PAGE))).toBe("2026-11-02T18:34:00Z");
  });
  it("reads the date as a real page marks it up, with its timestamp well past the label", () => {
    const real = `<h1><span>X</span></h1><div class='date-body-image-container'> <div class='date-published'> <span class='field-label'>Published: </span> <span class='field-value'> <div class="field field--name-published-at field--type-published-at field--label-hidden"> <div class="field__item"><time datetime="2026-11-02T14:34:27-04:00">2:34 PM | November 2, 2026</time> </div> </div> </span> </div>`;
    expect(waterPublished(real)).toBe("2026-11-02T18:34:27Z");
  });
});

describe("which alert a notice falls under", () => {
  const s = (headline: string, section = "Halifax Water") => ({ id: "hw-x", section, headline });
  it("boil-water advisories and emergencies are urgent", () => {
    expect(alertKind(s("Boil Water Advisory for Pockwock"))).toBe("safety");
    expect(alertKind(s("Woodys Lane – Emergency Water Service Shut Down"))).toBe("safety");
    expect(alertKind(s("Boil water advisory", "City Hall"))).toBe("safety");
  });
  it("traffic advisories go with roads", () => expect(alertKind(s("Traffic Advisory – Quinpool Road"))).toBe("roads"));
  it("routine work has its own kind, even on a road's name", () => {
    expect(alertKind(s("Beaver Bank Road Water Main Repair"))).toBe("water");
    expect(alertKind(s("Hollis Street Manhole Repair"))).toBe("water");
  });
  it("offers routine water work to readers, but leaves it off unless they choose it", async () => {
    expect(KINDS).toContain("water");
    const d = await (await worker.fetch(new Request("https://site.test/api/push"), env, ctx)).json<{ kinds: { id: string; default: boolean }[] }>();
    expect(d.kinds.find(k => k.id === "water")).toMatchObject({ default: false });
    expect(d.kinds.find(k => k.id === "safety")).toMatchObject({ default: true });
  });
});

describe("the newsroom's tools", () => {
  const call = async (name: string, args: unknown) => {
    const r = await mcp(new Request("https://site/mcp", {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }), { ...env, NEWSROOM_TOKEN: "t" });
    const d = await r.json<{ result: { content: { text: string }[]; isError?: boolean } }>();
    return { error: d.result.isError, text: d.result.content[0].text };
  };
  const recent = new Date(Date.now() - 36e5).toISOString().replace(/\.\d+Z$/, "-00:00");
  const stubWater = (reply: (url: string) => Response) => vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const to = String(url);
    return to.includes("halifaxwater.ca") ? reply(to) : new Response("", { status: 200 });
  });

  it("scan_sources lists Halifax Water, with ids of their own", async () => {
    stubWater(() => new Response(row("/notice/traffic-advisory-quinpool-road-1", "Traffic Advisory – Quinpool Road", recent)));
    const d = JSON.parse((await call("scan_sources", { days: 3 })).text);
    expect(d.unavailable).toBeUndefined();
    expect(d.releases[0]).toMatchObject({ id: "hw-traffic-advisory-quinpool-road-1", source: "halifaxwater.ca", section: "Halifax Water", category: "right-now", status: "new",
      url: "https://www.halifaxwater.ca/notice/traffic-advisory-quinpool-road-1" });
  });
  it("scan_sources says so when Halifax Water can't be read, rather than looking like a quiet day", async () => {
    stubWater(() => new Response("Forbidden", { status: 403 }));
    expect(JSON.parse((await call("scan_sources", { days: 3 })).text).unavailable).toEqual(["halifaxwater.ca"]);
  });
  it("scan_sources copes with more releases than one query can look up", async () => {
    const many = Array.from({ length: 120 }, (_, i) => row(`/notice/repair-${i}`, `Repair ${i}`, recent)).join("");
    stubWater(() => new Response(many));
    expect(JSON.parse((await call("scan_sources", { days: 3 })).text).releases).toHaveLength(120);
  });
  it("read_release gives the notice alone, with the right date and id", async () => {
    stubWater(() => new Response(PAGE));
    const d = JSON.parse((await call("read_release", { url: "https://www.halifaxwater.ca/notice/woodys-lane-emergency-water-service-shut-down" })).text);
    expect(d.id).toBe("hw-woodys-lane-emergency-water-service-shut-down");
    expect(d.published).toBe("2026-11-02T18:34:00Z");
    expect(d.text).toContain("19 Woodys Lane");
    expect(d.text).not.toContain("Seasonal Disinfection");
    expect(d.text).not.toContain("About Us");
  });
  it("read_release still refuses other sites", async () => {
    expect((await call("read_release", { url: "https://evilhalifaxwater.ca/notice/x" })).text).toMatch(/only reads/);
  });
});
