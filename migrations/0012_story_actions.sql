-- What a reader should do, shown at the top of a story. Older articles keep their "what this means" points at the bottom.
ALTER TABLE stories ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';  -- JSON [point]
