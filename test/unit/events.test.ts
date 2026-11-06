import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { checkEvents, events, ingestEvents } from "../../src/events";
import { env } from "./helpers";

const e = { ...env, EVENTS_TOKEN: "right" } as Env;
const soon = new Date(Date.now() + 864e5).toISOString(), past = new Date(Date.now() - 864e5).toISOString();
const item = (id: string, start: string) => `<item><title><![CDATA[Story Time &amp; Songs]]></title><link>https://halifax.bibliocommons.com/events/${id}</link>
  <bc:start_date>${start}</bc:start_date><category>Kids</category><category>Music</category><description>Come along.<hr>Ages 3+</description>
  <bc:location><bc:name>Central Library</bc:name><bc:city>Halifax</bc:city></bc:location></item>`;
const post = (body: unknown, token = "right") => ingestEvents(new Request("https://site/api/events/ingest", {
  method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
}), e);
const good = { from: "2026-11-05", to: "2026-11-19", pages: [`<rss>${item("a", soon)}${item("b", past)}${item("a", soon)}</rss>`] };

describe("library events from the GitHub Action", () => {
  it("need the token", async () => {
    expect((await post(good, "wrong")).status).toBe(401);
    expect((await ingestEvents(new Request("https://site/x", { method: "POST", body: "{}" }), env)).status).toBe(401);
  });
  it("are parsed as the library lists them: no repeats, nothing already over", async () => {
    expect(await (await post(good)).json()).toMatchObject({ events: 1 });
    const d = await (await events(env)).json<{ events: unknown[] }>();
    expect(d.events).toHaveLength(1);
    expect(d.events[0]).toMatchObject({ id: "a", title: "Story Time & Songs", place: "Central Library", audiences: ["Kids"], highlight: true, summary: "Come along." });
  });
  it("keep the last good list when a run comes back empty or malformed", async () => {
    await post(good);
    expect((await post({ ...good, pages: ["<rss></rss>"] })).status).toBe(422);
    expect((await post({ from: "soon", to: "later", pages: ["<rss>"] })).status).toBe(400);
    expect((await post({ ...good, pages: Array(41).fill("x") })).status).toBe(400);
    expect((await (await events(env)).json<{ events: unknown[] }>()).events).toHaveLength(1);
  });
  it("say so when none have arrived yet", async () => {
    expect((await events(env)).status).toBe(503);
  });
  it("warn the editor through the cron when they stop arriving", async () => {
    await expect(checkEvents(env)).rejects.toThrow(/never arrived/);
    await post(good);
    await expect(checkEvents(env)).resolves.toBeUndefined();
    await env.DB.prepare("UPDATE feeds SET updated_at = ? WHERE name = 'events'").bind(new Date(Date.now() - 27 * 36e5).toISOString()).run();
    await expect(checkEvents(env)).rejects.toThrow(/haven't arrived/);
  });
});
