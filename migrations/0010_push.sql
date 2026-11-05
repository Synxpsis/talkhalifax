-- Push alerts for urgent notices. One row per browser that turned alerts on; nothing ties it to an account.
CREATE TABLE push_subs (
  endpoint     TEXT PRIMARY KEY,           -- the browser's push service address
  p256dh       TEXT NOT NULL,              -- the browser's public key (base64url), for encrypting alerts
  auth         TEXT NOT NULL,              -- the browser's auth secret (base64url)
  kinds        TEXT NOT NULL,              -- JSON array: weather, outages, roads, safety, other
  quiet_start  INTEGER,                    -- quiet hours, minutes after midnight Halifax time (null: none)
  quiet_end    INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_sent_at INTEGER,
  failures     INTEGER NOT NULL DEFAULT 0  -- delivery failures in a row; the row goes after 5
);

-- When the editor sent a notice as a push alert, and to how many browsers (null: not sent)
ALTER TABLE stories ADD COLUMN push_sent_at INTEGER;
ALTER TABLE stories ADD COLUMN push_count INTEGER;
