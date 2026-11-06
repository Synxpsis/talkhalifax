# TalkHalifax: tech debt

_Last reviewed November 5, 2026. Re-check every few weeks, and move items to "Paid off" when they land._

Things that work today but will cost us later: shortcuts, gaps and risks. Each item has a priority:

- **High:** it can put wrong facts on the site, take the site down, or block the next phase.
- **Medium:** it slows us down or will become high as volume grows.
- **Low:** tidy-up.

Size is a rough guess: **S** under an hour, **M** an afternoon, **L** a day or more.
The [roadmap](ROADMAP.md) says when each one is scheduled.

## Newsroom and content

| # | Item | Why it matters | Fix | Pri | Size |
|---|---|---|---|---|---|
| N5 | **r/halifax returns HTTP 429** to the Worker most of the time. | The Reddit signal is usually missing | Fetch it from the routine (not the Worker), or use Reddit's API with an app token. Or drop it, since it's only a signal | Low | M |
| N6 | **Cron times are UTC.** Routines run an hour later in Halifax from November to March. | Briefings land at 7 a.m. in winter and 8 a.m. in summer | Change the crons twice a year (put a reminder in OPERATING-MODEL.md), or let the briefing say its own time | Low | S |
| N8 | **The transit schedule data expires.** `src/transit-data.json` and `public/transit/shapes.json` come from the GTFS schedule valid until Nov. 29, 2026. After a new schedule, new trips have no headsign or line on the map (positions still show). | The map gets vaguer at each service change | Run `node scripts/build-transit.mjs` and push when Halifax Transit publishes; better, a weekly GitHub Action that rebuilds and opens a PR when it changes | Medium | M |
| N7 | **The seed articles are out of date.** `scripts/articles/` holds 9 October stories for local runs. | Local testing doesn't look like the live site (no notices, RCMP or conditions stories) | Replace them with a handful of current stories of each kind, exported from the live site | Low | S |

## Code and tooling

| # | Item | Why it matters | Fix | Pri | Size |
|---|---|---|---|---|---|
| C1 | **Few automated tests (first slice done Nov. 5).** `npm test` covers screening, stage and check-in timing, approvals, bans, rate limits and library events; `npm run test:e2e` opens every page and story kind in a browser; CI runs both before deploy. Still untested: chat in the room, sign-in beyond sign-up limits, push, source parsers. Before Nov. 5: CI type checks and parses `app.js`, then deploys. Nothing checks screening, auth, stage rules, approvals or the MCP tools. | Every push to `main` goes live untested, and agents will be making more of the changes | Add Vitest with `@cloudflare/vitest-pool-workers`. Start with the rules that protect facts and people: screening rules, check-in and stage timing, pending updates, bans, rate limits. Run them in CI before deploy | High | L |
| C4 | **One big client file.** `public/app.js` (about 1,270 lines) holds every view, and `public/index.html` (about 730 lines) holds all the CSS. No build step. | Phase 6 (service worker, push, offline) adds more. Merges and reviews get harder | Split into ES modules served as static files (`views/`, `chat.js`, `api.js`) and move the CSS to `styles.css`. Still no bundler | Medium | M |
| C5 | **`src/mcp.ts` keeps growing** (about 600 lines, 22 tools in one switch). | Every new source or agent adds to it | Split into `mcp/stories.ts`, `mcp/leads.ts`, `mcp/desk.ts` with a shared tool table | Low | M |
| C7 | **Push alerts are sent from one request.** A Worker request can make only 50 outgoing requests on the Free plan (1,000 on Paid), and each alert is one. | Past about 40 subscribers on Free, some won't get an alert | Send through a Cloudflare Queue in batches, or move to the Paid plan. Check which plan the account is on | Medium | M |
| C8 | **The service worker's caches are versioned by hand** (`VERSION` in `public/sw.js`). Everything is network-first, so deploys show up anyway, but a change to what's cached needs the version bumped. | Old cached files can linger offline | Bump `VERSION` when the cached file list changes; later, stamp it at deploy | Low | S |

