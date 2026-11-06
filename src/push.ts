// Web Push alerts for urgent notices. Readers opt in on /#alerts; nothing is sent until the editor taps "Send alert"
// on Telegram for a notice. Delivery follows RFC 8291 (aes128gcm encryption) and RFC 8292 (VAPID), with WebCrypto.
// Secrets: VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (base64url), made and stored by `node scripts/vapid-keys.mjs`.
import { Env, json, SITE } from "./env";
import { allow, sameOrigin } from "./auth";

export const KINDS = ["weather", "outages", "roads", "safety", "other"] as const;
export type Kind = typeof KINDS[number];
export const KIND_LABELS: Record<Kind, string> = {
  weather: "Weather warnings", outages: "Power outages", roads: "Roads, traffic and transit",
  safety: "Police, fire and emergencies", other: "Other urgent notices",
};
const DEFAULT_KINDS: Kind[] = ["weather", "outages", "safety", "other"];
// Browsers' push services. Anything else is refused, so the Worker never posts to an address a stranger chose.
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com|wns2-[a-z0-9-]+\.notify\.windows\.com)$/;
const TTL_S = 6 * 3600, MAX_FAILURES = 5;

export const pushOn = (env: Env) => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

// ---------- encoding ----------
const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

/** RFC 8291: encrypt one message for one browser, as a single aes128gcm record. */
export async function encrypt(payload: Uint8Array, p256dh: string, authSecret: string, salt = crypto.getRandomValues(new Uint8Array(16)), local?: CryptoKeyPair) {
  const uaPublic = unb64u(p256dh);
  const pair = local ?? await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256));
  const ikm = await hkdf(unb64u(authSecret), shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const rs = new Uint8Array(4); new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, sealed);
}

