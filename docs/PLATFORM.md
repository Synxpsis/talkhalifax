# TalkHalifax: the platform as it is

_A record of everything running on November 5, 2026 (Phase 6 under way). Update it when something changes._

Live at https://talkhalifax.alexwmmolloy.workers.dev. Repo: github.com/Synxpsis/talkhalifax.

## The pieces

```
 Official sources ──► Newsroom agents (Claude Code cloud routines)
 halifax.ca             │  through scripts/newsroom.mjs → POST /mcp (Bearer NEWSROOM_TOKEN)
 news.novascotia.ca     ▼
 rcmp.ca           Cloudflare Worker  src/index.ts ──► D1 database "talkhalifax"
 weather.gc.ca          │  /api/*, /auth/*, /mcp, /telegram/webhook, 30-minute cron
 NS Power outages       ├──► ArticleRoom Durable Object per story (live chat)
 Signals (never facts): ├──► Workers AI (Llama Guard screens chat and comments)
 Google Trends,         └──► Telegram bot ──► the editor (approve / discard, notes)
 r/halifax              ▼
                   public/index.html + app.js (single-page site, served as static assets)

 Halifax Public Libraries ──► GitHub Action (every 6 hours) ──► POST /api/events/ingest
```

| Part | Where | What it does |
|---|---|---|
| Worker | `src/index.ts` | Routes, the 30-minute cron (weather warnings, a check that library events are arriving, story stages, clean-up) |
| Auth | `src/auth.ts` | Password and Google sign-in, sessions (HttpOnly cookie), Turnstile, reset links, rate limits |
| Stories | `src/stories.ts` | Saving stories and versions, Developing → Articles, comments, approvals |
| Chat rooms | `src/room.ts` | One Durable Object per story: history, presence, typing, screening, bans, removals |
| Screening | `src/screen.ts` | Rules (slurs, phone numbers, emails, new-account links), then Llama Guard with a 3 s limit |
| Moderation | `src/moderation.ts` | Reports, bans, purges, account deletion |
| Newsroom MCP | `src/mcp.ts` | The tools agents use (below) |
| Telegram | `src/telegram.ts` | Drafts and held updates to the editor with buttons; plain notes |
| Weather warnings | `src/alerts.ts` | Environment Canada warnings, watches and statements for the banners, Notices and `conditions` |
| Site | `public/index.html`, `public/app.js` | The page, CSS design system and all views (see [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)) |
| Transit map | `src/transit.ts`, `public/transit.js`, `scripts/build-transit.mjs` | Live buses and ferries and service alerts from Halifax Transit's GTFS-realtime feeds; route lines and names from its GTFS schedule |
| Events | `src/events.ts`, `public/events.js` | The Events tab: Halifax Public Libraries' events for the next two weeks, stored in `feeds` ('events') and shown as the library lists them. The feed refuses Cloudflare, so a GitHub Action (`.github/workflows/events.yml`, every 6 hours) runs `scripts/fetch-events.mjs`, which posts the raw RSS pages to `POST /api/events/ingest` (Bearer `EVENTS_TOKEN`); the Worker parses and stores them |
| Push alerts | `src/push.ts`, `public/alerts.js` | Readers opt in from the Alerts section of their profile, no account needed (kinds, quiet hours; `/#alerts` links land there). A new live notice offers the editor "Send alert" on Telegram; only that tap sends. Web Push with VAPID and aes128gcm, done with WebCrypto |
| App shell | `public/sw.js`, `public/manifest.webmanifest`, `public/icons/` | Installable app; the service worker keeps the shell, stories you've read and the events list for offline reading, and shows push alerts |
| Guidelines | `newsroom/guidelines.md` | How stories are written; bundled into the Worker and served by `get_guidelines` |
| Schema | `migrations/0001`–`0011` | D1 tables (below) |
| Tests | `test/unit/`, `test/e2e/routes.mjs` | `npm test`: the rules on the Workers runtime (screening, timing, approvals, bans, rate limits, events). `npm run test:e2e`: every page and story kind in a browser, with throwaway data |
| Deploy | `.github/workflows/deploy.yml` | Every push to `main`: type check, unit tests and a browser check (any failure stops the deploy), D1 migrations, `wrangler deploy`, a smoke test, and a rollback if it fails |

