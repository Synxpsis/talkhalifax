# TalkHalifax design system

_The rules the site is built on. The tokens live in `:root` at the top of `public/index.html`; this file explains them.
Change a token there, not a colour in a rule._

## The idea

**White, frosted and quiet.** Home is a grid of glass cards on a near-white page. Each story is a room: the article on
the left, its live chat docked beside it. After dark the same system turns to **Charcoal**. Only the colour tokens change.
Colour is held back: ink on paper, with red and amber kept for warnings, and one "splash" colour still to be chosen.

It should feel native: on a phone like an app (no zoom, safe-area aware, sheets and drawers, 44px targets, pull to
refresh when added to the home screen), and on a desktop like a calm reading room with the conversation beside it.

## Colour tokens

| Token | Light | Charcoal | Use |
|---|---|---|---|
| `--surface-page` | `#f5f6f7` | `#1c1d1f` | Page background (also on `html`, so glass blurs the right colour) |
| `--surface-solid` | `#ffffff` | `#26282b` | Fields, solid panels |
| `--surface-sunken` | `#eef0f2` | `#18191b` | Chat bubbles, wells |
| `--surface-glass` | white 62% | `#2c2e32` 58% | Cards, header, chat (with `--glass-blur`) |
| `--surface-glass-hover` | white 82% | `#34373b` 72% | Hovered cards |
| `--edge-glass` | ink 7% | white 8% | Glass borders |
| `--line` | `#e3e5e8` | `#35383c` | Dividers |
| `--ink` | `#121417` | `#edeeef` | Text, primary buttons |
| `--ink-muted` | `#5b6168` | `#a3a8ae` | Secondary text |
| `--ink-faint` | `#7e848b` | `#7a7f86` | Hints, off switches |
| `--on-ink` | `#ffffff` | `#121417` | Text on an ink fill |
| `--signal-warn` | `#b3261e` | `#f2a49e` | Warnings, errors, LIVE |
| `--signal-caution` | `#8a5a00` | `#e8be6a` | Watches, advisories |
| `--signal-ok` | `#1d6a86` | `#8ecbe0` | Confirmations |
| `--banner-warn` | `#fbeceb` | `#3a2422` | Solid band behind a city notice or weather warning |
| `--banner-caution` | `#f7f0e3` | `#332b1b` | Solid band behind a watch or statement |
| `--splash` | = `--ink` | = `--ink` | The accent. Points at ink until a brand colour is chosen |

Older names (`--bg`, `--glass`, `--muted`, `--accent`, `--warn`, …) are aliases of these. New code uses the new names.

Rules:
- Text on any surface meets WCAG AA (4.5:1 body, 3:1 large). Check both themes when adding a colour.
- Signal colours mean something. Never use red or amber for decoration.
- Alert banners are solid, never glass, so they read at a glance over anything.

## Type

| Role | Font | Use |
|---|---|---|
| Display `--f-display` | Inter Tight 600/700 | Page titles (32px), section titles (28px), the wordmark (21px), card headlines |
| Body `--f-body` | Inter 400–700, 16px / 1.55 | Everything else |
| Reading `--f-read` | Inter | Deks (19px / 1.45) and story body |
| Mono `--f-mono` | JetBrains Mono | Bylines, times, roles, small data |

Headlines use `letter-spacing: -.025em` and `text-wrap: balance`. Labels (kickers, section heads) are 12px, 600,
uppercase, `.1em` tracking. Reading width stays under about 68ch.

## Shape, depth, motion

- Radii: `--radius-s` 8px (small controls), `--radius-m` 12px (buttons, banners), `--radius-l` 18px (cards, forms);
  pills are fully round.
- Depth comes from glass (`--shadow-glass`, `--glass-blur: blur(20px) saturate(1.2)`), not heavy shadows.
- Motion is short and functional: the chat sliding, an update flashing, pull to refresh. Everything has a
  `prefers-reduced-motion: reduce` fallback.

## Layout and breakpoints

| Width | Layout |
|---|---|
| ≥ 960px | Story with the chat docked on the right (`--chatw` 400px), full header nav |
| < 960px | The chat becomes a bottom sheet; its header bar toggles it |
| < 760px | Header sections move into the drawer behind the profile button; lead card stops spanning two columns |
| < 560px | Phone spacing: tighter gutters, smaller section titles, shallower reply indents |

