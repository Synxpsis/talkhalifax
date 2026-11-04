-- Readers flag a chat message or comment for a moderator. One row per reporter per item.
CREATE TABLE reports (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,              -- 'message' | 'comment'
  target_id    TEXT NOT NULL,              -- the message or comment id
  story_id     TEXT NOT NULL,
  author_id    TEXT NOT NULL,              -- who wrote it
  text         TEXT NOT NULL,              -- a copy at report time, so it can be judged after removal
  reporter_id  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  resolved     TEXT,                       -- null while open, then 'removed' | 'dismissed'
  UNIQUE (target_id, reporter_id)
);
CREATE INDEX reports_open ON reports(resolved, created_at);

-- One-time password reset links a moderator makes for someone locked out. Only a hash of the token is kept.
CREATE TABLE password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0
);