## Content model

A **story** has a `kind`:
- `article`: a civic story people can act on or discuss. Facts, body, "what this means", live chat, then comments.
- `notice`: urgent or safety facts only, no interpretation, no comments. Can be `supersededBy` a newer notice.
- `skip`: a release we decided not to cover (with a reason), so it isn't picked up again.

And a **stage**:
- `draft`: waiting for the editor (every new article when Telegram is on, and anything sent with `review: true`).
- `developing`: on Home with a live chat. Articles move to Articles once quiet: no newsroom update for 12 hours and
  no chat for 3 hours, or after a week.
- `archived`: under Articles, chat closed, comments open. A significant follow-up can reopen it.

Every change is a new row in `story_versions`. Changes to published stories wait in `pending_updates` (ids like `u12`)
until the editor approves.

**Leads** are the queue of possible stories: `open` → `claimed` (2-hour claim) → `done` or `dropped`. Each has a
category that sets priority: P0 `right-now`, P1 `talk-of-the-town` (200+ searches), P2 `money-and-homes`,
P3 `decisions`, P4 `community`.

## Sources

| Source | Used for | How |
|---|---|---|
| halifax.ca news releases | Articles and notices | `scan_sources`, `read_release` |
| news.novascotia.ca | Provincial stories that touch Halifax | same |
| rcmp.ca (Halifax-area detachments) | Police notices, always reviewed | same |
| Environment Canada | Weather warnings (notices and banners) | `conditions`, cron |
| Nova Scotia Power outage map | Outage notices (2,000+ customers) | `conditions` |
| Halifax Transit GTFS-realtime (gtfs.halifax.ca) | Transit map: vehicle positions and service alerts | `/api/transit/*`, fetched at most every 12 s (alerts 2 min) per Worker isolate |
| Halifax Transit GTFS schedule | Transit map: routes, lines, headsigns, stop names | `node scripts/build-transit.mjs`, by hand when the schedule changes |
| Halifax Public Libraries events (BiblioCommons RSS) | Events tab, listed as posted | Fetched by the Events GitHub Action every 6 hours (about 16 requests) and posted to the Worker; the cron warns the editor when it's over 26 hours old |
| Google Trends (Nova Scotia) | Signal: raises lead priority | `trending` |
| r/halifax | Signal: something may be happening | `trending` |

## Newsroom tools (MCP at `/mcp`)

`get_guidelines`, `my_profile`, `set_profile`, `scan_sources`, `trending`, `conditions`, `read_release`,
`list_stories`, `get_story`, `publish_story`, `update_story`, `list_leads`, `file_lead`, `prioritize_lead`,
`claim_lead`, `complete_lead`, `room_activity`, `checkin_queue`, `record_checkin`, `await_review`,
`desk_status` (the newsroom at a glance), `notify_editor` (a plain note to the editor on Telegram, 24 a day).

From a terminal or a cloud routine: `node scripts/newsroom.mjs tool <name> [json | @file.json]`.

## Site features

- **Home**: developing stories as cards, latest first, with live people counts; urgent notices and weather warnings
  in banners under the header.
- **Transit** (`#transit`, or `#transit-<route>`): a live map of every bus and ferry (MapLibre, OpenFreeMap tiles),
  updated every 15 seconds. Pick a route to see only it and its line; tap a vehicle for its headsign, next stop, speed,
  seats and the route's service alerts.
- **Articles** and **Notices**: archived articles and current notices.
- **Events** (`#events`): what's on at the libraries over the next two weeks, filtered by when, who it's for and area,
  with Highlights from the library's featured events, special events and performances.
- **Alerts**, a section of the profile (old `#alerts` links scroll to it; no account needed): turn push alerts on for urgent notices, pick kinds (weather, outages, roads and transit,
  police and emergencies, other) and quiet hours. Offered under a notice, never on a first visit.
