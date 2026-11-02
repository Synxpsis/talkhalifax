// Builds scripts/seed.sql from the article documents in scripts/articles/*.json.
// Safe to re-run: stories are upserted by id.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "articles");
const out = join(here, "seed.sql");

const q = v => v == null ? "NULL" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
const now = new Date().toISOString();

const rows = readdirSync(src).filter(f => f.endsWith(".json")).map(f => {
  const id = f.slice(0, -5);
  const d = JSON.parse(readFileSync(join(src, f), "utf8"));
  const cols = {
    id, kind: d.kind, section: d.section || "City Hall", area: d.area || "",
    headline: d.headline, dek: d.dek || "",
    facts: JSON.stringify(d.facts || []), body: JSON.stringify(d.body || []), means: JSON.stringify(d.means || []),
    status_label: d.status || "", superseded_by: d.supersededBy || null, read_min: d.readMin || 1,
    reason: d.reason || "", source_url: d.source, published_at: d.publishedAt, updated_at: d.writtenAt || now,
  };
  const names = Object.keys(cols);
  const updates = names.filter(n => n !== "id").map(n => `${n} = excluded.${n}`).join(", ");
  return `INSERT INTO stories (${names.join(", ")}) VALUES (${names.map(n => q(cols[n])).join(", ")})\n  ON CONFLICT(id) DO UPDATE SET ${updates};`;
});

writeFileSync(out, rows.join("\n") + "\n");
console.log(`seed.sql: ${rows.length} stories`);
