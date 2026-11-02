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

`node scripts/newsroom.mjs list` shows every story; `node scripts/newsroom.mjs publish <file.json> [id]` creates or updates one. The scheduled refresh task uses these to turn new halifax.ca releases into stories, following `prototype/article_guidelines.md`.

## Not built yet

Claude journalists running in Cloudflare itself (Phase 1; today the refresh task runs on a PC), scheduled check-ins on developing stories (Phase 2), more sources (Phase 3), and launch hardening (Phase 4: Turnstile, message pre-screening, report and ban tools, privacy policy, password reset).
