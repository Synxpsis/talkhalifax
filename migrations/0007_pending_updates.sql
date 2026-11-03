-- Once the editor's Telegram is set up, the newsroom's changes to published stories wait here for approval.
CREATE TABLE pending_updates (
  n          INTEGER PRIMARY KEY AUTOINCREMENT,   -- the update's ref is "u<n>"
  story_id   TEXT NOT NULL,
  input      TEXT NOT NULL,                       -- the update_story changes, note and reopen, as JSON
  author     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'waiting',     -- 'waiting' | 'approved' | 'discarded'
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX pending_updates_story ON pending_updates(story_id, status);
