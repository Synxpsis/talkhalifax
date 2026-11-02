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

1. Sign in: `npx wrangler login`
2. Create the database, then paste the printed `database_id` into `wrangler.jsonc`:
   `npx wrangler d1 create talkhalifax`
3. Create the tables and load the stories:
   `npm run db:migrate:remote` and `npm run db:seed:remote`
4. Google sign-in: in Google Cloud Console, create an OAuth client (type "Web application") with the redirect URI
   `https://<your-domain>/auth/google/callback`, then:
   `npx wrangler secret put GOOGLE_CLIENT_ID` and `npx wrangler secret put GOOGLE_CLIENT_SECRET`
5. Moderators: set `ADMIN_EMAILS` in `wrangler.jsonc` (comma-separated). They can remove anyone's message.
6. `npm run deploy`, then add your domain under the Worker's **Domains & Routes**.

## Not in Phase 0

The Claude journalists (Phase 1), article versions and check-ins (Phase 2), more sources (Phase 3), and launch hardening (Phase 4: Turnstile, message pre-screening, report and ban tools, privacy policy). Until Phase 1 ships, new stories still come from the prototype's refresh task, loaded with `npm run db:seed:remote`.
