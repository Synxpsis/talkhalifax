// Makes the Web Push (VAPID) key pair for alerts and stores both halves as Worker secrets, without showing the private
// key to anyone. The editor runs it once:
//   node scripts/vapid-keys.mjs
// Running it again makes a new pair, which signs everyone out of alerts (they turn them on again), so don't.
import { spawnSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";

const b64u = b => Buffer.from(b).toString("base64url");
const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicKey = b64u(await crypto.subtle.exportKey("raw", pair.publicKey));
const privateKey = (await crypto.subtle.exportKey("jwk", pair.privateKey)).d;

for (const [name, value] of [["VAPID_PRIVATE_KEY", privateKey], ["VAPID_PUBLIC_KEY", publicKey]]) {
  const r = spawnSync("npx", ["wrangler", "secret", "put", name], { input: value, stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
  if (r.status !== 0) { console.error(`\nCouldn't store ${name}. Nothing was printed; run the script again.`); process.exit(1); }
}
console.log(`\nDone. Both secrets are stored, and alerts are switched on. Public key (not secret): ${publicKey}`);
