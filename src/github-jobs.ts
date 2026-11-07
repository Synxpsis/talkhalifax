// Starts the GitHub Actions jobs that do what the Worker can't. GitHub's own schedule never ran them here (Nov. 2026), so the
// Worker's cron starts each one when it's due and remembers when it last did, in feeds ('github-jobs').
import type { Env } from "./env";

const REPO = "Synxpsis/talkhalifax";
const HOUR = 36e5;
export const GITHUB_JOBS = [
  { file: "events.yml", every: 6 * HOUR },     // library events: the feed refuses Cloudflare
  { file: "transit.yml", every: 7 * 24 * HOUR }, // the Transit map's schedule data
];
// The cron runs every 30 minutes, so a job isn't pushed a run later each time by a few seconds' difference
const SLACK = 5 * 60_000;

/** Start whichever jobs are due. A refusal throws once the others have had their turn, so the cron's watch tells the editor. */
export async function startGithubJobs(env: Env, now = Date.now()) {
  if (!env.GITHUB_ACTIONS_TOKEN) return;
  const row = await env.DB.prepare("SELECT body FROM feeds WHERE name = 'github-jobs'").first<{ body: string }>();
  const started: Record<string, number> = row ? JSON.parse(row.body) : {};
  const problems: string[] = [];
  let changed = false;
  for (const job of GITHUB_JOBS) {
    if (now - (started[job.file] || 0) < job.every - SLACK) continue;
    const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${job.file}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_ACTIONS_TOKEN}`, accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28", "user-agent": "TalkHalifax", "content-type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }).catch(e => new Response(String(e), { status: 599 }));
    if (r.ok) { started[job.file] = now; changed = true; }
    else problems.push(`${job.file} (HTTP ${r.status})`);
  }
  if (changed) {
    await env.DB.prepare("INSERT INTO feeds (name, body, updated_at) VALUES ('github-jobs', ?, ?) ON CONFLICT(name) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at")
      .bind(JSON.stringify(started), new Date(now).toISOString()).run();
  }
  if (problems.length) throw new Error(`GitHub wouldn't start ${problems.join(" and ")}. If it says 401 or 403, the GITHUB_ACTIONS_TOKEN secret may have expired.`);
}