/** RFC 8292: the VAPID Authorization header for one push service. */
async function vapid(env: Env, endpoint: string) {
  const pub = unb64u(env.VAPID_PUBLIC_KEY!);
  const key = await crypto.subtle.importKey("jwk",
    { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE_KEY!, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true },
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

// ---------- sending ----------
interface Sub { endpoint: string; p256dh: string; auth: string; kinds: string; quiet_start: number | null; quiet_end: number | null }

/** Which readers' choice a notice falls under. */
export function alertKind(s: { id: string; section?: string | null; headline?: string | null }): Kind {
  const t = `${s.section || ""} ${s.headline || ""}`;
  if (/^weather-/.test(s.id)) return "weather";
  if (/^ns-power-outages-/.test(s.id)) return "outages";
  if (/road|traffic|closure|detour|transit|ferry|bus|winter operations|parking ban/i.test(t)) return "roads";
  if (/police|rcmp|fire|missing|evacuat|emergenc|shelter|boil|water main|hazmat|lockdown/i.test(t)) return "safety";
  return "other";
}

/** Minutes after midnight in Halifax, now. */
const halifaxMinutes = () => {
  const [h, m] = new Date().toLocaleTimeString("en-CA", { timeZone: "America/Halifax", hour12: false, hour: "2-digit", minute: "2-digit" }).split(":").map(Number);
  return (h % 24) * 60 + m;
};
const quiet = (s: Sub, now: number) => s.quiet_start != null && s.quiet_end != null && s.quiet_start !== s.quiet_end &&
  (s.quiet_start < s.quiet_end ? now >= s.quiet_start && now < s.quiet_end : now >= s.quiet_start || now < s.quiet_end);

/** Browsers that would get an alert of this kind right now (not in their quiet hours). */
async function recipients(env: Env, kind: Kind) {
  const rows = (await env.DB.prepare("SELECT endpoint, p256dh, auth, kinds, quiet_start, quiet_end FROM push_subs").all<Sub>()).results;
  const now = halifaxMinutes();
  return rows.filter(s => { try { return JSON.parse(s.kinds).includes(kind) && !quiet(s, now); } catch { return false; } });
}
export async function countRecipients(env: Env, kind: Kind) { return (await recipients(env, kind)).length; }

async function deliver(env: Env, s: Sub, body: Uint8Array): Promise<"ok" | "gone" | "failed"> {
  try {
    const r = await fetch(s.endpoint, {
      method: "POST",
      headers: { TTL: String(TTL_S), Urgency: "high", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Authorization: await vapid(env, s.endpoint) },
      body: await encrypt(body, s.p256dh, s.auth),
    });
    if (r.status === 404 || r.status === 410) return "gone";
    return r.ok ? "ok" : "failed";
  } catch { return "failed"; }
}

/** Send a published notice to every browser that wants its kind. Returns how many it reached. */
export async function sendNotice(env: Env, id: string) {
  const s = await env.DB.prepare("SELECT id, kind, headline, dek, section, status_label, stage FROM stories WHERE id = ?")
    .bind(id).first<{ id: string; kind: string; headline: string; dek: string; section: string; status_label: string; stage: string }>();
  if (!s || s.kind !== "notice" || s.stage !== "developing") return { sent: 0, failed: 0, removed: 0, error: "Only live notices can be sent as alerts." };
  const kind = alertKind(s);
  const payload = enc.encode(JSON.stringify({
    title: s.headline.slice(0, 120), body: (s.dek || s.status_label || "").slice(0, 200),
    url: `/#article-${encodeURIComponent(s.id)}`, tag: s.id, at: Date.now(),
  }));
  const list = await recipients(env, kind);
  let sent = 0, failed = 0, removed = 0;
  // Ten at a time keeps the Worker's open connections in check
  for (let i = 0; i < list.length; i += 10) {
    const results = await Promise.all(list.slice(i, i + 10).map(async sub => [sub, await deliver(env, sub, payload)] as const));
    const now = Date.now();
    for (const [sub, r] of results) {
      if (r === "ok") { sent++; await env.DB.prepare("UPDATE push_subs SET last_sent_at = ?, failures = 0 WHERE endpoint = ?").bind(now, sub.endpoint).run(); }
      else if (r === "gone") { removed++; await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(sub.endpoint).run(); }
      else { failed++; await env.DB.prepare("UPDATE push_subs SET failures = failures + 1 WHERE endpoint = ?").bind(sub.endpoint).run(); }
    }
  }
  await env.DB.prepare("DELETE FROM push_subs WHERE failures >= ?").bind(MAX_FAILURES).run();
  await env.DB.prepare("UPDATE stories SET push_count = ? WHERE id = ?").bind(sent, id).run();
  return { sent, failed, removed, kind };
}

// ---------- readers turning alerts on and off ----------
function checkSub(raw: any, url: URL) {
  const endpoint = String(raw?.endpoint || ""), p256dh = String(raw?.keys?.p256dh || ""), auth = String(raw?.keys?.auth || "");
  let u: URL;
  try { u = new URL(endpoint); } catch { return null; }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  const okHost = (u.protocol === "https:" && PUSH_HOSTS.test(u.hostname)) || (local && (u.hostname === "127.0.0.1" || u.hostname === "localhost"));
  if (!okHost || endpoint.length > 1000 || !/^[A-Za-z0-9_-]{80,100}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}
const minutes = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n < 1440 ? n : null; };

/** /api/push (GET: is it on, and the choices) and /api/push/subscribe, /status, /unsubscribe (POST). */
export async function pushApi(req: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === "/api/push" && req.method === "GET")
    return json({ enabled: pushOn(env), publicKey: env.VAPID_PUBLIC_KEY || null, kinds: KINDS.map(k => ({ id: k, label: KIND_LABELS[k], default: DEFAULT_KINDS.includes(k) })) });
  if (req.method !== "POST" || !sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 400 });
  if (!pushOn(env)) return json({ error: "Alerts aren't switched on yet." }, { status: 503 });
  const ip = req.headers.get("cf-connecting-ip") || "local";
  if (!await allow(env, `push:${ip}`, 30, 36e5)) return json({ error: "Too many changes from here. Try again in an hour." }, { status: 429 });
  const body = await req.json<any>().catch(() => ({}));

  if (path === "/api/push/subscribe") {
    const sub = checkSub(body.subscription, url);
    if (!sub) return json({ error: "That browser's alert address wasn't recognised." }, { status: 400 });
    const kinds = Array.isArray(body.kinds) ? KINDS.filter(k => body.kinds.includes(k)) : DEFAULT_KINDS;
    if (!kinds.length) return json({ error: "Pick at least one kind of alert, or turn alerts off." }, { status: 400 });
    const qs = body.quiet ? minutes(body.quiet.start) : null, qe = body.quiet ? minutes(body.quiet.end) : null;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO push_subs (endpoint, p256dh, auth, kinds, quiet_start, quiet_end, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, kinds = excluded.kinds,
         quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, updated_at = excluded.updated_at, failures = 0`,
    ).bind(sub.endpoint, sub.p256dh, sub.auth, JSON.stringify(kinds), qs, qe, now, now).run();
    return json({ ok: true, kinds, quiet: qs != null && qe != null ? { start: qs, end: qe } : null });
  }
  const endpoint = String(body.endpoint || "").slice(0, 1000);
  if (path === "/api/push/status") {
    const r = await env.DB.prepare("SELECT kinds, quiet_start, quiet_end FROM push_subs WHERE endpoint = ?").bind(endpoint).first<{ kinds: string; quiet_start: number | null; quiet_end: number | null }>();
    return json(r ? { subscribed: true, kinds: JSON.parse(r.kinds), quiet: r.quiet_start != null && r.quiet_end != null ? { start: r.quiet_start, end: r.quiet_end } : null } : { subscribed: false });
  }
  if (path === "/api/push/unsubscribe") {
    await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?").bind(endpoint).run();
    return json({ ok: true });
  }
  return json({ error: "Not found" }, { status: 404 });
}
