// The newsroom's command line: how the refresh task (Claude) reads and publishes TalkHalifax stories.
//
//   node scripts/newsroom.mjs list
//       Every story on the site: id, kind, stage, version, headline. Read-only, no token needed.
//   node scripts/newsroom.mjs publish <file.json> [id]
//       Creates the story, or updates it if the id exists. The id defaults to the file name.
//       The file uses the article-guidelines shape (kind, headline, dek, facts [{k, v}], body, means,
//       status, supersededBy, readMin, reason, source, publishedAt, area, section), plus optional
//       "note" (what changed, shown to readers on updates) and "reopen" (true brings an Article back to Developing).
//       For an update, include only the fields that change.
//   node scripts/newsroom.mjs tool <name> [json | @file.json]
//       Calls one newsroom MCP tool (scan_sources, read_release, get_guidelines, list_leads, claim_lead, publish_story,
//       update_story, …) and prints its result. For agents that can't connect to /mcp directly. `tool list` names them.
//   node scripts/newsroom.mjs wait-review <id>
//       Waits (up to 9 minutes per run) for the editor to approve or discard a draft (story id) or a held update
//       (its pending id, e.g. u12) on Telegram, then prints
//       approved, discarded, expired, or waiting (run it again).
//
// Site: TALKHALIFAX_URL (default https://talkhalifax.alexwmmolloy.workers.dev)
// Token: TALKHALIFAX_TOKEN, or the .newsroom-token file at the project root.
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.TALKHALIFAX_URL || "https://talkhalifax.alexwmmolloy.workers.dev").replace(/\/$/, "");
const [cmd, file, idArg] = process.argv.slice(2);

function token() {
  if (process.env.TALKHALIFAX_TOKEN) return process.env.TALKHALIFAX_TOKEN.trim();
  try { return readFileSync(join(root, ".newsroom-token"), "utf8").trim(); }
  catch { throw new Error("No newsroom token: set TALKHALIFAX_TOKEN or create .newsroom-token"); }
}

// Guideline field names → API field names (the rest are the same)
const RENAME = { status: "statusLabel" };
const ALLOWED = new Set(["kind", "section", "area", "headline", "dek", "facts", "body", "means", "statusLabel", "supersededBy", "readMin", "reason", "source", "publishedAt", "note", "reopen"]);

async function list() {
  const r = await fetch(`${BASE}/api/stories`);
  if (!r.ok) throw new Error(`list failed: ${r.status}`);
  for (const s of (await r.json()).stories) {
    console.log([s.id, s.kind, s.stage, `v${s.version}`, s.headline].join("\t"));
  }
}

async function publish() {
  if (!file) throw new Error("usage: publish <file.json> [id]");
  const id = idArg || basename(file).replace(/\.json$/, "");
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const body = {};
  for (const [k, v] of Object.entries(doc)) {
    const name = RENAME[k] || k;
    if (ALLOWED.has(name) && v !== undefined) body[name] = v;
  }
  const r = await fetch(`${BASE}/api/newsroom/stories/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`publish ${id} failed: ${r.status} ${out.error || ""}`);
  if (out.pending) return console.log(`update to ${id} is waiting for the editor's approval: wait-review ${out.pending}`);
  if (out.stage === "draft") return console.log(`created ${id} as a draft, waiting for the editor's approval: wait-review ${id}`);
  console.log(`${out.created ? "created" : "updated"} ${id} v${out.version}${out.reopened ? " (back to Developing)" : ""}`);
}

async function rpc(method, params) {
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok || out.error) throw new Error(`${method} failed: ${r.status} ${out.error?.message || ""}`);
  return out.result;
}

async function tool() {
  const name = file;
  if (!name) throw new Error("usage: tool <name> [json | @file.json]");
  if (name === "list") {
    for (const t of (await rpc("tools/list", {})).tools) console.log(`${t.name}\t${t.description}`);
    return;
  }
  const raw = idArg?.startsWith("@") ? readFileSync(idArg.slice(1), "utf8") : idArg || "{}";
  const res = await rpc("tools/call", { name, arguments: JSON.parse(raw) });
  console.log(res.content.map(c => c.text).join("\n"));
  if (res.isError) process.exitCode = 1;
}

async function waitReview() {
  const id = file;
  if (!id) throw new Error("usage: wait-review <id>");
  const stop = Date.now() + 9 * 60_000; // inside a 10-minute shell timeout
  for (;;) {
    const res = await rpc("tools/call", { name: "await_review", arguments: { id, wait: 90 } });
    const text = res.content.map(c => c.text).join("\n");
    if (res.isError) { console.log(text); process.exitCode = 1; return; }
    const { decision } = JSON.parse(text);
    if (decision !== "waiting" || Date.now() >= stop) { console.log(text); return; }
  }
}

const run = { list, publish, tool, "wait-review": waitReview }[cmd];
if (!run) { console.error("usage: node scripts/newsroom.mjs list | publish <file.json> [id] | tool <name> [json | @file.json] | wait-review <id>"); process.exit(2); }
run().catch(e => { console.error(e.message); process.exit(1); });
