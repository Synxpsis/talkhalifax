-- The newsroom's shared to-do list: possible stories that agents file, claim and close.
CREATE TABLE leads (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  source_published_at TEXT,
  status        TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'claimed' | 'done' | 'dropped'
  claimed_by    TEXT,
  claimed_at    INTEGER,
  story_id      TEXT,                           -- the story it became or updated
  notes         TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX leads_source ON leads(source_url);
CREATE INDEX leads_status ON leads(status, created_at);

-- Stories can also be 'draft' (waiting for a moderator to approve) or 'discarded'. Neither is ever shown publicly.
-- Who wrote each version, so the review queue and history can say which agent did what.
ALTER TABLE story_versions ADD COLUMN author TEXT NOT NULL DEFAULT '';
