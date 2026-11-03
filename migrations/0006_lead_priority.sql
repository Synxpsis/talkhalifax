-- Leads get a news category (which sets their priority) and an attention signal (e.g. Google Trends searches),
-- so the journalist works the stories people are most likely to care about first.
ALTER TABLE leads ADD COLUMN category TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN attention INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN attention_note TEXT NOT NULL DEFAULT '';