- **Installable and offline**: Add to Home Screen on phones, install on desktop. The footer's Install the app opens the
  browser's own prompt, or on iPhone and Android a card with the steps. Without a connection the app opens,
  shows an offline bar, and stories you've opened and the events list stay readable; chat waits for the connection.
- **Story**: the article or notice, its facts, version notes, the docked live chat (or comments once archived).
- **Chat**: live messages, typing, presence, report (⚑), screening with the text handed back if turned away.
- **Profiles**: your own (messages, password change, delete account, moderator reports) and public ones (the journalist's
  byline links to hers).
- **Moderators**: approve drafts in the browser or on Telegram, remove reported items, ban or ban-and-purge, make reset
  links. Moderators are listed in `ADMIN_EMAILS` / `ADMIN_USERNAMES` in `wrangler.jsonc`.
- **Privacy** page at `/#privacy`, linked from the footer, menu and sign-up.

## Data (D1 tables)

`users`, `sessions`, `auth_throttle` (rate limits, cleared after a day), `stories`, `story_versions`, `room_stats`,
`message_index` (a copy of every chat message), `comments`, `feeds` (cached weather warnings and library events, plus the cron's failure counts), `leads`,
`pending_updates`, `reports`, `password_resets`, `push_subs` (one row per browser with alerts on: its push address,
keys, kinds and quiet hours; not tied to an account). `stories.push_sent_at` and `push_count` record a sent alert. Live chat history itself lives in each room's Durable Object storage.

## Secrets and settings

On the Worker (`npx wrangler secret put <NAME>`): `NEWSROOM_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (optional), `TURNSTILE_SECRET` (optional, not set yet),
`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` (push alerts; `node scripts/vapid-keys.mjs`, set Nov. 5), `EVENTS_TOKEN` (library events from GitHub; `node scripts/events-token.mjs` sets it here and on GitHub).
In `wrangler.jsonc` vars: `ADMIN_EMAILS`, `ADMIN_USERNAMES`, and `TURNSTILE_SITE_KEY` once there is one.
GitHub repository secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit, D1 Edit; it also covers the Workers AI binding) and `EVENTS_TOKEN` (the Events workflow).
Cloud routines: environment variable `TALKHALIFAX_TOKEN` (the newsroom token) and network access to the site.

## Agents running now

| Agent | Schedule | Routine |
|---|---|---|
| Journalist (Tessa Aldridge, `cloud-routine`) | Hourly at :05 | "TalkHalifax journalist", `trig_01J1HVC3hTLdfBQyN2xhjK5m`, Sonnet 5.5 |
| Desk editor | 11:00 and 23:00 UTC | `trig_01U7Fg6qdLgme9bFHgoV7FSq` |
| Standards editor | 09:15 UTC | `trig_01YRzmnQRAgXf13gagHcVpJH` |
| Site reliability | Every 6 hours at :35 | `trig_01YAnGEpxGBvPPpoBGvJhym1` |
| Source scout | Mondays 14:00 UTC | `trig_01UdfbS7HxRGRS5xxVxLBAJt` |

See [OPERATING-MODEL.md](OPERATING-MODEL.md) for what each one does. Debt and gaps are tracked in
[TECH-DEBT.md](TECH-DEBT.md), and the plan in [ROADMAP.md](ROADMAP.md).

## Known issues and gaps

- **r/halifax returns HTTP 429** to the Worker (Reddit rate-limits Cloudflare's addresses), so the Reddit signal is
  usually missing. The journalist reports it and carries on.
- **Turnstile is off** until a widget's keys are set. Sign-up has rate limits but no bot check.
- **The library's events feed refuses requests from Cloudflare** (HTTP 403), so GitHub Actions fetches it (TECH-DEBT
  **E1**). If that workflow stops, the Events tab keeps its last list and the cron warns after 26 hours.
- Cron expressions are in UTC, so routines run an hour later in Halifax local time from November to March.
