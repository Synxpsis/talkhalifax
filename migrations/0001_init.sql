-- People. One row per account; the provider id is what we match on at sign-in.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,               -- our own opaque id, e.g. u_3f9c…
  provider      TEXT NOT NULL,                  -- 'google' | 'dev'
  provider_sub  TEXT NOT NULL,                  -- the provider's stable subject id
  name          TEXT NOT NULL DEFAULT '',
  avatar_url    TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'member', -- 'member' | 'moderator'
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  UNIQUE (provider, provider_sub)
);

-- Sign-in sessions. The cookie holds only the random id.
CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Stories: articles and city notices. The current version is kept inline; history comes in Phase 2.
CREATE TABLE stories (
  id             TEXT PRIMARY KEY,              -- release slug
  kind           TEXT NOT NULL,                 -- 'article' | 'notice' | 'skip'
  status         TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
  section        TEXT NOT NULL DEFAULT 'City Hall',
  area           TEXT NOT NULL DEFAULT '',
  headline       TEXT NOT NULL,
  dek            TEXT NOT NULL DEFAULT '',
  facts          TEXT NOT NULL DEFAULT '[]',    -- JSON [{k, v}]
  body           TEXT NOT NULL DEFAULT '[]',    -- JSON [paragraph]
  means          TEXT NOT NULL DEFAULT '[]',    -- JSON [point]
  status_label   TEXT NOT NULL DEFAULT '',      -- notices: 'Final update', …
  superseded_by  TEXT,
  read_min       INTEGER NOT NULL DEFAULT 1,
  reason         TEXT NOT NULL DEFAULT '',      -- skips
  source_url     TEXT NOT NULL,
  published_at   TEXT NOT NULL,                 -- the source's publish time, ISO UTC
  version        INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL
);
CREATE INDEX stories_published ON stories(published_at DESC);

-- Live numbers each room reports for the home page cards.
CREATE TABLE room_stats (
  story_id         TEXT PRIMARY KEY,
  message_count    INTEGER NOT NULL DEFAULT 0,
  here_now         INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER,
  last_author_id   TEXT,
  updated_at       INTEGER NOT NULL
);

-- A copy of every message, so profiles can list "your recent messages" without visiting every room.
CREATE TABLE message_index (
  id          TEXT PRIMARY KEY,
  story_id    TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX message_index_user ON message_index(user_id, created_at DESC);

-- Small live feeds (weather and tides), refreshed by the cron trigger.
CREATE TABLE feeds (
  name        TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
