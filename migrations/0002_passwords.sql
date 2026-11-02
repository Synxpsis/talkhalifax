-- Username and password accounts. provider = 'password', provider_sub = the lower-cased username.
-- password_hash is "pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>".
ALTER TABLE users ADD COLUMN password_hash TEXT;

-- Slows down password guessing and mass sign-ups. key is e.g. 'login:<username>' or 'signup:<ip>'.
CREATE TABLE auth_throttle (
  key           TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);