Page gutters are `max(28px, safe-area inset)`. The viewport disables pinch zoom (it's an app-like surface), so
text sizes must already be readable: 16px body minimum on inputs to stop iOS zooming.

## Components

| Component | Class | Notes |
|---|---|---|
| Header | `header`, `.name`, `.hnav`, `.me-btn` | Sticky glass bar under the safe area; the profile button opens the drawer |
| Transit map | `.tr-*` (styles in `public/transit.js`) | Map and glass side panel. Under 760px the map fills the screen below the header, with the route bar and a details sheet floating on it as glass (service alerts start folded). Buses are `--ink` markers with a direction pointer, ferries `--signal-ok`. Positron or Dark map style follows the colour scheme |
| Events | `.ev-*` (styles in `public/events.js`) | Filter chips (`.nfilters`) for when and who, an area select, Highlights as story cards (photo only when the library has a real one, not its stock banners), then a day-by-day list: time, title, branch, audience pill, caution-coloured flags (Registration required, Full), Cancelled in warn colour and struck through. A row opens in place with details and the library link. Under 760px the chips scroll sideways |
| Alerts | `.al-*` (styles in `public/alerts.js`) | A section of the profile, "Alerts on this device" (signed in or not; `#alerts` links scroll to it): kinds as 44px checkboxes, quiet hours with hour selects, one ink button. `.al-offer` is the glass offer under a notice |
| Offline bar | `.offline-bar` | Sticky caution band under the header while there's no connection |
| Install card | `.install` dialog | Opened by Install the app where the browser has no install prompt (iPhone and iPad always). Numbered steps with the Share or ⋮ icon drawn inline; tap outside or × to close |
| Global footer | `.site-foot` | Anchored to the bottom (the body is a full-height column and `main` grows), on every view (hidden under the full-screen Transit map on phones) on the sunken surface. The brand row (app icon, wordmark, one line) sits beside three columns: Read (every section), Stay in the loop (Get alerts; Install the app, on phones and wherever the browser offers its install prompt, hidden inside the installed app; profile; privacy) and Our sources (official sites, ↗ external). The fine print sits under a hairline. Four columns on desktop; two under 860px, with sources full width under 560px. Clears the docked chat |
| App icon | `public/icons/` | A Halifax skyline (lighthouse, the Macdonald Bridge, City Hall's clock tower, the Dominion Building, a church spire, towers behind) over the harbour, navy on pale blue, no words. Rounded for `any`; full-bleed with the skyline inside the 80% safe zone for `maskable`; square for Apple's touch icon; the 32 px favicon is cropped to the bridge and clock tower |
| Drawer | `.drawer`, `.dr-*` | Phone navigation and account, a native `<dialog>` |
| Story card | `.card` (`.lead` spans 2) | Glass; kicker, headline, dek, pills, live viewer count |
| Pill | `.pill` | Status labels (LIVE, Update, area) |
| Alert banner | `.abar` | Solid band on Home for city notices and weather warnings |
| Facts | `.facts` | Two-column label/value grid, copied facts only |
| Byline | `.byline`, `.author-card` | Mono; links to the author's profile |
| Chat | `.chat`, `.msgs`, `.grp`, `.bubble`, `.composer`, `.send` | Docked on desktop, sheet on mobile |
| Comments | `.comments-sec`, `.cm`, `.creplies` | Archived articles, threaded one level |
| Button | `.btn`, `.send`, `.danger-btn` | 44px minimum; ink fill for the main action |
| Switch | `.switch` | Settings |
| Forms | `.auth-form`, `.auth-err` (`.ok`), `.ts-box` | Sign-in, sign-up with Turnstile, reset |
| Moderation | `.report`, `.mod-tools`, `.rep-done`, `.reset-link` | Moderators only |
| Legal | `.legal` | Privacy page reading width |

## Voice in the interface

Plain Canadian English, short and specific. Say what happened and what to do: "That wasn't posted: phone numbers can't
be shared here, to keep people safe." No exclamation marks, no "Oops", no em dashes. Buttons name the action
("Remove it", "Make a password reset link").

## Accessibility checklist

- Every control 44×44px minimum, a visible `:focus-visible` ring, keyboard-reachable.
- Colour never carries meaning alone (warnings also say "Warning").
- Live regions for chat and updates; `prefers-reduced-motion` respected.
- Both themes checked at 375px and 1440px before shipping a visual change.

## Next for the native experience

- Choose the `--splash` brand colour.
- A small component page (`/#styleguide`, moderators only) that renders every component in both themes, for review.
