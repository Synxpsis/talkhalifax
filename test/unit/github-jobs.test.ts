import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startGithubJobs } from "../../src/github-jobs";
import { env, HOUR, DAY } from "./helpers";

const withToken = { ...env, GITHUB_ACTIONS_TOKEN: "test-token" };
const START = Date.UTC(2026, 10, 7, 12);
type Call = { url: string; init: RequestInit };

describe("starting the GitHub jobs", () => {
  let calls: Call[], status: (url: string) => number;
  const started = () => calls.map(c => c.url.match(/workflows\/(.+)\/dispatches/)?.[1]);
  beforeEach(async () => {
    calls = []; status = () => 204;
    await env.DB.prepare("DELETE FROM feeds WHERE name = 'github-jobs'").run();
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: status(url) }); });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does nothing until the token is set", async () => {
    await startGithubJobs(env, START);
    expect(calls).toHaveLength(0);
  });
  it("starts both jobs the first time, on main, as GitHub requires", async () => {
    await startGithubJobs(withToken, START);
    expect(started()).toEqual(["events.yml", "transit.yml"]);
    expect(calls[0].url).toBe("https://api.github.com/repos/Synxpsis/talkhalifax/actions/workflows/events.yml/dispatches");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ ref: "main" });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer test-token");
    expect(headers["user-agent"]).toBeTruthy();
  });
  it("doesn't start anything again before it's due", async () => {
    await startGithubJobs(withToken, START);
    calls = [];
    await startGithubJobs(withToken, START + 30 * 60_000);
    expect(calls).toHaveLength(0);
  });
  it("starts Events every 6 hours, without drifting, and Transit weekly", async () => {
    await startGithubJobs(withToken, START);
    calls = [];
    await startGithubJobs(withToken, START + 6 * HOUR - 60_000);
    expect(started()).toEqual(["events.yml"]);
    calls = [];
    await startGithubJobs(withToken, START + 7 * DAY);
    expect(started()).toEqual(["events.yml", "transit.yml"]);
  });
  it("tries again next run after a refusal, tells the watch, and still starts the other job", async () => {
    status = url => url.includes("events.yml") ? 401 : 204;
    await expect(startGithubJobs(withToken, START)).rejects.toThrow(/events\.yml \(HTTP 401\).*GITHUB_ACTIONS_TOKEN/);
    expect(started()).toEqual(["events.yml", "transit.yml"]);
    calls = []; status = () => 204;
    await startGithubJobs(withToken, START + 30 * 60_000);
    expect(started()).toEqual(["events.yml"]);
  });
  it("never puts the token in what it reports", async () => {
    status = () => 403;
    await expect(startGithubJobs(withToken, START)).rejects.not.toThrow(/test-token/);
  });
});
