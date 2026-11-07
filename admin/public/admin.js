// The admin site's page: Home, Users, Content and Administration. Read-only. All text from the database is escaped.
(() => {
  const main = document.getElementById("main");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = n => Number(n ?? 0).toLocaleString("en-CA");
  const short = n => n >= 1000 ? (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + "k" : String(n);
  const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Halifax", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
  const when = v => {
    if (v === null || v === undefined || v === "") return "Never";
    const ms = typeof v === "number" ? v : Date.parse(v);
    if (Number.isNaN(ms)) return "";
    const p = {};
    for (const x of parts.formatToParts(ms)) p[x.type] = x.value;
    return `${MONTHS[+p.month - 1]} ${+p.day}, ${+p.hour}:${p.minute} ${String(p.dayPeriod || "").toLowerCase().replace(/\./g, "")}`.trim();
  };
  const day = v => v ? when(v).split(",")[0] : "Never";
  const get = async path => {
    const r = await fetch(path, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  const STATE = { range: "7d", tables: {}, overview: null, hover: null, users: { q: "", role: "all" }, content: { q: "", screen: "all", status: "all" } };
  let renderId = 0;

  // ---------- charts ----------
  const CARDS = [
    { id: "online", title: "Users online", tracked: true, panels: [["online", "", "line"]],
      big: (o, s) => [num(o.onlineNow), `online now, peak of ${num(Math.max(...s.online))} in ${rangeWord()}`],
      note: "Pages with the site open, saved every 5 minutes. Each point shows the highest count in that period." },
    { id: "signups", title: "Sign-ups", panels: [["signups", "", "bar"]],
      big: (o, s) => [num(sum(s.signups)), `new members in ${rangeWord()}`],
      note: "From when each account was created. Deleted accounts aren't counted." },
    { id: "traffic", title: "Content clicks and impressions", tracked: true, panels: [["impressions", "Impressions", "line"], ["clicks", "Clicks", "line"]],
      big: (o, s) => {
        const i = sum(s.impressions), c = sum(s.clicks);
        return [num(i), `impressions, ${num(c)} clicks${i ? `, ${(c / i * 100).toFixed(1)}% clicked` : ""}, in ${rangeWord()}`];
      },
      note: "An impression is a story shown in a list, once per page load. A click is a story opened from a list." },
    { id: "messages", title: "Messages", panels: [["messages", "", "bar"]],
      big: (o, s) => [num(sum(s.messages)), `chat messages in ${rangeWord()}`],
      note: "From the saved message index, without removed messages." },
  ];
  const sum = a => a.reduce((x, y) => x + y, 0);
  const rangeWord = () => ({ "24h": "the last 24 hours", "7d": "the last 7 days", "30d": "the last 30 days" }[STATE.range]);
  const nice = v => {
    if (v <= 2) return 2;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    return [1, 2, 4, 6, 8, 10].find(m => m * p >= v) * p;
  };

  function panel(values, labels, kind, name, size, cardId, panelId) {
    const n = values.length, top = nice(Math.max(...values, 0));
    const x = i => (i + 0.5) / n * 100, y = v => 100 - v / top * 100;
    if (STATE.tables[cardId]) {
      const rows = values.map((v, i) => `<div class="chart-row"><span>${esc(labels[i])}</span><b>${num(v)}</b></div>`).reverse().join("");
      return `<div class="chart-panel">${name ? `<span class="hint">${esc(name)}</span>` : ""}<div class="chart-table ${size}" tabindex="0" aria-label="${esc(name || cardId)} values">${rows}</div></div>`;
    }
    const d = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(2)} ${y(v).toFixed(2)}`).join(" ");
    const cols = values.map((v, i) => `<div class="col" data-i="${i}">${kind === "bar" ? `<div class="bar" data-h="${(v / top * 100).toFixed(2)}"></div>` : ""}</div>`).join("");
    return `<div class="chart-panel">${name ? `<span class="hint">${esc(name)}</span>` : ""}
      <div class="plotwrap"><div class="plot ${size}" role="img" data-panel="${panelId}" data-kind="${kind}"
        aria-label="${esc(name || cardId)} chart, from ${esc(labels[0])} to ${esc(labels[n - 1])}. Latest value ${num(values[n - 1])}. Show as a table lists every value.">
        <div class="gl" data-top="0"><span>${short(top)}</span></div><div class="gl" data-top="50"><span>${short(top / 2)}</span></div><div class="gl" data-top="100"><span>0</span></div>
        ${kind === "line" ? `<svg class="lineplot" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"></path></svg><div class="dot"></div>` : ""}
        <div class="cols">${cols}</div>
      </div></div>
      <div class="xlabels"><span>${esc(labels[0])}</span><span>${esc(labels[Math.floor((n - 1) / 2)])}</span><span>${esc(labels[n - 1])}</span></div>
    </div>`;
  }

  /** Sizes and positions go through el.style, which the page's security policy allows, and hover needs no re-render. */
  function wireCharts(o) {
    main.querySelectorAll(".gl").forEach(g => { g.style.top = g.dataset.top + "%"; });
    main.querySelectorAll(".bar").forEach(b => { b.style.height = b.dataset.h + "%"; });
    main.querySelectorAll(".plot").forEach(plot => {
      const values = o.series[plot.dataset.panel], n = values.length, top = nice(Math.max(...values, 0));
      const isLine = plot.dataset.kind === "line", dot = plot.querySelector(".dot");
      const place = i => { if (dot) { dot.style.left = (i + 0.5) / n * 100 + "%"; dot.style.top = 100 - values[i] / top * 100 + "%"; } };
      place(n - 1);
      let tip = null, cross = null, on = null;
      const clear = () => {
        tip?.remove(); cross?.remove(); tip = cross = null;
        on?.classList.remove("on"); on = null;
        plot.classList.remove("hovering");
        place(n - 1);
      };
      plot.addEventListener("mouseleave", clear);
      plot.addEventListener("mouseover", e => {
        const col = e.target.closest(".col");
        if (!col || col === on) return;
        clear();
        const i = +col.dataset.i, pct = (i + 0.5) / n * 100;
        on = col; col.classList.add("on"); plot.classList.add("hovering");
        place(i);
        if (isLine) { cross = document.createElement("div"); cross.className = "cross"; cross.style.left = pct + "%"; plot.append(cross); }
        tip = document.createElement("div");
        tip.className = "tip";
        tip.style.left = pct + "%";
        tip.style.transform = `translateX(${pct < 25 ? 0 : pct > 75 ? -100 : -50}%)`;
        tip.textContent = `${o.labels[i]}: `;
        const b = document.createElement("b"); b.textContent = num(values[i]); tip.append(b);
        plot.append(tip);
      });
    });
  }

  function chartsHtml(o) {
    return CARDS.map(c => {
      const [big, cap] = c.big(o, o.series);
      const tall = c.panels.length === 1;
      const counting = c.tracked && (o.countingSince ? `Counting started ${day(o.countingSince)}.` : "Counting starts with the next visitor.");
      return `<div class="card">
        <div class="head"><span class="label">${esc(c.title)}</span></div>
        <div><div class="chart-big">${esc(big)}</div><span class="hint">${esc(cap)}</span></div>
        ${c.panels.map(([id, name, kind]) => panel(o.series[id], o.labels, kind, name, tall ? "tall" : "short", c.id, id)).join("")}
        <span class="hint">${esc(c.note)}${counting ? ` ${esc(counting)}` : ""}</span>
        <button type="button" class="btn link" data-table="${c.id}">${STATE.tables[c.id] ? "Show the chart" : "Show as a table"}</button>
      </div>`;
    }).join("");
  }

  async function drawCharts() {
    const box = document.getElementById("charts");
    if (!box) return;
    const id = renderId;
    const o = await get(`/api/overview?range=${STATE.range}`);
    if (id !== renderId) return;
    STATE.overview = o;
    box.innerHTML = chartsHtml(o);
    wireCharts(o);
    document.querySelectorAll("[data-range]").forEach(b => {
      const on = b.dataset.range === STATE.range;
      b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on));
    });
  }

  // ---------- pages ----------
  const STATE_WORDS = { ok: ["Working", "ok"], late: ["Late", "caution"], failing: ["Failing", "warn"], missing: ["No data", "warn"] };
  const statePill = (s, failures) => {
    const [word, cls] = STATE_WORDS[s] || [s, ""];
    return `<span class="pill ${cls}">${esc(word)}${failures ? ` (${num(failures)})` : ""}</span>`;
  };

  async function home() {
    const id = renderId;
    const s = await get("/api/summary");
    if (id !== renderId) return;
    const needs = [];
    const bad = s.jobs.filter(j => j.state !== "ok");
    if (s.openReports) needs.push(`<div class="todo"><span>${num(s.openReports)} ${s.openReports === 1 ? "report" : "reports"} to decide, on your profile on the site</span><a class="btn" href="https://talkhalifax.ca/#profile" rel="noopener" target="_blank">Open the site</a></div>`);
    if (s.drafts) needs.push(`<div class="todo"><span>${num(s.drafts)} ${s.drafts === 1 ? "story" : "stories"} waiting for approval on Telegram</span><a class="btn" href="#content?status=waiting">See them</a></div>`);
    if (s.pendingUpdates) needs.push(`<div class="todo"><span>${num(s.pendingUpdates)} ${s.pendingUpdates === 1 ? "change" : "changes"} to published stories waiting on Telegram</span></div>`);
    if (bad.length) needs.push(`<div class="todo"><span>${bad.length > 3 ? `${num(bad.length)} jobs need` : `${esc(bad.map(j => j.name).join(", "))} ${bad.length === 1 ? "needs" : "need"}`} a look</span><a class="btn" href="#jobs">See jobs</a></div>`);
    main.innerHTML = `<div><h1 class="h1">Home</h1><p class="lede">What needs you, how the site is doing, then one card for each part of it.</p></div>
      <div class="card"><div class="head"><h2 class="h2">Needs you</h2></div><div>${needs.join("") || `<div class="empty">Nothing right now.</div>`}</div></div>
      <div class="head"><h2 class="h2">Over time</h2><div class="filters">
        ${[["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"]].map(([k, l]) => `<button type="button" class="chip" data-range="${k}">${l}</button>`).join("")}
      </div></div>
      <div class="charts" id="charts"><div class="card"><span class="hint">Loading the charts</span></div></div>
      <div class="grid3">
        <div class="card"><span class="label">Users</span><div class="nums">
          <div class="num"><b>${num(s.members)}</b><span>members</span></div><div class="num"><b>${num(s.newThisWeek)}</b><span>new this week</span></div>
          <div class="num"><b>${num(s.postedThisWeek)}</b><span>posted this week</span></div><div class="num"><b>${num(s.openReports)}</b><span>open reports</span></div>
        </div><a class="btn" href="#users">Open Users</a></div>
        <div class="card"><span class="label">Content</span><div class="nums">
          <div class="num"><b>${num(s.drafts)}</b><span>waiting for you</span></div><div class="num"><b>${num(s.developing + s.notices)}</b><span>active</span></div>
          <div class="num"><b>${num(s.articles)}</b><span>archived</span></div><div class="num"><b>${num(s.events)}</b><span>upcoming events</span></div>
        </div><a class="btn" href="#content">Open Content</a></div>
        <div class="card"><span class="label">Administration</span><div class="nums">
          <div class="num"><b>${num(s.developing)}</b><span>open chat rooms</span></div><div class="num"><b>${num(s.inRooms)}</b><span>people in them now</span></div>
          <div class="num"><b>${num(s.jobs.length - bad.length)}/${num(s.jobs.length)}</b><span>jobs working</span></div>
        </div><a class="btn" href="#jobs">Open Administration</a></div>
      </div>`;
    await drawCharts();
  }

  const roleWord = r => ({ member: "Member", moderator: "Moderator", journalist: "Journalist" }[r] || r);
  async function usersPage() {
    const f = STATE.users, id = renderId;
    const s = await get("/api/summary");
    if (id !== renderId) return;
    main.innerHTML = `<div><h1 class="h1">Users</h1><p class="lede">Everyone with an account. Bans, reset links and reports stay on each person's profile on the site for now.</p></div>
      <div class="nums">
        <div class="card num"><b>${num(s.members)}</b><span>members</span></div><div class="card num"><b>${num(s.newThisWeek)}</b><span>joined this week</span></div>
        <div class="card num"><b>${num(s.postedThisWeek)}</b><span>posted this week</span></div><div class="card num"><b>${num(s.banned)}</b><span>banned</span></div>
      </div>
      <div class="card"><div class="head"><h2 class="h2">Everyone</h2></div>
        <div class="filters">
          <input class="filter grow" type="search" id="uq" aria-label="Search by name or username" placeholder="Search by name or username" value="${esc(f.q)}">
          <select class="filter" id="urole" aria-label="Filter by role">
            ${[["all", "All roles"], ["member", "Members"], ["moderator", "Moderators"], ["journalist", "Journalist"], ["banned", "Banned"]].map(([k, l]) => `<option value="${k}"${f.role === k ? " selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div id="urows"></div>
      </div>`;
    await drawUsers();
  }
  async function drawUsers() {
    const box = document.getElementById("urows");
    if (!box) return;
    const id = renderId, f = STATE.users;
    const d = await get(`/api/users?q=${encodeURIComponent(f.q)}&role=${encodeURIComponent(f.role)}`);
    if (id !== renderId) return;
    const rows = d.users.map(u => {
      const status = u.banned ? `<span class="pill warn">Banned</span>` : u.openReports ? `<span class="pill caution">${num(u.openReports)} open ${u.openReports === 1 ? "report" : "reports"}</span>` : `<span class="pill">Good standing</span>`;
      return `<div class="tr g-users">
        <a class="who" href="https://talkhalifax.ca/#user-${encodeURIComponent(u.id)}" target="_blank" rel="noopener">${esc(u.name || u.username || "No name")}${u.username ? `<span>@${esc(u.username)}</span>` : ""}</a>
        <span class="mono">${esc(day(u.joined))}</span><span>${esc(roleWord(u.role))}</span><span class="mono">${num(u.messages)}</span><span class="mono">${esc(day(u.lastPost))}</span><span>${status}</span>
      </div>`;
    }).join("");
    box.innerHTML = d.users.length
      ? `<div class="tw"><div class="t"><div class="tr th g-users"><span>Person</span><span>Joined</span><span>Role</span><span>Messages</span><span>Last post</span><span>Status</span></div>${rows}</div></div>
         <p class="hint">Showing ${num(d.users.length)} of ${num(d.total)}, newest first. Password accounts have no email address, and this site never shows Google ones.</p>`
      : `<div class="empty">Nobody matches that.</div>`;
  }

  const tabs = active => `<div class="tabs"><a class="tab${active === "all" ? " on" : ""}" href="#content">Everything</a><a class="tab${active === "data" ? " on" : ""}" href="#content-data">Data</a></div>`;
  const STATUS = { waiting: ["Waiting for you", "caution"], active: ["Active", "ok"], archived: ["Archived", ""] };

  async function contentPage() {
    const f = STATE.content;
    const chips = ["all", "Developing", "Articles", "Notices", "Events"].map(k => `<button type="button" class="chip${f.screen === k ? " on" : ""}" data-screen="${k}" aria-pressed="${f.screen === k}">${k === "all" ? "All screens" : k}</button>`).join("");
    main.innerHTML = `<div><h1 class="h1">Content</h1><p class="lede">Everything on the site, on every screen. Clicks and impressions are for the last 30 days.</p></div>${tabs("all")}
      <div class="card"><div class="filters">${chips}</div>
        <div class="filters">
          <input class="filter grow" type="search" id="cq" aria-label="Search headlines" placeholder="Search headlines" value="${esc(f.q)}">
          <select class="filter" id="cstatus" aria-label="Filter by status">
            ${[["all", "Any status"], ["waiting", "Waiting for you"], ["active", "Active"], ["archived", "Archived"]].map(([k, l]) => `<option value="${k}"${f.status === k ? " selected" : ""}>${l}</option>`).join("")}
          </select>
        </div>
        <div id="crows"></div>
      </div>`;
    await drawContent();
  }
  async function drawContent() {
    const box = document.getElementById("crows");
    if (!box) return;
    const id = renderId, f = STATE.content;
    const d = await get(`/api/content?screen=${encodeURIComponent(f.screen)}&status=${encodeURIComponent(f.status)}&q=${encodeURIComponent(f.q)}`);
    if (id !== renderId) return;
    const rows = d.items.map(i => {
      const [word, cls] = STATUS[i.status] || [i.status, ""];
      const title = i.url ? `<a class="who" href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : `<span class="who">${esc(i.title)}</span>`;
      const nums = i.impressions === null ? `<span class="mono">None</span><span class="mono">None</span>` : `<span class="mono">${num(i.impressions)}</span><span class="mono">${num(i.clicks)}</span>`;
      return `<div class="tr g-content">${title}<span>${esc(i.screen)}</span>
        <span><span class="pill ${cls}">${esc(word)}</span>${i.label ? ` <span class="hint">${esc(i.label)}</span>` : ""}</span>
        <span class="hint">${esc(i.source)}</span><span class="mono">${esc(day(i.updatedAt))}</span>
        <span class="mono">${i.messages === null ? "None" : num(i.messages)}</span>${nums}</div>`;
    }).join("");
    box.innerHTML = d.items.length
      ? `<div class="tw"><div class="t"><div class="tr th g-content"><span>Headline</span><span>Screen</span><span>Status</span><span>Source</span><span>Updated</span><span>Chat</span><span>Impressions</span><span>Clicks</span></div>${rows}</div></div>
         <p class="hint">Showing ${num(d.items.length)} of ${num(d.total)}. Looks through the ${num(d.limit)} most recently updated stories, plus upcoming events.</p>`
      : `<div class="empty">Nothing matches that.</div>`;
  }

  async function dataPage() {
    const id = renderId;
    const [s, d] = await Promise.all([get("/api/summary"), get("/api/data")]);
    if (id !== renderId) return;
    main.innerHTML = `<div><h1 class="h1">Content</h1><p class="lede">How much is on each screen, and where it comes from.</p></div>${tabs("data")}
      <div class="nums">
        <div class="card num"><b>${num(s.developing)}</b><span>developing</span></div><div class="card num"><b>${num(s.notices)}</b><span>notices</span></div>
        <div class="card num"><b>${num(s.articles)}</b><span>articles, chat closed</span></div><div class="card num"><b>${num(s.events)}</b><span>upcoming events</span></div>
      </div>
      <div class="card"><div class="head"><h2 class="h2">Live feeds</h2></div>
        <div class="tw"><div class="t"><div class="tr th g-data"><span>Feed</span><span>Shows on</span><span>Last arrived</span><span>Health</span></div>
        ${d.feeds.map(f => `<div class="tr g-data"><span>${esc(f.name)}</span><span class="hint">${esc(f.shows)}</span><span class="mono">${esc(when(f.lastAt))}</span><span>${statePill(f.state)}</span></div>`).join("")}
        </div></div></div>
      <div class="card"><div class="head"><h2 class="h2">Sources of published stories</h2></div>
        ${d.sources.length ? `<div class="tw"><div class="t"><div class="tr th g-sources"><span>Source</span><span>Stories</span><span>Newest</span></div>
        ${d.sources.map(x => `<div class="tr g-sources"><span>${esc(x.name)}</span><span class="mono">${num(x.stories)}</span><span class="mono">${esc(when(x.last))}</span></div>`).join("")}
        </div></div>` : `<div class="empty">No published stories yet.</div>`}
      </div>`;
  }

  async function jobsPage() {
    const id = renderId;
    const d = await get("/api/jobs");
    if (id !== renderId) return;
    main.innerHTML = `<div><h1 class="h1">Administration</h1><p class="lede">Feature switches, banners and announcements come in a later stage. For now, the jobs that keep the site running.</p></div>
      <div class="card"><div class="head"><h2 class="h2">Jobs behind the site</h2></div>
        <div class="tw"><div class="t"><div class="tr th g-jobs"><span>Job</span><span>What it does</span><span>Last run</span><span>Result</span><span>Every</span></div>
        ${d.jobs.map(j => `<div class="tr g-jobs"><span>${esc(j.name)}</span><span class="hint">${esc(j.does)}</span><span class="mono">${esc(when(j.lastAt))}</span><span>${statePill(j.state, j.failures)}</span><span class="mono">${esc(j.every)}</span></div>`).join("")}
        </div></div>
        <span class="hint">A failure also reaches you on Telegram after two in a row. "Library events" and "Transit schedule" show when each job was last started, not whether it finished.</span>
      </div>`;
  }

  // ---------- routing and events ----------
  async function route() {
    const id = ++renderId;
    const [page, query] = location.hash.slice(1).split("?");
    const cat = page === "users" ? "users" : page === "content" || page === "content-data" ? "content" : page === "jobs" ? "jobs" : "home";
    document.querySelectorAll(".cat").forEach(a => {
      const on = a.dataset.cat === cat;
      a.classList.toggle("on", on);
      if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (query && page === "content") Object.assign(STATE.content, { status: new URLSearchParams(query).get("status") || "all", screen: "all", q: "" });
    try {
      await (page === "users" ? usersPage() : page === "content" ? contentPage() : page === "content-data" ? dataPage() : page === "jobs" ? jobsPage() : home());
    } catch (e) {
      if (id === renderId) main.innerHTML = `<div class="card"><p class="error">That didn't load (${esc(e.message)}). Try reloading the page.</p></div>`;
    }
  }

  const later = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const liveUsers = later(() => drawUsers().catch(() => {}));
  const liveContent = later(() => drawContent().catch(() => {}));
  main.addEventListener("input", e => {
    if (e.target.id === "uq") { STATE.users.q = e.target.value; liveUsers(); }
    if (e.target.id === "cq") { STATE.content.q = e.target.value; liveContent(); }
  });
  main.addEventListener("change", e => {
    if (e.target.id === "urole") { STATE.users.role = e.target.value; liveUsers(); }
    if (e.target.id === "cstatus") { STATE.content.status = e.target.value; liveContent(); }
  });
  main.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.range) { STATE.range = b.dataset.range; drawCharts().catch(() => {}); }
    if (b.dataset.table) {
      STATE.tables[b.dataset.table] = !STATE.tables[b.dataset.table];
      document.getElementById("charts").innerHTML = chartsHtml(STATE.overview);
      wireCharts(STATE.overview);
    }
    if (b.dataset.screen) {
      STATE.content.screen = b.dataset.screen;
      main.querySelectorAll("[data-screen]").forEach(c => { const on = c === b; c.classList.toggle("on", on); c.setAttribute("aria-pressed", String(on)); });
      drawContent().catch(() => {});
    }
  });
  window.addEventListener("hashchange", route);
  route();
})();