## Data, privacy and operations

| # | Item | Why it matters | Fix | Pri | Size |
|---|---|---|---|---|---|
| D1 | **`message_index` is never pruned.** It keeps a copy of every chat message forever, and room storage keeps the history of archived rooms. | It grows without limit, and the privacy page should say how long chat is kept | Decide a retention period (for example 12 months), delete older rows in the cron, and say so on `/#privacy` | Medium | S |
| D2 | **No written restore plan.** D1 Time Travel can restore the last 30 days, but nobody has tried it, and Durable Object chat storage isn't covered. | A bad migration or a bulk delete could lose stories or chat | Write a short runbook (`wrangler d1 time-travel`), try it once against a copy, and add a weekly D1 export to R2 | Medium | M |
| D3 | **Turnstile is off.** Sign-up has rate limits but no bot check. | Bot sign-ups once the site is shared | The editor creates the widget and sets the keys (see README) | Medium | S |
| D5 | **Personal email addresses sit in `wrangler.jsonc`** (`ADMIN_EMAILS`), which is in the repo. They aren't on the site. | The repo is less private than it looks; anyone given access sees them | Move `ADMIN_EMAILS` to a secret, or match admins by user id | Low | S |

## Docs

| # | Item | Fix | Pri | Size |
|---|---|---|---|---|
| X1 | `docs/PLATFORM.md` is a snapshot. It goes stale every time a feature lands, unless someone updates it. | Make "update PLATFORM.md" part of every feature's definition of done. The docs-keeper agent owns this | Low | S |

## Paid off

- **Nov. 5, 2026:** the weather and tides feed and the unused road and Transit detour collection are removed (editor's decision). Weather warnings stay, and a failed refresh now reaches the cron's warning.
- **Nov. 5, 2026:** first automated tests, run by CI before every deploy (**C1**, first slice; the rest stays open above).
- **Nov. 5, 2026:** GitHub Actions upgraded to `checkout` and `setup-node` v7, which end the Node 20 warnings.
- **Nov. 5, 2026:** library events reach the site through a GitHub Action, because the feed refuses Cloudflare (**E1**, editor's decision).
- **Nov. 4, 2026:** the journalist reads its prompt from the repo like the other agents (**N4**).
- **Nov. 5, 2026:** wrangler 4.158.0, `@cloudflare/workers-types` 5.20261104.1, TypeScript 5.9.3 and
  `compatibility_date` 2026-10-01 (**C3**). TypeScript 7 is left for later.
- **Nov. 5, 2026:** one line-ending rule, LF everywhere, enforced by `.gitattributes` (**C6**).
- **Nov. 4, 2026:** live weather and outage notices are due a check-in every hour and listed by `conditions` as
  `openNotices` from any day (**N1**). The stale notice came from a day boundary: Nov. 4's `conditions` only knew
  Nov. 4's id, so the Nov. 3 notice dropped out of view.
- **Nov. 4, 2026:** outage notices restore below 500 and reopen only above 2,000 (**N2**).
- **Nov. 4, 2026:** numbers-only changes to live notices publish without a tap and are reported after (**N3**).
- **Nov. 4, 2026:** `publish_story` and `update_story` reject unknown fields. Agents had been sending `status`,
  which was silently dropped, so "Restored" never reached the site.
- **Nov. 4, 2026:** CI smoke-tests the live site after each deploy and rolls back if it fails (**C2**).
- **Nov. 4, 2026:** the cron tells the editor after 2 failed runs of a job in a row, and when it recovers (**D4**).

- **Nov. 4, 2026:** the agent prompts now say to use the field `text`, not `message`, for `notify_editor` (`a533f80`).
- **Nov. 4, 2026:** PLATFORM.md lists all five agents (it listed only the journalist).
