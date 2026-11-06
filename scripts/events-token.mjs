// Makes the token the GitHub Action uses to post library events, and stores it in both places it's needed, without
// showing it to anyone: the Worker secret EVENTS_TOKEN and the GitHub repository secret EVENTS_TOKEN. Run once:
//   node scripts/events-token.mjs
// Needs wrangler logged in to the Cloudflare account and gh logged in to GitHub. Running it again replaces the token.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const token = randomBytes(32).toString("base64url");
const shell = process.platform === "win32";
for (const [label, cmd, args] of [
  ["the Worker secret", "npx", ["wrangler", "secret", "put", "EVENTS_TOKEN"]],
  ["the GitHub secret", "gh", ["secret", "set", "EVENTS_TOKEN"]],
]) {
  const r = spawnSync(cmd, args, { input: token, stdio: ["pipe", "inherit", "inherit"], shell });
  if (r.status !== 0) { console.error(`\nCouldn't store ${label}. Nothing was printed; run the script again.`); process.exit(1); }
}
console.log("\nDone. EVENTS_TOKEN is stored on the Worker and in GitHub. Run the Events workflow from the Actions tab to load events now.");
