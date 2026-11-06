import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { saveStory } from "../../src/stories";
import { env, makeStory, storyInput, withTelegram } from "./helpers";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("what to do and subheadings", () => {
  it("keeps a story's actions and gives them to readers", async () => {
    await makeStory("fields-actions", { actions: ["Apply by Friday."], body: ["First.", "## A subheading", "Second."] });
    const r = await worker.fetch(new Request("https://site.test/api/stories/fields-actions"), env, ctx);
    const { story } = await r.json<{ story: { actions: string[]; means: string[]; body: string[] } }>();
    expect(story.actions).toEqual(["Apply by Friday."]);
    expect(story.means).toEqual([]);
    expect(story.body[1]).toBe("## A subheading");
  });
  it("gives a story with none an empty list, so older ones still read", async () => {
    await makeStory("fields-none", { means: ["An older point."] });
    const r = await worker.fetch(new Request("https://site.test/api/stories/fields-none"), env, ctx);
    const { story } = await r.json<{ story: { actions: string[]; means: string[] } }>();
    expect(story.actions).toEqual([]);
    expect(story.means).toEqual(["An older point."]);
  });
  it("shows the editor the actions and subheadings on Telegram, with the real source", async () => {
    const tg = withTelegram(), sent: string[] = [];
    const reply = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => { sent.push(String(init?.body)); return reply(url, init); });
    await saveStory(tg, "fields-telegram", storyInput({ actions: ["Apply by Friday."], body: ["First.", "## A subheading"], source: "https://www.halifaxwater.ca/notice/x" }), { mode: "create", author: "test" });
    const text = JSON.parse(sent[0]).text as string;
    expect(text).toContain("<b>What to do</b>");
    expect(text).toContain("Apply by Friday.");
    expect(text).toContain("<b>A subheading</b>");
    expect(text).not.toContain("## ");
    expect(text).toContain("halifaxwater.ca");
    vi.unstubAllGlobals();
  });
});
