# TalkHalifax

Halifax news, rewritten as short articles with a live chat in each one. Runs on Cloudflare Workers.

- `public/`: the page (`index.html`, `app.js`), served as static assets
- `src/index.ts`: the Worker: `/api/*`, `/auth/*`, `/rooms/<story>/ws`, and a 30-minute cron for weather and tides
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

## Deploy

Live at https://talkhalifax.alexwmmolloy.workers.dev, on the Cloudflare account pinned in `wrangler.jsonc`.

**Automatically:** every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml): type check, apply any new D1 migrations, `wrangler deploy`. Pull requests get the type check only. Changes only under `prototype/` or to this README don't deploy. You can also run it by hand from the repo's **Actions** tab.
It needs one repository secret, `CLOUDFLARE_API_TOKEN`: a Cloudflare API token with **Account › Workers Scripts › Edit** and **Account › D1 › Edit**.

**By hand:** `npm run db:migrate:remote`, then `npm run deploy`.

Secrets live on the Worker, not in the repo:
- `NEWSROOM_TOKEN`: lets the newsroom publish (`npx wrangler secret put NEWSROOM_TOKEN`; keep a copy in `.newsroom-token` for `scripts/newsroom.mjs`)
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`: optional; Google sign-in stays off without them

Moderators: `ADMIN_USERNAMES` (and `ADMIN_EMAILS` for Google) in `wrangler.jsonc`.

## Publishing stories

Stories follow [newsroom/guidelines.md](newsroom/guidelines.md). Agents work through the newsroom MCP server at `/mcp` (Bearer `NEWSROOM_TOKEN`). From a terminal, `node scripts/newsroom.mjs list` and `publish <file.json> [id]` do the same, and `tool <name> [json | @file.json]` calls any MCP tool (`tool list` names them).

**The journalist** is a Claude Code cloud routine, "TalkHalifax journalist", that runs at five past every hour on the Claude plan (no Anthropic API key). It clones this repo and uses `scripts/newsroom.mjs tool …`, because routines can't attach a custom MCP server. Each run files the last 3 days' new halifax.ca releases as leads, then works up to 5 open leads and records its versions as `cloud-routine`. It then checks in on up to 5 developing stories that haven't had a check-in in 12 hours (`checkin_queue`, `record_checkin`). It re-reads each source and fixes only stale timing or facts the city changed. Its prompt and schedule live at claude.ai/code/routines. It needs, in its cloud environment:
- an environment variable `TALKHALIFAX_TOKEN` set to the newsroom token
- network access to `talkhalifax.alexwmmolloy.workers.dev`

## Not built yet

More sources (Phase 3), and launch hardening (Phase 4: Turnstile, message pre-screening, report and ban tools, privacy policy, password reset).
