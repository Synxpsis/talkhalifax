# TalkHalifax: roadmap

_Last updated November 5, 2026. [VISION.md](VISION.md) says why, this file says what's next and in what order,
and [TECH-DEBT.md](TECH-DEBT.md) has the items marked like **N1**._

The order follows the principles: first keep facts right, then keep the site up, then make it feel native, then grow.
Each milestone ends with a test that says it's done. Weeks are rough and assume part-time work with agents doing the
building.

## Done: Phase 5, the operating model (Nov. 4 and 5)

The team is running, stale facts are caught within the hour, and a broken deploy rolls itself back.

| Work | Debt | Done when |
|---|---|---|
| ✅ Notices built from live conditions are checked every hour, not every 12 hours | N1 | An outage notice is never more than about an hour behind `conditions` |
| ✅ Outage notices stop flipping: one threshold to restore, a higher one to reopen | N2 | Guidelines changed; no notice flips twice in a day |
| ✅ **Editor decision:** which changes can go live without a tap (proposal: number-only updates to conditions notices, reported on Telegram afterwards) | N3 | The rule is written in guidelines.md and OPERATING-MODEL.md, and the code follows it |
| ✅ The journalist reads its prompt from the repo like the other agents | N4 | Routine prompt is a pointer; `journalist.md` is the only copy |
| ✅ A smoke test after every deploy, with automatic rollback | C2 | A deliberately broken deploy rolls itself back in CI |
| ✅ The cron tells the editor when it keeps failing | D4 | Two failed weather or stage runs in a row send one Telegram note |
| ✅ One line-ending rule for the whole repo | C6 | `.gitattributes` committed; no CRLF notes left in CLAUDE.md |
| ✅ Turnstile keys set (editor) | D3 | Moved to 6a; done Nov. 6 |

**Exit test** (watched through the week of Nov. 9 while Phase 6 starts): a week in which the standards editor finds no stale facts, the editor approves in minutes a day, and
site reliability sends no alerts that weren't real.

## Now: Phase 6, the native experience (Nov. 5 to mid-December)

Make TalkHalifax feel like an app on a phone and a calm reading room on a desktop. Do the ground work first so the new
features land on a codebase that can take them.

**6a. Ground work**
- ✅ Turnstile keys set by the editor, so sign-up has a bot check (**D3**, Nov. 6).
- ✅ Upgrade wrangler, workers-types and the compatibility date (**C3**).
- Split `app.js` into modules and move the CSS to its own file, no bundler (**C4**).
- ✅ First automated tests: screening rules, check-in and stage timing, pending updates, bans and rate limits, run in CI
  before deploy (**C1**, first slice).

**6b. Installable and offline** (built Nov. 5)
- ✅ A web manifest, icons and a splash colour, following [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md).
- ✅ A service worker: the app shell always loads, and the stories you've opened stay readable offline, with a clear
  "offline" state on chat.
- "Add to Home Screen" works on iOS and Android, and desktop install works in Chrome and Edge. Checked in Edge;
  still to try on a real iPhone and Android phone.

**6c. Push alerts for P0** (built and switched on Nov. 5)
- ✅ Web Push (VAPID keys as Worker secrets) for urgent notices. Opt-in only, offered after a reader opens a notice,
  never on first visit.
- ✅ A preference for which kinds of alert, and quiet hours.
- ✅ The editor's "Send alert" tap on Telegram is what sends the push. Nothing is pushed that a human hasn't approved.
- Before alerts have more than about 40 subscribers: move sending to a Queue (**C7**).

**6c¾. Events tab** (built Nov. 5, pulled forward from Phase 7)
- ✅ Halifax Public Libraries' events for the next two weeks: filters, Highlights, day-by-day list.
- ✅ The library's feed refuses the Worker (**E1**), so a GitHub Action fetches it every 6 hours and posts it to the site
  (editor's decision, Nov. 5: the feed is public). Then add halifax.ca's events calendar once it has a feed.

**6c½. Transit map** (v1 shipped Nov. 4)
- ✅ Live buses and ferries, route filter, route lines, service alerts per route.
- v2: tap a stop for its next arrivals, and early/late on each bus, from the TripUpdates feed (1.4 MB; measure the
  Worker's CPU time first). Rebuild the schedule data automatically (**N8**).

**6d. Polish**
- Mobile: safe areas, chat keyboard handling, swipe back from a story, faster first load.
- Desktop: reading width, chat docked beside the story, keyboard shortcuts.
- A styleguide page that shows every component in both themes.
- An accessibility pass (contrast, focus order, screen reader labels on chat).

**Exit test:** installed on a phone, the site opens with no network and shows yesterday's stories; a test P0 notice,
once approved, reaches an opted-in phone within a minute; Lighthouse PWA and accessibility checks pass.

## Then: Phase 7, more sources (December to January)

More coverage comes from more official sources, never from a lower bar. The source scout proposes sources each Monday,
and the editor picks.

- Halifax Transit service alerts (beyond detours) and Halifax Water notices (boil orders, main breaks) as P0 notices.
- Nova Scotia Health releases that name Halifax-area sites.
- More event calendars beside the library's (halifax.ca once it has a feed, other official ones the scout finds).
- Fix or drop the Reddit signal (**N5**).
- Grow the tests to cover every source parser as it's added (**C1**), and split `mcp.ts` (**C5**).
- Data retention for chat decided and on the privacy page (**D1**); restore runbook tried once (**D2**).

**Exit test:** every new source has a parser test, a line in PLATFORM.md and a guideline; the P0 notice from each one
appears within an hour of the source posting it.

## Later: Phase 8, reach beyond the site (from February)

Only once the site is good on its own. Every post links back to the story and its room, and follows the same guidelines.

- Automatic posts for approved P0 notices on one platform first (Bluesky or Mastodon, both have open APIs), then others.
- A daily digest of the top stories, by email or a social thread, written by the desk editor and approved like a story.
- A social editor agent in the operating model, with its own audit by the standards editor.
- Simple counts: where readers came from and which notices they opened (no third-party trackers).

**Exit test:** a P0 notice is on the site and on social within the hour, with identical facts, and the editor's time on
Telegram hasn't gone up.

## Always on

- The standards editor audits every day and the source scout proposes every week.
- Update [PLATFORM.md](PLATFORM.md) and this file whenever something lands. Review [TECH-DEBT.md](TECH-DEBT.md) at the
  start of each phase.
- Change the routines' UTC crons when the clocks change (**N6**), next on March 14, 2027.
