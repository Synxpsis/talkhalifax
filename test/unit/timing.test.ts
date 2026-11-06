import { describe, expect, it } from "vitest";
import { mcp } from "../../src/mcp";
import { STAGE_RULES, evaluateStages } from "../../src/stories";
import { DAY, HOUR, env, iso, makeStory, storyRow } from "./helpers";

const chat = (id: string, msAgo: number, here = 0) =>
  env.DB.prepare("INSERT INTO room_stats (story_id, last_message_at, here_now, updated_at) VALUES (?, ?, ?, ?)").bind(id, Date.now() - msAgo, here, Date.now()).run();
const aged = (age: number, update = age) => ({ developing_since: iso(age), last_newsroom_update: iso(update) });

describe("when a developing story moves to Articles", () => {
  it("moves a day-old story that's gone quiet", async () => {
    await makeStory("quiet", {}, aged(25 * HOUR, 13 * HOUR));
    expect(await evaluateStages(env)).toEqual(["quiet"]);
    const s = await storyRow("quiet");
    expect(s!.stage).toBe("archived");
    expect(s!.archived_at).toBeTruthy();
  });
  it("keeps it under a day old", async () => {
    await makeStory("young", {}, aged(23 * HOUR));
    expect(await evaluateStages(env)).toEqual([]);
  });
  it("keeps it while the newsroom updated it in the last 12 hours", async () => {
    await makeStory("updated", {}, aged(25 * HOUR, 11 * HOUR));
    expect(await evaluateStages(env)).toEqual([]);
  });
  it("keeps it while people chatted in the last 3 hours", async () => {
    await makeStory("chatty", {}, aged(25 * HOUR, 13 * HOUR));
    await chat("chatty", 2 * HOUR);
    expect(await evaluateStages(env)).toEqual([]);
  });
  it("keeps it while someone is in the room", async () => {
    await makeStory("occupied", {}, aged(25 * HOUR, 13 * HOUR));
    await chat("occupied", 4 * HOUR, 1);
    expect(await evaluateStages(env)).toEqual([]);
  });
  it("moves it after a week no matter what", async () => {
    await makeStory("old", {}, aged(STAGE_RULES.MAX_DEVELOPING_MS + HOUR, HOUR));
    await chat("old", 60_000, 3);
    expect(await evaluateStages(env)).toEqual(["old"]);
  });
  it("never moves notices", async () => {
    await makeStory("notice", { kind: "notice" }, aged(30 * DAY));
    expect(await evaluateStages(env)).toEqual([]);
  });
});

async function queue() {
  const token = "test-token";
  const r = await mcp(new Request("https://site/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "checkin_queue", arguments: { limit: 50 } } }),
  }), { ...env, NEWSROOM_TOKEN: token });
  const d = await r.json<{ result: { content: { text: string }[] } }>();
  return JSON.parse(d.result.content[0].text).due as { id: string; live: boolean }[];
}
const dueIds = async () => (await queue()).map(s => s.id).sort();

describe("which stories are due a check-in", () => {
  it("a story that's never been checked", async () => {
    await makeStory("never");
    expect(await dueIds()).toEqual(["never"]);
  });
  it("other stories every 12 hours", async () => {
    await makeStory("recent", {}, { last_checkin_at: iso(11 * HOUR) });
    await makeStory("stale", {}, { last_checkin_at: iso(13 * HOUR) });
    expect(await dueIds()).toEqual(["stale"]);
  });
  it("live weather and outage notices every hour, and first", async () => {
    await makeStory("zz-article", {}, { last_checkin_at: iso(13 * HOUR) });
    await makeStory("ns-power-outages-a", { kind: "notice" }, { last_checkin_at: iso(2 * HOUR) });
    await makeStory("weather-a", { kind: "notice" }, { last_checkin_at: iso(30 * 60_000) });
    const due = await queue();
    expect(due.map(s => s.id)).toEqual(["ns-power-outages-a", "zz-article"]);
    expect(due[0].live).toBe(true);
  });
  it("a live notice that has ended goes back to every 12 hours", async () => {
    await makeStory("weather-over", { kind: "notice", statusLabel: "Ended" }, { last_checkin_at: iso(2 * HOUR) });
    await makeStory("ns-power-outages-over", { kind: "notice", statusLabel: "Restored" }, { last_checkin_at: iso(13 * HOUR) });
    expect(await dueIds()).toEqual(["ns-power-outages-over"]);
  });
  it("skips archived and superseded stories", async () => {
    await makeStory("archived", {}, { stage: "archived" });
    await makeStory("replaced", { supersededBy: "newer" });
    expect(await dueIds()).toEqual([]);
  });
});
