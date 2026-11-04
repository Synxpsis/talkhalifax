# TalkHalifax: tech debt

_Last reviewed November 4, 2026 (commit `a533f80`). Re-check every few weeks, and move items to "Paid off" when they land._

Things that work today but will cost us later: shortcuts, gaps and risks. Each item has a priority:

- **High:** it can put wrong facts on the site, take the site down, or block the next phase.
- **Medium:** it slows us down or will become high as volume grows.
- **Low:** tidy-up.

Size is a rough guess: **S** under an hour, **M** an afternoon, **L** a day or more.
The [roadmap](ROADMAP.md) says when each one is scheduled.

## Newsroom and content

| # | Item | Why it matters | Fix | Pri | Size |
|---|---|---|---|---|---|
| N1 | **Live-conditions notices go stale.** Every developing story is due a check-in 12 hours after the last one (`CHECKIN_MS` in `src/mcp.ts`), outage and weather notices included. On Nov. 3–4 the outage notice said 9,884 customers for 13 hours after power was back. The standards editor caught it, not the journalist. | Wrong facts on the site, which breaks principle 1 | Make check-in timing depend on the story's kind: notices built from `conditions` are due every hour, other stories every 12 hours. Also have the journalist compare every open conditions notice with `conditions` on each run | High | S |
| N2 | **Outage notices flip between open and restored.** The count went 9,884 → 42 ("Restored") → 783 ("open") in a few hours. Each change waits for an editor tap. | Noise for the editor and readers, and every flip is another approval | Use two thresholds instead of one (restore below 500, reopen only above 2,000), or close the notice and file a new one. Agree the rule in `newsroom/guidelines.md` | Medium | S |
| N3 | **Every change waits for one person.** A held fix to a stale fact stays held, and the old fact stays on the site, until the editor taps Approve. The 7 a.m. briefing reported the 9,884 figure as waiting and out of date. | Slow fixes overnight; the editor is a single point of failure | Decide which changes are safe to apply without a tap, for example updating only the numbers on a conditions notice from `conditions` output, then marking it "auto-updated" in Telegram. This is a principle 4 decision for the editor | High | M |
| N4 | **The journalist's prompt lives inside its routine.** The other four routines read `newsroom/routines/<name>.md` when they run. The journalist's copy in the repo is only a mirror, so the two can drift apart. | An edit to the file changes nothing; an edit to the routine isn't in git | Change the journalist's routine to a short prompt that reads `newsroom/routines/journalist.md`, like the others | Medium | S |
| N5 | **r/halifax returns HTTP 429** to the Worker most of the time. | The Reddit signal is usually missing | Fetch it from the routine (not the Worker), or use Reddit's API with an app token. Or drop it, since it's only a signal | Low | M |
| N6 | **Cron times are UTC.** Routines run an hour later in Halifax from November to March. | Briefings land at 7 a.m. in winter and 8 a.m. in summer | Change the crons twice a year (put a reminder in OPERATING-MODEL.md), or let the briefing say its own time | Low | S |
| N7 | **The seed articles are out of date.** `scripts/articles/` holds 9 October stories for local runs. | Local testing doesn't look like the live site (no notices, RCMP or conditions stories) | Replace them with a handful of current stories of each kind, exported from the live site | Low | S |

## Code and tooling

| # | Item | Why it matters | Fix | Pri | Size |
|---|---|---|---|---|---|
| C1 | **No automated tests.** CI type checks and parses `app.js`, then deploys. Nothing checks screening, auth, stage rules, approvals or the MCP tools. | Every push to `main` goes live untested, and agents will be making more of the changes | Add Vitest with `@cloudflare/vitest-pool-workers`. Start with the rules that protect facts and people: screening rules, check-in and stage timing, pending updates, bans, rate limits. Run them in CI before deploy | High | L |
| C2 | **No check after a deploy, and no rollback step.** | A deploy that breaks the site stays broken until someone notices. Site reliability checks only every 6 hours | After `wrangler deploy`, curl `/`, `/api/stories` and `/api/weather`. If one fails, run `wrangler rollback` and fail the job | High | S |
| C3 | **Tooling is over a year old.** wrangler 4.20.0 (latest 4.157), `@cloudflare/workers-types` 2025-06 (latest v5), TypeScript 5.8 (latest 7.0), `compatibility_date` 2025-06-01. | Missing fixes and newer features (for example Workers Static Assets options and better local D1). The longer we wait, the bigger the jump | Upgrade wrangler first, then workers-types and the compatibility date, testing locally after each step. Leave TypeScript 7 for later | Medium | M |
| C4 | **One big client file.** `public/app.js` (1,161 lines) holds every view, and `public/index.html` (627 lines) holds all the CSS. No build step. | Phase 6 (service worker, push, offline) adds more. Merges and reviews get harder | Split into ES modules served as static files (`views/`, `chat.js`, `api.js`) and move the CSS to `styles.css`. Still no bundler | Medium | M |
| C5 | **`src/mcp.ts` keeps growing** (583 lines, 22 tools in one switch). | Every new source or agent adds to it | Split into `mcp/stories.ts`, `mcp/leads.ts`, `mcp/desk.ts` with a shared tool table | Low | M |
| C6 | **Mixed line endings.** Some files are CRLF and some LF, and only `CLAUDE.md` records which. `sed -i` in Git Bash strips CRs. | Silent whole-file diffs, and agents break files | Add a `.gitattributes` (`* text=auto eol=lf`) and normalise once in a commit of its own | Medium | S |

## Data, privacy and operations

| # | Item | Why it matters | Fix | Pri | Size |
|---|---|---|---|---|---|
| D1 | **`message_index` is never pruned.** It keeps a copy of every chat message forever, and room storage keeps the history of archived rooms. | It grows without limit, and the privacy page should say how long chat is kept | Decide a retention period (for example 12 months), delete older rows in the cron, and say so on `/#privacy` | Medium | S |
| D2 | **No written restore plan.** D1 Time Travel can restore the last 30 days, but nobody has tried it, and Durable Object chat storage isn't covered. | A bad migration or a bulk delete could lose stories or chat | Write a short runbook (`wrangler d1 time-travel`), try it once against a copy, and add a weekly D1 export to R2 | Medium | M |
| D3 | **Turnstile is off.** Sign-up has rate limits but no bot check. | Bot sign-ups once the site is shared | The editor creates the widget and sets the keys (see README) | Medium | S |
| D4 | **Errors only show up in Cloudflare's logs.** Observability is on, but nothing alerts. A failing cron (weather, alerts, stages) is silent until site reliability runs. | Problems last up to 6 hours | Have the cron count its own failures and call `tellEditor` after 2 failures in a row (rate-limited) | Medium | S |
| D5 | **Personal email addresses sit in `wrangler.jsonc`** (`ADMIN_EMAILS`), which is in the repo. They aren't on the site. | The repo is less private than it looks; anyone given access sees them | Move `ADMIN_EMAILS` to a secret, or match admins by user id | Low | S |

## Docs

| # | Item | Fix | Pri | Size |
|---|---|---|---|---|
| X1 | `docs/PLATFORM.md` is a snapshot. It goes stale every time a feature lands, unless someone updates it. | Make "update PLATFORM.md" part of every feature's definition of done. The docs-keeper agent owns this | Low | S |

## Paid off

- **Nov. 4, 2026:** the agent prompts now say to use the field `text`, not `message`, for `notify_editor` (`a533f80`).
- **Nov. 4, 2026:** PLATFORM.md lists all five agents (it listed only the journalist).
