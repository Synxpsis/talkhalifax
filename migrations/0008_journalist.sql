-- The newsroom's journalist has its own TalkHalifax account (provider 'newsroom', role 'journalist'),
-- with a public bio and a private persona, and is credited as the author of the stories it writes.
ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN persona TEXT NOT NULL DEFAULT '';
ALTER TABLE stories ADD COLUMN author_id TEXT;
