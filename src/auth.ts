import { Env, User, json, randomId } from "./env";

const SESSION_COOKIE = "th_session";
const STATE_COOKIE = "th_oauth";
const SESSION_DAYS = 30;

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  (req.headers.get("cookie") || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

const isLocal = (url: URL) => url.hostname === "localhost" || url.hostname === "127.0.0.1";

function setCookie(url: URL, name: string, value: string, maxAge: number) {
  // Secure everywhere except plain-http localhost during development
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isLocal(url) ? "" : "; Secure"}`;
}

export function providers(env: Env, url: URL) {
  return {
    password: true,
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    dev: env.DEV_LOGIN === "1" && isLocal(url),
  };
}

// ---------- Passwords ----------
// PBKDF2-SHA256 with a random 16-byte salt. 100,000 rounds is the most Workers' WebCrypto allows.
const PBKDF2_ROUNDS = 100_000;
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array, rounds: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: rounds }, key, 256);
}
async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ROUNDS}$${b64(salt)}$${b64(await pbkdf2(password, salt, PBKDF2_ROUNDS))}`;
}
async function verifyPassword(password: string, stored: string) {
  const [alg, rounds, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2-sha256") return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Number(rounds)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]; // constant time
  return diff === 0;
}
// Used when the username doesn't exist, so a wrong username takes as long as a wrong password
const DUMMY_HASH = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const USERNAME = /^[a-z0-9_.-]{3,20}$/;

// ---------- Throttling ----------
/** Counts events per key in a fixed window; returns false once the limit is reached. */
export async function allow(env: Env, key: string, limit: number, windowMs: number) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, window_start FROM auth_throttle WHERE key = ?").bind(key).first<{ count: number; window_start: number }>();
  if (!row || now - row.window_start > windowMs) {
    await env.DB.prepare("INSERT INTO auth_throttle (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start")
      .bind(key, now).run();
    return true;
  }
  if (row.count >= limit) return false;
  await env.DB.prepare("UPDATE auth_throttle SET count = count + 1 WHERE key = ?").bind(key).run();
  return true;
}
const clearThrottle = (env: Env, key: string) => env.DB.prepare("DELETE FROM auth_throttle WHERE key = ?").bind(key).run();

/** JSON POSTs must come from this site: blocks other sites from signing people in or out behind their backs. */
export function sameOrigin(req: Request, url: URL) {
  const origin = req.headers.get("origin");
  return !!origin && origin === url.origin && (req.headers.get("content-type") || "").startsWith("application/json");
}

async function readCreds(req: Request) {
  let body: { username?: unknown; password?: unknown } = {};
  try { body = await req.json(); } catch { /* handled below */ }
  return { username: String(body.username ?? "").trim().toLowerCase(), password: String(body.password ?? "") };
}

