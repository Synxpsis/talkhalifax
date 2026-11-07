// Opens the real site in a real browser against a local Worker with its own throwaway data: every page by direct link,
// and every kind of story by clicking its card, at phone and desktop widths. Run before every deploy.
//   npm run test:e2e
// Uses Chrome or Edge from the system, or the one at CHROME_PATH.
import { execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const PORT = 8791, B = `http://localhost:${PORT}`;
const ADMIN_PORT = 8792, ADMIN = `http://localhost:${ADMIN_PORT}`;
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

const WEATHER = JSON.stringify({ updatedAt: now, observedAt: now, station: "Test", condition: "Sunny", tempC: 15, feelsLikeC: 15, icon: "clear", night: false, url: "https://weather.gc.ca/" });
const waterNotice = (id, headline) => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, source_url, published_at, updated_at, stage, developing_since) VALUES (${[id, "notice", "Halifax Water", "Halifax", headline, "A dek", "[]", '["A sentence."]', "[]", "https://www.halifaxwater.ca/", now, now, "developing", now].map(q).join(", ")});`;
const SEED_WATER = waterNotice("hw-e2e-shutoff", "One Street - Emergency Water Service Shut Down") + waterNotice("hw-e2e-boil", "Boil Water Advisory for one area");
// The article page's layout: a new article, an older one, and a notice that changed
const story = (id, kind, section, source, version, note, facts, body, means, actions) => `INSERT INTO stories (id, kind, section, area, headline, dek, facts, body, means, actions, source_url, published_at, updated_at, last_newsroom_update, update_note, version, stage, developing_since) VALUES (${[id, kind, section, "Halifax", id, "A dek", facts, body, means, actions, source, now, now, now, note, version, "developing", now].map(v => typeof v === "number" ? v : q(v)).join(", ")});`;
const FACTS = '[{"k":"Call","v":"902-555-0100"}]';
const SEED_LAYOUT = story("e2e-new", "article", "Province", "https://news.novascotia.ca/x", 1, "", FACTS, '["First.","## A subheading","Second."]', "[]", '["Do this by Friday."]')
  + story("e2e-old", "article", "City Hall", "https://www.halifax.ca/x", 1, "", FACTS, '["First."]', '["An older point."]', "[]")
  + story("hw-e2e-changed", "notice", "Halifax Water", "https://www.halifaxwater.ca/x", 2, "The advisory was lifted", FACTS, '["First."]', '["Boil water."]', "[]");
const SEED_WEATHER = `INSERT INTO feeds (name, body, updated_at) VALUES ('weather', '${WEATHER}', '${now}');`;

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
writeFileSync(`${DATA}/seed.sql`, `${SEED} ${SEED_WATER} ${SEED_LAYOUT} ${SEED_WEATHER}`);
npx([...WRANGLER, "d1", "execute", "talkhalifax-test", "--local", "--persist-to", DATA, "--file", `${DATA}/seed.sql`]);

const server = spawn("npx", [...WRANGLER, "dev", "--port", String(PORT), "--persist-to", DATA], { stdio: "ignore", shell: win, detached: !win, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
let adminServer;
const stopServer = (s = server) => {
  if (!s) return;
  try { if (win) execSync(`taskkill /pid ${s.pid} /T /F`, { stdio: "ignore" }); else process.kill(-s.pid); } catch { /* already gone */ }
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

    // The weather: in the header on desktop, at the bottom of the menu on phones, and it never pushes the page sideways
    {
      const p = await open("home");
      await p.waitForSelector("#hdrWx:not([hidden])", { timeout: 5000 }).catch(() => {});
      const shown = await p.evaluate(() => { const r = document.getElementById("hdrWx").getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      ok(shown === (width >= 761), `${label}: the header ${width >= 761 ? "shows" : "leaves out"} the weather`);
      ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: the header fits`);
      if (width < 761) {
        await p.click("#meBtn");
        await wait(500);
        const line = await p.evaluate(() => document.querySelector("#navDrawer .wx")?.innerText || "");
        ok(line.includes("15°C"), `${label}: the menu shows the weather`, line);
      } else {
        ok((await p.evaluate(() => document.getElementById("hdrWx").innerText)).includes("Feels like 15°C"), `${label}: it reads as feels like`);
      }
      await p.close();
    }

    // Only a boil-water advisory pins to Home; one street's emergency shut-off stays on Notices
    {
      const p = await open("home");
      const bars = await p.evaluate(() => document.getElementById("abars").innerText);
      ok(bars.includes("Boil Water Advisory"), `${label}: a boil-water advisory pins to Home`);
      ok(!bars.includes("One Street"), `${label}: a one-street shut-off doesn't`);
      await p.close();
      const n = await open("notices");
      ok((await n.evaluate(() => document.getElementById("notices").innerText)).includes("One Street"), `${label}: the shut-off is on Notices`);
      await n.close();
    }

    // The article page: what comes first, and what it says about itself
    {
      const read = async id => {
        const a = await open("article-" + id);
        await heading(a, id);
        const out = await a.evaluate(() => {
          const r = document.querySelector("#article article");
          const at = s => { const e = r.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top + scrollY) : -1; };
          return { text: r.innerText, back: document.querySelector("#article .back").innerText, kicker: r.querySelector(".kicker").innerText, byline: r.querySelector(".byline").innerText, sub: r.querySelector(".body h2:not(.means-h)")?.innerText,
            todo: at(".todo"), body: at(".body"), facts: at(".facts"), means: at(".means-h"), wide: document.documentElement.scrollWidth > innerWidth, tel: r.querySelector('.facts a[href^="tel:"]')?.innerText };
        });
        await a.close();
        return out;
      };
      const n = await read("e2e-new");
      ok(n.todo > 0 && n.todo < n.body && n.body < n.facts, `${label}: a new article runs what to do, story, key details`, JSON.stringify(n));
      ok(n.sub === "A subheading" && !n.text.includes("## "), `${label}: a body line starting ## is a subheading`);
      ok(!n.byline.includes("Updated"), `${label}: a story that never changed doesn't say Updated`, n.byline);
      ok(/1 min read/.test(n.byline) && /the Province's release/.test(n.byline), `${label}: the byline gives read time and names the source`, n.byline);
      ok(n.kicker.toUpperCase().includes("PROVINCE"), `${label}: an article outside City Hall names its section`, n.kicker);
      ok(n.tel === "902-555-0100", `${label}: a phone number can be tapped`, n.tel);
      ok(!n.wide, `${label}: the story fits the width`);
      const o = await read("e2e-old");
      ok(o.todo === -1 && o.means > o.body && o.facts > o.means, `${label}: an older article keeps its points at the bottom`, JSON.stringify(o));
      const w = await read("hw-e2e-changed");
      ok(w.kicker.toUpperCase().startsWith("HALIFAX WATER"), `${label}: a notice names its real source`, w.kicker);
      ok(w.back.includes("Notices"), `${label}: a notice goes back to Notices`, w.back);
      ok(w.todo > 0 && w.todo < w.facts && w.facts < w.body, `${label}: a notice runs what to do, facts, story`, JSON.stringify(w));
      ok(w.byline.includes("Updated") && w.text.includes("The advisory was lifted"), `${label}: a changed notice says so, and why`, w.byline);
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

  // An open page reports its anonymous counts
  {
    const p = await browser.newPage();
    const report = p.waitForResponse(r => r.url().endsWith("/api/stats"), { timeout: 8000 }).catch(() => null);
    await p.goto(`${B}/#home`, { waitUntil: "load" });
    const r = await report;
    ok(r?.status() === 204, "an open page reports its anonymous counts", r ? `HTTP ${r.status()}` : "no report");
    const stored = await p.evaluate(() => JSON.stringify({ ...localStorage }) + document.cookie);
    ok(!/[a-f0-9]{24}/.test(stored), "the counting id isn't saved in the browser");
    await p.close();
  }

  // A reset link checks its token without putting it in a URL
  {
    const p = await browser.newPage();
    const urls = [];
    p.on("request", r => urls.push(r.url().split("#")[0])); // The part after # is never sent to the server
    await p.goto(`${B}/#reset-e2e-bad-token`, { waitUntil: "load" });
    await p.waitForFunction(() => /expired or was already used/.test(document.querySelector("#reset")?.innerText || ""), { timeout: 8000 }).catch(() => {});
    ok(/expired or was already used/.test(await p.evaluate(() => document.querySelector("#reset")?.innerText || "")), "a bad reset link says so");
    ok(!urls.some(u => u.includes("e2e-bad-token")), "a reset token never appears in a request's URL");
    await p.close();
  }

  // The admin site's real config keeps it off every other address, and can't skip the sign-in check
  const adminConfig = readFileSync("admin/wrangler.jsonc", "utf8");
  ok(/"workers_dev":\s*false/.test(adminConfig), "admin config: no workers.dev address");
  ok(/"preview_urls":\s*false/.test(adminConfig), "admin config: no preview addresses");
  ok(/"run_worker_first":\s*true/.test(adminConfig), "admin config: pages go through the sign-in check");
  ok(!adminConfig.includes("ADMIN_DEV"), "admin config: doesn't set the local bypass");

  // The admin site, on the same throwaway data
  adminServer = spawn("npx", ["wrangler", "--config", "test/wrangler.admin.jsonc", "dev", "--port", String(ADMIN_PORT), "--persist-to", DATA, "--inspector-port", "9331"], { stdio: "ignore", shell: win, detached: !win, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  for (let i = 0; ; i++) {
    if (await fetch(ADMIN + "/api/summary").then(r => r.ok, () => false)) break;
    if (i > 60) throw new Error("The local admin Worker didn't start.");
    await wait(1000);
  }
  const adminErrors = [];
  for (const [width, height, label] of [[1280, 900, "desktop"], [375, 812, "phone"]]) {
    const open = async hash => {
      const p = await browser.newPage();
      p.on("pageerror", e => adminErrors.push(`${label} #${hash}: ${e.message}`));
      p.on("console", m => { if (m.type() === "error" && !/fonts\.g|ERR_NAME|ERR_INTERNET/.test(m.text() + (m.location().url || ""))) adminErrors.push(`${label} #${hash}: ${m.text()}`); });
      await p.setViewport({ width, height });
      await p.goto(`${ADMIN}/#${hash}`, { waitUntil: "load" });
      return p;
    };
    const fits = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    const h1 = p => p.evaluate(() => document.querySelector("h1")?.innerText || "");

    let p = await open("home");
    await p.waitForSelector("#charts .plot", { timeout: 8000 }).catch(() => {});
    ok(await h1(p) === "Home", `admin ${label}: Home opens`);
    ok(await p.$$eval("#charts > .card", c => c.length) === 4, `admin ${label}: Home has the four chart cards`);
    ok(await p.$$eval("#charts .plot", c => c.length) === 5, `admin ${label}: with a plot for each measure`);
    ok(await fits(p), `admin ${label}: Home fits the screen`);
    await p.click('[data-range="30d"]');
    await p.waitForFunction(() => document.querySelector('[data-range="30d"]').classList.contains("on"), { timeout: 5000 }).catch(() => {});
    ok(await p.$$eval("#charts .plot:first-child .col, #charts .plot .col", c => c.length) >= 30, `admin ${label}: the range switch redraws the charts`);
    await p.click("[data-table=signups]");
    ok(await p.$$eval("#charts .chart-table", c => c.length) === 1, `admin ${label}: a chart can show as a table`);
    await p.close();

    // Switching pages quickly shows the last one asked for, whichever answer arrives first
    p = await open("home");
    await p.evaluate(() => { location.hash = "#jobs"; location.hash = "#users"; location.hash = "#content-data"; location.hash = "#jobs"; });
    await p.waitForFunction(() => document.querySelector("h1")?.innerText === "Administration", { timeout: 5000 }).catch(() => {});
    await wait(1000);
    ok(await h1(p) === "Administration", `admin ${label}: switching quickly lands on the last page`, await h1(p));
    await p.close();

    p = await open("users");
    await p.waitForSelector("#urows", { timeout: 5000 }).catch(() => {});
    ok(await h1(p) === "Users", `admin ${label}: Users opens`);
    ok(await fits(p), `admin ${label}: Users fits the screen`);
    await p.close();

    p = await open("content");
    await p.waitForFunction(() => document.querySelector("#crows")?.innerText.includes("A story still developing"), { timeout: 5000 }).catch(() => {});
    ok((await p.evaluate(() => document.querySelector("#crows")?.innerText || "")).includes("A story still developing"), `admin ${label}: Content lists the stories`);
    ok(await fits(p), `admin ${label}: Content fits the screen`);
    await p.click('[data-screen="Notices"]');
    await p.waitForFunction(() => !document.querySelector("#crows")?.innerText.includes("A story still developing"), { timeout: 5000 }).catch(() => {});
    ok((await p.evaluate(() => document.querySelector("#crows")?.innerText || "")).includes("A notice about a road"), `admin ${label}: Content filters by screen`);
    await p.close();

    p = await open("content-data");
    await p.waitForFunction(() => document.querySelector("h1")?.innerText === "Content", { timeout: 5000 }).catch(() => {});
    ok(await fits(p), `admin ${label}: Data fits the screen`);
    await p.close();

    p = await open("jobs");
    await p.waitForFunction(() => document.querySelector("h1")?.innerText === "Administration", { timeout: 5000 }).catch(() => {});
    ok(await h1(p) === "Administration", `admin ${label}: Administration opens`);
    ok(await fits(p), `admin ${label}: Administration fits the screen`);
    await p.close();
  }
  ok(!adminErrors.length, "admin: no script errors", adminErrors.slice(0, 5).join("; "));
} finally {
  await browser?.close().catch(() => {});
  stopServer();
  stopServer(adminServer);
}
console.log(fails ? `\n${fails} failed` : "\nAll passed");
process.exit(fails ? 1 : 0);
