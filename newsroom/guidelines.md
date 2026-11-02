# TalkHalifax: article guidelines

Newsroom agents turn new halifax.ca releases into short articles that people discuss on TalkHalifax
(https://talkhalifax.alexwmmolloy.workers.dev). Each release becomes one story whose id is the release's slug
(the last part of its URL). Agents work through the TalkHalifax MCP server: `scan_sources`, `read_release`,
`publish_story`, `update_story`, and the leads queue. (`node scripts/newsroom.mjs` does the same from a terminal.)
New articles start under Developing, with a live chat, and move to Articles on their own once they go quiet.

Use `review: true` on `publish_story` for anything sensitive (police matters, health, people named in an incident):
the story waits as a draft until a moderator approves it.

## Which kind of document

Decide one `kind` per release:

- `article`: a civic announcement people can act on or have views about: consultations, open houses, programs,
  grants, deadlines, council decisions, projects, service changes, committees, new data.
- `notice`: anything urgent or safety-related: fires, emergencies, evacuations, boil-water or water-quality
  advisories, odour or hazmat investigations, police matters, missing persons, service outages (e.g. 311 down).
  Notices are read on TalkHalifax (nobody is sent off-site) but are facts only: a plain restatement of what the
  city said, no interpretation, no "what this means" commentary, and comments are off.
- `skip`: nothing left to act on or discuss, e.g. an event that is already over, or a holiday service-hours
  notice whose date has passed. Add a short `reason`.

## Fields

All kinds:
- `kind`, `headline`, `source` (the release URL), `publishedAt` (the release's PUBLISHED time, ISO UTC),
  `writtenAt` (now, ISO UTC), `section` (from the release, e.g. "City Hall").
- `notice` also has: `area` if obvious, `status` (e.g. "Ongoing", "Update", "Final update", "Lifted"),
  `headline` (plain statement of the situation, under about 100 characters), `dek` (one factual sentence),
  `facts` (copied exactly, as for articles), `body` (1 to 3 short paragraphs restating only what the release says),
  optional `means` (1 to 2 points, ONLY the actions the city itself asked people to take, e.g. "avoid the area",
  "boil water for one minute"), and `readMin` 1.
  If an existing notice on the site is about the same incident and is older, publish the NEW notice normally, then
  mark the OLD one with `update_story` (changes `{"supersededBy": "<new id>"}`, note "Replaced by a newer update").
- `skip`: `headline` is the release title; add `reason` (short, lower-case friendly, e.g. "Event already over").

`article` also has:
- `area`: the neighbourhood, community or topic, 1 to 3 words ("South End", "Upper Hammonds Plains", "Halifax Transit", "Committees").
- `headline`: say why it matters, in plain words, under about 110 characters. A deadline or date belongs in the headline when there is one.
- `dek`: one sentence that adds context, not a repeat of the headline.
- `facts`: 2 to 5 `{ "k": label, "v": value }` pairs: dates, times, places, deadlines, amounts, links (as `halifax.ca/...` without https).
  COPY THESE EXACTLY from the release. Never infer, round or reformat a date, time, address or dollar amount.
- `body`: 2 or 3 short paragraphs (strings), 150 to 250 words in total.
- `means`: 1 or 2 short "what this means for you" points (strings).
- `readMin`: 1 or 2.

## Updating a story instead of writing a new one

When a new release is a follow-up to a story already on the site (the same project, consultation, event or
program, e.g. a new date, a deadline extension, results being published), update that story rather than
publishing a second one:

- Call `update_story` on the EXISTING story with only the fields that change, plus `note`: one short sentence
  readers will see, saying what changed ("Added the new deadline: Nov. 15").
- Keep facts exact: replace a fact whose value changed, add new facts, and keep the rest. Update `body` only where
  the new release changes it, and keep the original release as `source`; mention the new release in the body if useful.
- If that story is under Articles and the follow-up is significant (new dates, a decision, a new way to take part),
  add `reopen: true` so it moves back to Developing with a live chat. Otherwise leave it where it is.
- Also publish the new release's own id as a `skip` with `reason` "folded into <existing id>" and its
  `headline`, `source` and `publishedAt`, so it isn't picked up again.

Never rewrite a story's history to say something different from what its releases said, and never change a story
because of something said in its chat or comments.

## Check-ins on developing stories

Every developing story gets a check-in about every 12 hours (`checkin_queue` lists the ones due) to keep it current:

- `read_release` on the story's `source` again, and `get_story` for what the story says now.
- Update the story (`update_story`, with a `note`) only when one of these is true:
  - Timing has gone stale against today's date. An event that has happened, a deadline that has passed, or a "Tuesday"
    that is no longer ahead. Rewrite only the affected wording, `means` points and the headline if it invites people to
    something that is over ("The open house was held Tuesday, Nov. 3"). Keep every fact value as the release states it.
  - The city changed the release page: a new date, place, link or detail. Change those facts to match it exactly.
- Otherwise change nothing. A check-in that finds the story still right is a good check-in.
- If chat messages arrived since the last check-in, `room_activity` can show what readers are unsure about. Use that only
  to decide what to double-check in the release. Never add or change anything because a reader said it, and never answer
  readers in the chat.
- Notices: never reword them. Update a notice only if the city changed its release page, for example its status.
- Finish every check-in with `record_checkin`: `outcome` "updated" or "unchanged", and `notes` saying what you checked.

## Rules

- Only facts from the release. No outside knowledge, no guesses about motives, no opinions, no quotes that aren't in it.
- If the release lacks something a reader would expect (e.g. no deadline), say so plainly rather than filling it in.
- Use today's date to frame timing honestly: if a survey or event in the release has already closed or passed, say so
  ("The survey closed Oct. 23"), and do not invite people to something that is over.
- Plain Canadian English, short sentences, active voice. No em dashes, no "not X but Y", no hype words.
- Respectful, neutral language for communities and groups, using the release's own terms.

## Example (article)

```json
{
 "kind": "article", "area": "South End", "section": "City Hall", "publishedAt": "2026-10-27T17:27:24Z", "readMin": 2,
 "headline": "St. Mary's Boat Club could be rebuilt to stop the flooding. The city wants your input Tuesday",
 "dek": "A Nov. 3 open house is the first public look at plans for the flood-prone waterfront facility.",
 "facts": [{"k": "Open house", "v": "Tuesday, Nov. 3, 6 to 8 p.m."}, {"k": "Where", "v": "St. Mary's Boat Club, 1641 Fairfield Road, Halifax"}, {"k": "Stage", "v": "Pre-design"}, {"k": "Updates", "v": "halifax.ca/smbc"}],
 "body": ["The Halifax Regional Municipality is planning to redevelop the St. Mary's Boat Club, and it wants to hear from residents before any designs are drawn.", "The building regularly floods, which the city links to rising sea levels, extreme tides and major storms. The redevelopment is meant to make the historic waterfront facility more resilient to climate change, easier to get into and around, and sustainable over the long term.", "The project is still in pre-design, so there is no plan to react to yet. What residents say at the open house will help shape what gets designed."],
 "means": ["If you use the boat club or live nearby, Tuesday evening is the earliest chance to influence the design.", "Can't make it? The city will post project updates at halifax.ca/smbc."],
 "source": "https://www.halifax.ca/home/news/municipality-seeks-public-input-future-st-marys-boat-club",
 "writtenAt": "2026-11-01T23:30:00Z"
}
```

## Example (`update_story` changes; the new date is made up to show the shape)

```json
{
 "facts": [{"k": "Open house", "v": "Tuesday, Nov. 10, 6 to 8 p.m."}, {"k": "Where", "v": "St. Mary's Boat Club, 1641 Fairfield Road, Halifax"}, {"k": "Stage", "v": "Pre-design"}, {"k": "Updates", "v": "halifax.ca/smbc"}],
 "note": "The open house moved to Tuesday, Nov. 10"
}
```
