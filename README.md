# TalkHalifax

Halifax news, rewritten as short articles with a live chat in each one. Runs on Cloudflare Workers.

**Docs:** [vision](docs/VISION.md) · [the platform today](docs/PLATFORM.md) · [operating model and agents](docs/OPERATING-MODEL.md) · [design system](docs/DESIGN-SYSTEM.md) · [roadmap](docs/ROADMAP.md) · [tech debt](docs/TECH-DEBT.md) · [working rules for agents](CLAUDE.md)

- `public/`: the page (`index.html`, `app.js`), served as static assets
- `src/index.ts`: the Worker: `/api/*`, `/auth/*`, `/rooms/<story>/ws`, and a 30-minute cron for weather warnings, story stages and clean-up
- `src/alerts.ts`: Environment Canada weather warnings for the banners and Notices, shown as posted with links (not rewritten)
- `src/transit.ts` and `public/transit.js`: the live Transit map (Halifax Transit's real-time feeds). When Halifax Transit publishes a new schedule, run `node scripts/build-transit.mjs` and push
- `src/events.ts` and `public/events.js`: the Events tab, from Halifax Public Libraries' events feed (the next two weeks). The feed refuses Cloudflare, so [.github/workflows/events.yml](.github/workflows/events.yml) runs `scripts/fetch-events.mjs` every 6 hours and posts it to the site
- `src/push.ts`, `public/alerts.js` and `public/sw.js`: push alerts for urgent notices (sent only when the editor taps "Send alert" on Telegram), and the service worker that also keeps the app readable offline. `public/manifest.webmanifest` and `public/icons/` make it installable
- `src/room.ts`: `ArticleRoom`, one Durable Object per story, holding its chat history, presence and typing
- `src/auth.ts`: sessions (HttpOnly cookie), Google sign-in, and a localhost-only dev sign-in
- `migrations/`: the D1 schema. `scripts/articles/` plus `scripts/build-seed.mjs` load the current stories.

## Run locally

```bash
npm install
npx wrangler d1 migrations apply talkhalifax --local
npm run db:seed:local
npm run dev
```

Open http://localhost:8787, then the profile icon, then **Dev sign-in** (it's enabled by `.dev.vars` and only works on localhost).

> On Windows, if the project sits in a very deep folder, local D1 can fail with `SQLITE_CANTOPEN` because the path passes 260 characters. Either move the project somewhere shorter, or add `--persist-to C:/some/short/path` to the three local commands.

## Tests

```bash
npm test           # the rules, on the Workers runtime (test/unit/)
npm run test:e2e   # the real site in Chrome or Edge: every page and every kind of story (test/e2e/)
```

Neither needs a Cloudflare account or touches the live site. CI runs both before every deploy, and a failure stops the deploy.

## Deploy

Live at https://talkhalifax.ca, on the Cloudflare account pinned in `wrangler.jsonc`. `talkhalifax.com`, `talkhalifax.org` and the `www` names are custom domains on the same Worker and redirect there (set in the dashboard, under the Worker's Domains & Routes). The old `talkhalifax.alexwmmolloy.workers.dev` address redirects browsers, and stays on for the newsroom agents, the Telegram webhook and the Events job.

**Automatically:** every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml): type check, unit tests, browser check, apply any new D1 migrations, `wrangler deploy`. Pull requests get the checks and tests only. Changes only to this README don't deploy. You can also run it by hand from the repo's **Actions** tab.
It needs one repository secret, `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with **Account › Workers Scripts › Edit** and **Account › D1 › Edit**.

**By hand:** `npm run db:migrate:remote`, then `npm run deploy`.

Secrets live on the Worker, not in the repo:
- `NEWSROOM_TOKEN`: lets the newsroom publish (`npx wrangler secret put NEWSROOM_TOKEN`; keep a copy in `.newsroom-token` for `scripts/newsroom.mjs`)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: optional; Google sign-in stays off without them
- `TURNSTILE_SECRET`: optional, with the public `TURNSTILE_SITE_KEY` var in `wrangler.jsonc`; sign-up asks for Cloudflare's bot check only when both are set
- `EVENTS_TOKEN`: lets the Events GitHub Action post library events. `node scripts/events-token.mjs` makes one and stores it on the Worker and as a GitHub repository secret
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`: push alerts stay off without them. Make and store both with `node scripts/vapid-keys.mjs` (run it once: a new pair turns everyone's alerts off). For a local run, pass test keys with `--var`

Moderators: `ADMIN_USERNAMES` in `wrangler.jsonc`. If Google sign-in is turned on, also `npx wrangler secret put ADMIN_EMAILS` (comma-separated; a secret because this repo is public).

## Moderation

- **Screening.** Every chat message and comment is checked before anyone sees it ([src/screen.ts](src/screen.ts)): fixed rules turn away slurs, phone numbers, email addresses and links from accounts under a day old, then Llama Guard on Workers AI turns away threats, hate and sexual content. A turned-away chat message goes back into its writer's box. If the model takes over 3 seconds, the message posts on the rules alone.
- **Reports.** Signed-in readers flag a message (⚑) or comment (Report). Moderators see open reports on their profile and remove the item or dismiss the report; the editor gets a Telegram note on each item's first report.
- **Bans.** From someone's profile a moderator can ban them from posting (it applies to their next message, even in an open chat), or ban them and remove everything they posted. Moderators and the journalist can't be banned.
- **Password reset.** Password accounts have no email, so a moderator makes a one-time reset link from the person's profile (valid 1 hour) and sends it to them. Anyone signed in can change their password or delete their account from their profile.
- **Privacy.** The notice is at `/#privacy`. The cron trigger deletes rate-limit counters (some keyed by IP address) after a day, and expired sessions and reset links.

## Publishing stories

Stories follow [newsroom/guidelines.md](newsroom/guidelines.md). Agents work through the newsroom MCP server at `/mcp` (Bearer `NEWSROOM_TOKEN`). From a terminal, `node scripts/newsroom.mjs list` and `publish <file.json> [id]` do the same, and `tool <name> [json | @file.json]` calls any MCP tool (`tool list` names them).

**The agents** are Claude Code cloud routines on the Claude plan (no Anthropic API key). They clone this repo and use `scripts/newsroom.mjs tool …`, because routines can't attach a custom MCP server. The journalist, "TalkHalifax journalist", runs at five past every hour: it files new releases from halifax.ca, the province and Halifax-area RCMP, plus live weather warnings and outages, as leads; works up to 5 leads in priority order; and checks in on up to 5 developing stories. The other jobs (desk editor, standards editor, site reliability, source scout) and their schedules are in [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md); each one's prompt is in `newsroom/routines/`. Routines are managed at claude.ai/code/routines. They need, in their cloud environment:
- an environment variable `TALKHALIFAX_TOKEN` set to the newsroom token
- network access to `talkhalifax.alexwmmolloy.workers.dev`
