-- Anonymous totals for the admin site. Nothing here says who anyone is: no user ids, no IP addresses, no session ids.
-- Each story's totals per hour. An impression is the story shown in a list; a click is the story opened from one.
CREATE TABLE story_traffic (
  hour         INTEGER NOT NULL,            -- hours since the epoch (UTC)
  story_id     TEXT NOT NULL,
  impressions  INTEGER NOT NULL DEFAULT 0,
  clicks       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, story_id)
);

-- How many people had the site open, saved every 5 minutes while anyone does.
CREATE TABLE online_samples (
  at      INTEGER PRIMARY KEY,              -- start of the 5 minutes, in ms
  online  INTEGER NOT NULL
);
