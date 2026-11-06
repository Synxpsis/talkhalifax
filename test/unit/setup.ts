import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, vi } from "vitest";

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
await applyD1Migrations(e.DB, e.TEST_MIGRATIONS);

// Every test starts from an empty newsroom
beforeEach(async () => {
  for (const t of ["pending_updates", "story_versions", "room_stats", "reports", "comments", "message_index", "sessions", "auth_throttle", "stories", "users", "feeds"])
    await e.DB.prepare(`DELETE FROM ${t}`).run();
});
afterEach(() => { vi.unstubAllGlobals(); });
