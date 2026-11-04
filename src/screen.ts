import { Env } from "./env";

/**
 * Checks a chat message or comment before anyone sees it. Returns why it can't be posted, or null if it's fine.
 *
 * Fixed rules first (instant): slurs, phone numbers, email addresses, and links from accounts under a day old.
 * Then Llama Guard on Workers AI for threats, hate, sexual content and the like. If the model is slow or down,
 * the message goes through on the rules alone, so chat never stalls.
 */

// Slurs that have no place in a city chat, matched as whole words with common letter swaps
const SLURS = /\b(n[i1!]gg(?:a|er|ah|uh)s?|f[a@]gg?(?:ot)?s?|k[i1]kes?|ch[i1]nks?|sp[i1]cs?|tr[a@]nn(?:y|ies)|wetbacks?|r[e3]t[a@]rds?|g[o0]oks?|towelheads?|sand ?n[i1]gg\w*|squaws?)\b/i;
const PHONE = /(?:\+?1[\s.-]?)?\(?\b[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}\b/;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const LINK = /\bhttps?:\/\/|\bwww\.|\b[\w-]+\.(?:com|ca|net|org|io|ly|co|me|xyz|info|biz)\b/i;
const NEW_ACCOUNT_MS = 24 * 3600_000;

// Llama Guard 3 hazard codes worth blocking here. Others (e.g. S2 "non-violent crimes", S5 "defamation")
// misfire on ordinary talk about the news, so they're let through for people and moderators to judge.
const BLOCK: Record<string, string> = {
  S1: "threats or violence", S3: "sexual violence", S4: "content sexualizing minors",
  S9: "weapons of mass harm", S10: "hate", S12: "sexual content",
};
const AIMED = /\b(you|your|you're|yours|u|ur)\b/i;
const AI_TIMEOUT_MS = 3000;

export async function screen(env: Env, text: string, author: { created_at: number }): Promise<string | null> {
  if (SLURS.test(text)) return "That wasn't posted: it contains a slur.";
  if (PHONE.test(text)) return "That wasn't posted: phone numbers can't be shared here, to keep people safe.";
  if (EMAIL.test(text)) return "That wasn't posted: email addresses can't be shared here, to keep people safe.";
  if (LINK.test(text) && Date.now() - author.created_at < NEW_ACCOUNT_MS) return "That wasn't posted: new accounts can post links after their first day.";
  if (!env.AI) return null;
  try {
    const run = env.AI.run("@cf/meta/llama-guard-3-8b", { messages: [{ role: "user", content: text }], temperature: 0 }) as Promise<{ response?: unknown }>;
    const out = await Promise.race([run, new Promise<null>(r => setTimeout(() => r(null), AI_TIMEOUT_MS))]);
    if (!out) return null;
    const found = codes(out.response);
    // "Non-violent crime" aimed at someone ("I'll burn your house down") is a threat; about the news, it's fine
    const hit = found.find(c => BLOCK[c]) || (found.includes("S2") && AIMED.test(text) ? "S1" : undefined);
    if (hit) {
      console.log("screened", hit, text.slice(0, 80));
      return `That wasn't posted: it looks like ${BLOCK[hit]}, which breaks the chat rules.`;
    }
  } catch (e) {
    console.error("screen", e);
  }
  return null;
}

/** The hazard codes in Llama Guard's answer, which comes back either as { safe, categories } or as text like "unsafe\nS10". */
function codes(r: unknown): string[] {
  if (r && typeof r === "object") {
    const o = r as { safe?: boolean; categories?: unknown[] };
    return o.safe === false ? (o.categories || []).map(c => String(c).match(/S\d+/)?.[0] || "").filter(Boolean) : [];
  }
  const s = String(r ?? "");
  return /^\s*unsafe/i.test(s) ? s.match(/S\d+/g) || [] : [];
}
