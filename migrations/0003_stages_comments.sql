-- Stories live in one of two stages:
--   'developing': fresh or ongoing; the article can be updated live and has a live chat
--   'archived':   shown under Articles; the chat is closed and cleared, threaded comments open
ALTER TABLE stories ADD COLUMN stage TEXT NOT NULL DEFAULT 'developing';
ALTER TABLE stories ADD COLUMN developing_since TEXT;      -- when it (re)entered Developing
ALTER TABLE stories ADD COLUMN archived_at TEXT;
ALTER TABLE stories ADD COLUMN last_newsroom_update TEXT;  -- when Claude last changed it
ALTER TABLE stories ADD COLUMN update_note TEXT NOT NULL DEFAULT '';  -- what that change was, shown to readers

-- Stories already here: the older ones become Articles; the two with dates still ahead stay Developing.
UPDATE stories SET stage = 'archived', archived_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE kind = 'article';
UPDATE stories SET stage = 'developing', developing_since = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), archived_at = NULL
  WHERE id IN ('municipality-seeks-public-input-future-st-marys-boat-club', 'applications-open-neighbourhood-placemaking-1');

-- Every version of a story the newsroom publishes, newest last.
CREATE TABLE story_versions (
  story_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,
  snapshot    TEXT NOT NULL,   -- JSON of the story fields at that version
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL,
  PRIMARY KEY (story_id, version)
);

-- Threaded comments on Articles. parent_id is null for a top-level comment; replies point at a top-level comment.
CREATE TABLE comments (
  id          TEXT PRIMARY KEY,
  story_id    TEXT NOT NULL,
  parent_id   TEXT,
  user_id     TEXT NOT NULL,
  text        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  deleted     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX comments_story ON comments(story_id, created_at);
