-- Scheduled check-ins: when the newsroom last re-read a developing story's source to keep it current,
-- and what it found. A check-in that changes nothing doesn't touch last_newsroom_update, so quiet stories still move to Articles.
ALTER TABLE stories ADD COLUMN last_checkin_at TEXT;
ALTER TABLE stories ADD COLUMN checkin_note TEXT NOT NULL DEFAULT '';
