// Opens the real site in a real browser against a local Worker with its own throwaway data: every page by direct link,
// and every kind of story by clicking its card, at phone and desktop widths. Run before every deploy.
//   npm run test:e2e
// Uses Chrome or Edge from the system, or the one at CHROME_PATH.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const PORT = 8791, B = `http://localhost:${PORT}`;
const DATA = ".wrangler/e2e";
const WRANGLER = ["wrangler", "--config", "test/wrangler.test.jsonc"];
const win = process.platform === "win32";
const wait = ms => new Promise(r => setTimeout(r, ms));

const STORIES = [
  { id: "e2e-developing", kind: "article", stage: "developing", headline: "A story still developing", list: "home", cards: "#devCards", chat: true },
  { id: "e2e-article", kind: "article", stage: "archived", headline: "A story that has settled", list: "articles", cards: "#articles", chat: false },
  { id: "e2e-notice", kind: "notice", stage: "developing", headline: "A notice about a road", list: "notices", cards: "#notices", chat: false },
];
const q = s => `'${s}'`;
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
const SEED = STORIES.map(s => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, source_url, published_at, updated_at, stage, developing_since)
  VALUES (${[s.id, s.kind, "City Hall", "Halifax", s.headline, "A dek", "[]", '["A sentence."]', "[]", "https://www.halifax.ca/", now, now, s.stage, now].map(q).join(", ")});`).join(" ");

function browserPath() {
  const found = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
    "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(p => p && existsSync(p));
  if (!found) throw new Error("No Chrome or Edge found. Set CHROME_PATH.");
  return found;
}

const npx = args => execSync(`npx ${args.join(" ")}`, { stdio: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });

let fails = 0;
const ok = (c, label, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${label}${extra ? ` (${extra})` : ""}`); if (!c) fails++; };

rmSync(DATA, { recursive: true, force: true });
npx([...WRANGLER, "d1", "migrations", "apply", "talkhalifax-test", "--local", "--persist-to", DATA]);
writeFileSync(`${DATA}/seed.sql`, SEED);
npx([...WRANGLER, "d1", "execute", "talkhalifax-test", "--local", "--persist-to", DATA, "--file", `${DATA}/seed.sql`]);

const server = spawn("npx", [...WRANGLER, "dev", "--port", String(PORT), "--persist-to", DATA], { stdio: "ignore", shell: win, detached: !win, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
const stopServer = () => {
  try { if (win) execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" }); else process.kill(-server.pid); } catch { /* already gone */ }
};

let browser;
try {
  for (let i = 0; ; i++) {
    if (await fetch(B + "/api/stories").then(r => r.ok, () => false)) break;
    if (i > 60) throw new Error("The local Worker didn't start.");
    await wait(1000);
  }
  browser = await puppeteer.launch({ executablePath: browserPath(), headless: true, userDataDir: mkdtempSync(join(tmpdir(), "th-e2e-")), args: process.env.CI ? ["--no-sandbox"] : [] });
  const errors = [];

  for (const [width, height, label] of [[1280, 900, "desktop"], [375, 812, "phone"]]) {
    const open = async hash => {
      const p = await browser.newPage();
      p.on("pageerror", e => errors.push(`${label} #${hash}: ${e.message}`));
      await p.setViewport({ width, height, isMobile: width < 500, hasTouch: width < 500 });
      await p.goto(`${B}/#${hash}`, { waitUntil: "load" });
      await wait(500);
      return p;
    };
    const view = p => p.evaluate(() => [...document.querySelectorAll("main > section.view")].filter(s => !s.hidden).map(s => s.id).join(","));
    // A story loads from the API after the page does, so wait for it rather than guessing how long that takes
    const heading = async (p, want) => {
      if (want) await p.waitForFunction(t => document.querySelector("#article h1")?.innerText === t, { timeout: 10000 }, want).catch(() => {});
      return p.evaluate(() => document.querySelector("#article h1")?.innerText || "");
    };

    // Every page, by direct link
    for (const [hash, want] of [["home", "home"], ["articles", "articles"], ["notices", "notices"], ["events", "events"], ["transit", "transit"], ["profile", "profile"],
      ["privacy", "privacy"], ["alerts", "profile"], ["not-a-page", "home"], ["user-nobody", "user"], ["reset-nothing", "reset"]]) {
      const p = await open(hash);
      const got = await view(p);
      ok(got === want, `${label}: #${hash} shows ${want}`, got === want ? "" : `showed ${got}`);
      await p.close();
    }

    for (const s of STORIES) {
      // By direct link
      let p = await open(`article-${s.id}`);
      const direct = await heading(p, s.headline);
      ok(await view(p) === "article" && direct === s.headline, `${label}: a direct link opens the ${s.id} story`, direct);
      await p.close();

      // By clicking its card, the way readers get there
      p = await open(s.list);
      await p.waitForSelector(`${s.cards} [data-article="${s.id}"]`, { timeout: 5000 }).catch(() => {});
      const card = await p.$(`${s.cards} [data-article="${s.id}"]`);
      ok(!!card, `${label}: ${s.id} has a card on #${s.list}`);
      if (card) {
        await card.evaluate(c => c.scrollIntoView({ block: "center" }));
        await card.click();
        await wait(600);
        ok(await heading(p, s.headline) === s.headline && await view(p) === "article", `${label}: clicking the ${s.id} card opens it`, await view(p));
        ok(await p.evaluate(id => location.hash === `#article-${id}`, s.id), `${label}: the address follows`);
        if (s.chat) ok(await p.$(".chat") !== null, `${label}: ${s.id} shows its live chat`);
      }
      await p.close();
    }

    // Moving between pages without reloading
    const p = await open("home");
    await p.evaluate(() => { location.hash = "#article-e2e-notice"; });
    await wait(500);
    ok(await heading(p, "A notice about a road") === "A notice about a road", `${label}: changing the address opens a story in place`);
    await p.evaluate(() => { location.hash = "#articles"; });
    await wait(500);
    ok(await view(p) === "articles", `${label}: and goes back to a list`);
    await p.close();
  }

  ok(!errors.length, "no script errors", errors.slice(0, 5).join("; "));
} finally {
  await browser?.close().catch(() => {});
  stopServer();
}
console.log(fails ? `\n${fails} failed` : "\nAll passed");
process.exit(fails ? 1 : 0);