async function passwordSignup(req: Request, env: Env, url: URL) {
  const { username, password } = await readCreds(req);
  if (!USERNAME.test(username)) return json({ error: "Usernames are 3 to 20 characters: letters, numbers, dots, dashes or underscores." }, { status: 400 });
  if (password.length < 8 || password.length > 200) return json({ error: "Use a password of at least 8 characters." }, { status: 400 });
  if (password.toLowerCase() === username) return json({ error: "Your password can't be the same as your username." }, { status: 400 });
  const ip = req.headers.get("cf-connecting-ip") || "local";
  if (!(await allow(env, `signup:${ip}`, 5, 3600_000))) return json({ error: "Too many new accounts from this connection. Try again in an hour." }, { status: 429 });
  const taken = await env.DB.prepare("SELECT 1 FROM users WHERE provider = 'password' AND provider_sub = ?").bind(username).first();
  if (taken) return json({ error: "That username is taken. Try another." }, { status: 409 });

  const admins = (env.ADMIN_USERNAMES || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const id = randomId("u_", 10);
  try {
    await env.DB.prepare(
      "INSERT INTO users (id, provider, provider_sub, name, avatar_url, email, role, created_at, password_hash) VALUES (?, 'password', ?, ?, '', '', ?, ?, ?)",
    ).bind(id, username, username, admins.includes(username) ? "moderator" : "member", Date.now(), await hashPassword(password)).run();
  } catch {
    return json({ error: "That username is taken. Try another." }, { status: 409 }); // lost a race for the same name
  }
  return sessionJson(env, url, id);
}

async function passwordLogin(req: Request, env: Env, url: URL) {
  const { username, password } = await readCreds(req);
  if (!username || !password) return json({ error: "Enter your username and password." }, { status: 400 });
  const key = `login:${username}`;
  if (!(await allow(env, key, 10, 15 * 60_000))) return json({ error: "Too many tries. Wait 15 minutes and try again." }, { status: 429 });
  const user = await env.DB.prepare("SELECT id, role, password_hash FROM users WHERE provider = 'password' AND provider_sub = ?")
    .bind(username).first<{ id: string; role: string; password_hash: string }>();
  const ok = await verifyPassword(password, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) return json({ error: "That username and password don't match." }, { status: 401 });
  await clearThrottle(env, key);
  // A username added to ADMIN_USERNAMES after sign-up picks up the role at next sign-in
  const admins = (env.ADMIN_USERNAMES || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (admins.includes(username) && user.role !== "moderator") await env.DB.prepare("UPDATE users SET role = 'moderator' WHERE id = ?").bind(user.id).run();
  return sessionJson(env, url, user.id);
}

async function sessionJson(env: Env, url: URL, userId: string) {
  const sid = randomId("s_", 24);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(sid, userId, now, now + SESSION_DAYS * 864e5).run();
  return json({ ok: true }, { headers: { "set-cookie": setCookie(url, SESSION_COOKIE, sid, SESSION_DAYS * 86400) } });
}

/** The signed-in user for this request, or null. */
export async function currentUser(req: Request, env: Env): Promise<User | null> {
  const sid = cookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  return await env.DB.prepare(
    `SELECT u.id, u.name, u.avatar_url, u.email, u.role, u.banned
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at > ?`,
  ).bind(sid, Date.now()).first<User>();
}

async function upsertUser(env: Env, p: { provider: string; sub: string; name: string; avatar: string; email: string }) {
  const admins = env.ADMIN_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const role = p.email && admins.includes(p.email.toLowerCase()) ? "moderator" : "member";
  const existing = await env.DB.prepare("SELECT id FROM users WHERE provider = ? AND provider_sub = ?")
    .bind(p.provider, p.sub).first<{ id: string }>();
  if (existing) {
    // Keep name and photo current; never demote a moderator here
    await env.DB.prepare(
      `UPDATE users SET name = ?, avatar_url = ?, email = ?, role = CASE WHEN role = 'moderator' THEN role ELSE ? END WHERE id = ?`,
    ).bind(p.name, p.avatar, p.email, role, existing.id).run();
    return existing.id;
  }
  const id = randomId("u_", 10);
  await env.DB.prepare(
    "INSERT INTO users (id, provider, provider_sub, name, avatar_url, email, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, p.provider, p.sub, p.name, p.avatar, p.email, role, Date.now()).run();
  return id;
}

async function startSession(env: Env, url: URL, userId: string, returnTo: string) {
  const sid = randomId("s_", 24);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(sid, userId, now, now + SESSION_DAYS * 864e5).run();
  return new Response(null, {
    status: 302,
    headers: new Headers([
      ["location", safeReturn(returnTo)],
      ["set-cookie", setCookie(url, SESSION_COOKIE, sid, SESSION_DAYS * 86400)],
      ["set-cookie", setCookie(url, STATE_COOKIE, "", 0)],
    ]),
  });
}

/** Only same-site paths, so sign-in can't be used to bounce people to another site. */
const safeReturn = (r: string | null | undefined) => (r && r.startsWith("/") && !r.startsWith("//") ? r : "/");

export async function handleAuth(req: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const p = providers(env, url);

  if (path === "/auth/google" && req.method === "GET") {
    if (!p.google) return json({ error: "Google sign-in isn't configured" }, { status: 503 });
    const state = randomId("", 16);
    const returnTo = safeReturn(url.searchParams.get("return"));
    const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    auth.search = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: `${url.origin}/auth/google/callback`,
      response_type: "code", scope: "openid email profile", state, prompt: "select_account",
    }).toString();
    return new Response(null, {
      status: 302,
      headers: { location: auth.toString(), "set-cookie": setCookie(url, STATE_COOKIE, `${state}|${returnTo}`, 600) },
    });
  }

  if (path === "/auth/google/callback" && req.method === "GET") {
    if (!p.google) return json({ error: "Google sign-in isn't configured" }, { status: 503 });
    const [expected, returnTo] = (cookies(req)[STATE_COOKIE] || "").split("|");
    const code = url.searchParams.get("code");
    if (!code || !expected || url.searchParams.get("state") !== expected) return new Response("Sign-in expired. Please try again.", { status: 400 });
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${url.origin}/auth/google/callback`, grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) return new Response("Google sign-in failed. Please try again.", { status: 502 });
    const { access_token } = await tokenRes.json<{ access_token: string }>();
    const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${access_token}` } });
    if (!infoRes.ok) return new Response("Google sign-in failed. Please try again.", { status: 502 });
    const info = await infoRes.json<{ sub: string; name?: string; picture?: string; email?: string; email_verified?: boolean }>();
    const userId = await upsertUser(env, {
      provider: "google", sub: info.sub, name: info.name || "", avatar: info.picture || "",
      email: info.email_verified ? info.email || "" : "",
    });
    return startSession(env, url, userId, returnTo);
  }

  // Localhost-only sign-in for development: /auth/dev?name=Alex
  if (path === "/auth/dev" && req.method === "GET") {
    if (!p.dev) return new Response("Not found", { status: 404 });
    const name = (url.searchParams.get("name") || "Dev user").slice(0, 40);
    const userId = await upsertUser(env, { provider: "dev", sub: name.toLowerCase(), name, avatar: "", email: url.searchParams.get("email") || "" });
    return startSession(env, url, userId, url.searchParams.get("return") || "/");
  }

  if ((path === "/auth/signup" || path === "/auth/login") && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "Bad request" }, { status: 403 });
    return path === "/auth/signup" ? passwordSignup(req, env, url) : passwordLogin(req, env, url);
  }

  if (path === "/auth/logout" && req.method === "POST") {
    const sid = cookies(req)[SESSION_COOKIE];
    if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
    return json({ ok: true }, { headers: { "set-cookie": setCookie(url, SESSION_COOKIE, "", 0) } });
  }

  return null;
}
