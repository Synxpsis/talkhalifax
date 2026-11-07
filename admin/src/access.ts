// Checks the signed token Cloudflare Access adds to every request it lets through. The Access login page is the front
// door; this check means that anything that somehow reaches the Worker without passing it is still refused.
interface Jwk extends JsonWebKey { kid?: string }
interface Claims { aud?: string | string[]; iss?: string; exp?: number; nbf?: number }

const KEYS_FOR_MS = 36e5, REFRESH_AFTER_MS = 60_000, SKEW_S = 60;
let cache: { team: string; at: number; keys: Jwk[] } | null = null;

/** Forget the cached signing keys. For tests. */
export const forgetKeys = () => { cache = null; };

/** An Access team's own address, and nothing else: keys are fetched from here and tokens must name it as their issuer. */
export const validTeam = (team: string) => /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team);

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), c => c.charCodeAt(0));
const jsonPart = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64url(s)));

async function signingKeys(team: string, now: number, refresh: boolean): Promise<Jwk[]> {
  // A token with an unknown key id asks for a refresh, so those are limited: bad tokens can't make us fetch on every request
  if (cache && cache.team === team && now - cache.at < (refresh ? REFRESH_AFTER_MS : KEYS_FOR_MS)) return cache.keys;
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`, { redirect: "error" });
  if (!r.ok) throw new Error(`Access keys: HTTP ${r.status}`);
  const keys = (await r.json<{ keys?: Jwk[] }>()).keys || [];
  if (!keys.length) throw new Error("Access keys: none returned"); // Keeps any good keys we already have
  cache = { team, at: now, keys };
  return keys;
}

/** True only for a token Access signed, for this application, that's still in date. Never throws on a bad token. */
export async function validAccessToken(token: string, team: string, aud: string, now = Date.now()): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const header = jsonPart<{ alg?: string; kid?: string }>(parts[0]);
    // Only the algorithm Access uses. The token doesn't get to pick how it's checked.
    if (header.alg !== "RS256" || !header.kid) return false;
    let jwk = (await signingKeys(team, now, false)).find(k => k.kid === header.kid);
    // Access rotates its keys, so one we haven't seen may just be new
    if (!jwk) jwk = (await signingKeys(team, now, true)).find(k => k.kid === header.kid);
    if (!jwk) return false;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), signed)) return false;
    const c = jsonPart<Claims>(parts[1]), seconds = now / 1000;
    const auds = Array.isArray(c.aud) ? c.aud : [c.aud];
    return auds.includes(aud) && c.iss === `https://${team}`
      && typeof c.exp === "number" && c.exp > seconds - SKEW_S
      && (c.nbf === undefined || c.nbf <= seconds + SKEW_S);
  } catch {
    return false;
  }
}
