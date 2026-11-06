import { describe, expect, it } from "vitest";
import { NewsroomError, reviewDraft, reviewUpdate, saveStory } from "../../src/stories";
import { env, makeStory, storyInput, storyRow, withTelegram } from "./helpers";

const pending = (ref: unknown) => Number(String(ref).slice(1));

describe("new stories", () => {
  it("publish straight away when Telegram isn't set up", async () => {
    expect((await saveStory(env, "a", storyInput(), { mode: "create" })).stage).toBe("developing");
  });
  it("wait for the editor once it is, if they're articles", async () => {
    expect((await saveStory(withTelegram(), "a", storyInput(), { mode: "create" })).stage).toBe("draft");
  });
  it("go live at once if they're notices", async () => {
    expect((await saveStory(withTelegram(), "n", storyInput({ kind: "notice" }), { mode: "create" })).stage).toBe("developing");
  });
  it("wait when the journalist asks for review, even a notice", async () => {
    expect((await saveStory(withTelegram(), "n", storyInput({ kind: "notice" }), { mode: "create", review: true })).stage).toBe("draft");
  });
  it("go live when approved, and stay gone when discarded", async () => {
    const e = withTelegram();
    await saveStory(e, "yes", storyInput(), { mode: "create" });
    await saveStory(e, "no", storyInput(), { mode: "create" });
    expect(await reviewDraft(e, "yes", "approve")).toBe(true);
    expect(await reviewDraft(e, "no", "discard")).toBe(true);
    expect((await storyRow("yes"))!.stage).toBe("developing");
    expect((await storyRow("no"))!.stage).toBe("discarded");
    await expect(saveStory(e, "no", { headline: "Back again" }, { mode: "update" })).rejects.toThrow(/discarded/);
    expect(await reviewDraft(e, "yes", "approve")).toBe(false);
  });
  it("refuse bad ids, missing fields and unknown kinds", async () => {
    await expect(saveStory(env, "../bad", storyInput(), { mode: "create" })).rejects.toThrow(NewsroomError);
    await expect(saveStory(env, "a", { kind: "article" }, { mode: "create" })).rejects.toThrow(/headline/);
    await expect(saveStory(env, "a", storyInput({ kind: "rumour" }), { mode: "create" })).rejects.toThrow(/kind/);
    await expect(saveStory(env, "ghost", { headline: "x" }, { mode: "update" })).rejects.toThrow(/No story/);
  });
});

describe("changes to a published story", () => {
  it("are held: the story doesn't change until the editor approves, once", async () => {
    await makeStory("s");
    const e = withTelegram();
    const r = await saveStory(e, "s", { headline: "New headline" }, { mode: "update", author: "test" });
    expect(r.pending).toMatch(/^u\d+$/);
    expect((await storyRow("s"))!.headline).toBe("A headline");

    expect(await reviewUpdate(e, pending(r.pending), "approve")).toBe(true);
    const after = await storyRow("s");
    expect(after!.headline).toBe("New headline");
    expect(after!.version).toBe(2);
    // A double tap does nothing
    expect(await reviewUpdate(e, pending(r.pending), "approve")).toBe(false);
    expect((await storyRow("s"))!.version).toBe(2);
  });
  it("apply once even if two taps arrive together", async () => {
    await makeStory("s");
    const e = withTelegram();
    const r = await saveStory(e, "s", { headline: "New headline" }, { mode: "update", author: "test" });
    const taps = await Promise.all([reviewUpdate(e, pending(r.pending), "approve"), reviewUpdate(e, pending(r.pending), "approve")]);
    expect(taps.filter(Boolean)).toHaveLength(1);
    expect((await storyRow("s"))!.version).toBe(2);
  });
  it("are dropped when discarded", async () => {
    await makeStory("s");
    const e = withTelegram();
    const r = await saveStory(e, "s", { headline: "Wrong" }, { mode: "update" });
    expect(await reviewUpdate(e, pending(r.pending), "discard")).toBe(true);
    expect((await storyRow("s"))!.headline).toBe("A headline");
  });
  it("wait one at a time per story", async () => {
    await makeStory("s");
    await makeStory("other");
    const e = withTelegram();
    await saveStory(e, "s", { headline: "First" }, { mode: "update" });
    await expect(saveStory(e, "s", { headline: "Second" }, { mode: "update" })).rejects.toThrow(/already waiting/);
    expect((await saveStory(e, "other", { headline: "Fine" }, { mode: "update" })).pending).toBeTruthy();
  });
  it("to a draft go straight in, since it has no readers", async () => {
    const e = withTelegram();
    await saveStory(e, "d", storyInput(), { mode: "create" });
    const r = await saveStory(e, "d", { headline: "Better" }, { mode: "update" });
    expect(r.pending).toBeUndefined();
    expect((await storyRow("d"))!.headline).toBe("Better");
  });
});

describe("the numbers-only rule for live notices", () => {
  const outage = "ns-power-outages-2026-11-05";
  const live = (id = outage) => makeStory(id, { kind: "notice", headline: "9,884 customers without power", dek: "As of 7:04 p.m. on Wednesday, Nov. 4." });

  it("publishes a change to only numbers, times and dates, and tells the editor", async () => {
    await live();
    const r = await saveStory(withTelegram(), outage, { headline: "42 customers without power", dek: "As of 8:04 a.m. on Thursday, Nov. 5." }, { mode: "update" });
    expect(r.autoApplied).toBeTruthy();
    expect((await storyRow(outage))!.headline).toBe("42 customers without power");
  });
  it("holds any change of wording", async () => {
    await live();
    const r = await saveStory(withTelegram(), outage, { headline: "42 homes without power" }, { mode: "update" });
    expect(r.pending).toBeTruthy();
    expect((await storyRow(outage))!.headline).toMatch(/^9,884/);
  });
  it("holds a new status", async () => {
    await live();
    expect((await saveStory(withTelegram(), outage, { statusLabel: "Restored" }, { mode: "update" })).pending).toBeTruthy();
  });
  it("doesn't apply to other notices, even with only a number changed", async () => {
    await live("road-closure");
    expect((await saveStory(withTelegram(), "road-closure", { headline: "42 customers without power" }, { mode: "update" })).pending).toBeTruthy();
  });
  it("doesn't apply to articles with a live-looking id", async () => {
    await makeStory("weather-article", { headline: "9 trees down" });
    expect((await saveStory(withTelegram(), "weather-article", { headline: "12 trees down" }, { mode: "update" })).pending).toBeTruthy();
  });
});
