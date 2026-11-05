// TalkHalifax: the Events tab. Loaded by app.js the first time someone opens #events.
// Events come from /api/events (Halifax Public Libraries' events feed, the next two weeks), shown as the library lists
// them: when, where, who it's for, and a link to the library's page for details and registration.
(function () {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
  const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const WHEN = [["today", "Today"], ["weekend", "This weekend"], ["week", "This week"], ["all", "Next two weeks"]];
  const WHO = [["all", "Everyone"], ["kids", "Kids and families"], ["teens", "Teens"], ["adults", "Adults"]];
  const AUDIENCE_OF = { kids: ["Preschoolers", "Kids", "All Ages"], teens: ["Teens", "All Ages"], adults: ["Adults", "All Ages"] };
  const REFRESH_MS = 10 * 60_000;

  let root, data = null, loadedAt = 0, error = "";
  const F = { when: "week", who: "all", area: "", open: null };
  try { Object.assign(F, JSON.parse(localStorage.getItem("th-events") || "{}"), { open: null }); } catch (e) {}
  const save = () => { try { localStorage.setItem("th-events", JSON.stringify({ when: F.when, who: F.who, area: F.area })); } catch (e) {} };

  // ---------- dates, in Halifax time (the feed gives local times as YYYY-MM-DDTHH:MM) ----------
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Halifax" });
  const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const weekday = ymd => new Date(ymd + "T12:00:00Z").getUTCDay();
  function dayLabel(ymd) {
    const t = today();
    const d = new Date(ymd + "T12:00:00Z");
    const date = `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
    return ymd === t ? `Today · ${date}` : ymd === addDays(t, 1) ? `Tomorrow · ${date}` : date;
  }
  /** "10:30 a.m.", "2 p.m.", "noon" */
  function clock(local) {
    const [h, m] = local.slice(11, 16).split(":").map(Number);
    if (h === 12 && !m) return "noon";
    return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "a.m." : "p.m."}`;
  }
  const span = e => e.endLocal && e.endLocal.slice(0, 10) === e.startLocal.slice(0, 10) && e.endLocal !== e.startLocal
    ? `${clock(e.startLocal)} to ${clock(e.endLocal)}` : clock(e.startLocal);
  const shortDay = ymd => { const d = new Date(ymd + "T12:00:00Z"); return `${DAYS[d.getUTCDay()].slice(0, 3)}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
  const ago = iso => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

  /** The days (YYYY-MM-DD, inclusive) the "when" filter covers. */
  function range() {
    const t = today(), wd = weekday(t);
    if (F.when === "today") return [t, t];
    if (F.when === "weekend") return wd === 0 ? [t, t] : wd === 6 ? [t, addDays(t, 1)] : [addDays(t, 6 - wd), addDays(t, 7 - wd)];
    if (F.when === "week") return [t, addDays(t, 6)];
    return [t, "9999"];
  }
  function visible() {
    const [from, to] = range();
    return (data?.events || []).filter(e => {
      const d = e.startLocal.slice(0, 10);
      if (d < from || d > to) return false;
      if (F.who !== "all" && !e.audiences.some(a => AUDIENCE_OF[F.who].includes(a))) return false;
      return !F.area || e.city === F.area;
    });
  }
  /** Up to six one-of-a-kind events the library features, or special events, performances and author talks. */
  function highlights(list) {
    const seen = new Set();
    return list.filter(e => e.highlight && !e.cancelled)
      .sort((a, b) => Number(b.featured) - Number(a.featured) || Number(!!b.image) - Number(!!a.image) || a.start.localeCompare(b.start))
      .filter(e => !seen.has(e.title) && seen.add(e.title)).slice(0, 6)
      .sort((a, b) => a.start.localeCompare(b.start));
  }

  // ---------- page ----------
  const flags = e => [
    e.cancelled ? `<span class="ev-flag warn">Cancelled</span>` : "",
    !e.cancelled && e.registration === "full" ? `<span class="ev-flag">Full</span>` : "",
    !e.cancelled && e.registration === "required" ? `<span class="ev-flag">Registration required</span>` : "",
    e.virtual ? `<span class="ev-flag">Online</span>` : "",
  ].join("");
  const who = e => e.audiences.length ? e.audiences.join(", ") : "";
  const key = e => e.id + e.start;

  function filters() {
    const areas = [...new Set((data?.events || []).map(e => e.city).filter(Boolean))].sort();
    if (F.area && !areas.includes(F.area)) F.area = "";
    const seg = (name, opts, label) => `<div class="nfilters ev-seg" role="group" aria-label="${label}">${opts.map(([v, t]) =>
      `<button type="button" data-${name}="${v}" aria-pressed="${F[name] === v}">${t}</button>`).join("")}</div>`;
    return `<div class="ev-filters">
      ${seg("when", WHEN, "When")}
      <div class="ev-row2">${seg("who", WHO, "Who it's for")}
        <label class="ev-area"><span class="sr">Area</span><select id="evArea"><option value="">All areas</option>${areas.map(a => `<option${a === F.area ? " selected" : ""}>${esc(a)}</option>`).join("")}</select></label>
      </div></div>`;
  }

  function card(e) {
    return `<button type="button" class="card glass ev-card${e.image ? " pic" : ""}" data-open="${esc(key(e))}">
      ${e.image ? `<span class="ev-img" style="background-image:url('${esc(e.image)}')" role="img" aria-label=""></span>` : ""}
      <span class="k">${esc(shortDay(e.startLocal.slice(0, 10)))} · ${esc(clock(e.startLocal))}</span>
      <span class="tt">${esc(e.title)}</span>
      <span class="dk">${esc(e.summary)}</span>
      <span class="ft"><span>${esc(e.place.replace(/ Public Library$/, ""))}</span>${who(e) ? `<span class="pill">${esc(who(e))}</span>` : ""}</span>
    </button>`;
  }

  function row(e) {
    const open = F.open === key(e);
    return `<li class="ev-item${e.cancelled ? " off" : ""}">
      <button type="button" class="ev-line" data-open="${esc(key(e))}" aria-expanded="${open}">
        <span class="ev-time">${esc(clock(e.startLocal))}</span>
        <span class="ev-main"><b>${esc(e.title)}</b>
          <span class="ev-where">${esc(e.place)}${e.city && !e.place.includes(e.city) ? ` · ${esc(e.city)}` : ""}</span>
          <span class="ev-tags">${who(e) ? `<span class="pill">${esc(who(e))}</span>` : ""}${flags(e)}</span>
        </span>
      </button>
      ${open ? `<div class="ev-more">
        <p class="ev-when">${esc(dayLabel(e.startLocal.slice(0, 10)).replace(/^(Today|Tomorrow) · /, ""))}, ${esc(span(e))}${e.room ? ` · ${esc(e.room)}` : ""}</p>
        ${e.summary ? `<p>${esc(e.summary)}</p>` : ""}
        ${e.types.length ? `<p class="ev-types">${e.types.map(esc).join(" · ")}</p>` : ""}
        <a class="ev-link" href="${esc(e.url)}" target="_blank" rel="noopener">Details${e.registration ? " and registration" : ""} on the library's site ↗</a>
      </div>` : ""}
    </li>`;
  }

  function render() {
    if (!root) return;
    let html = `<div class="forum-top"><h1>Events</h1></div>
      <p class="forum-lede">What's on at Halifax Public Libraries over the next two weeks: talks, workshops, story times, games and more.</p>`;
    if (!data) { root.innerHTML = html + `<div class="msg">${esc(error || "Loading…")}</div>`; return; }
    const list = visible(), hl = list.length > 8 ? highlights(list) : [];
    html += filters();
    if (hl.length) html += `<h2 class="n-sub ev-sub">Highlights</h2><div class="cards ev-hl">${hl.map(card).join("")}</div>`;
    const days = new Map();
    for (const e of list) { const d = e.startLocal.slice(0, 10); if (!days.has(d)) days.set(d, []); days.get(d).push(e); }
    html += days.size
      ? [...days].map(([d, es]) => `<h2 class="ev-day">${esc(dayLabel(d))}<span>${es.length} event${es.length === 1 ? "" : "s"}</span></h2><ul class="ev-list">${es.map(row).join("")}</ul>`).join("")
      : `<div class="msg">Nothing listed for ${F.when === "today" ? "the rest of today" : "these dates"}${F.who !== "all" || F.area ? " with these filters" : ""}. Try another day${F.who !== "all" || F.area ? " or fewer filters" : ""}.</div>`;
    html += `<p class="forum-foot">Listed as <a href="${esc(data.sourceUrl)}" target="_blank" rel="noopener">Halifax Public Libraries</a> posts them, updated ${esc(ago(data.updatedAt))}. Check the library's page before you go: times and registration can change.</p>`;
    root.innerHTML = html;
  }

  async function load(force) {
    if (!force && data && Date.now() - loadedAt < REFRESH_MS) return;
    try {
      const r = await fetch("/api/events", { headers: { accept: "application/json" } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "HTTP " + r.status);
      data = d; loadedAt = Date.now(); error = "";
    } catch (e) { error = data ? "" : (e.message || "The events list couldn't load.") + " Try again in a minute."; }
    render();
  }

  function onClick(e) {
    const b = e.target.closest("button");
    if (!b || !root.contains(b)) return;
    if (b.dataset.when) { F.when = b.dataset.when; F.open = null; save(); render(); }
    else if (b.dataset.who) { F.who = b.dataset.who; F.open = null; save(); render(); }
    else if (b.dataset.open) {
      const k = b.dataset.open;
      F.open = F.open === k ? null : k;
      render();
      // A highlight card opens its row in the list below
      const line = root.querySelector(`.ev-line[data-open="${CSS.escape(k)}"]`);
      if (b.classList.contains("ev-card") && line) line.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      (line || b).focus({ preventScroll: true });
    }
  }

  window.THEvents = {
    open(el) {
      if (root !== el) {
        root = el;
        root.addEventListener("click", onClick);
        root.addEventListener("change", e => { if (e.target.id === "evArea") { F.area = e.target.value; F.open = null; save(); render(); } });
      }
      render();
      load(false);
    },
    refresh() { return load(true); },
  };

  // ---------- styles (only this page uses them) ----------
  const style = document.createElement("style");
  style.textContent = `
    .ev-filters { margin: 4px 0 8px; }
    .ev-filters .nfilters { margin: 0 0 10px; }
    .ev-row2 { display: flex; flex-wrap: wrap; align-items: center; gap: 0 12px; }
    .ev-area select { font: inherit; font-size: 14px; font-weight: 600; color: var(--ink); background: var(--field); border: 1px solid var(--line); border-radius: 999px; padding: 0 30px 0 14px; min-height: 36px; margin-bottom: 10px; max-width: 100%; }
    .ev-sub { margin-top: 22px; }
    .ev-hl { margin-bottom: 8px; }
    .ev-card .dk { -webkit-line-clamp: 3; }
    .ev-card.pic { padding-top: 0; overflow: hidden; }
    .ev-img { display: block; margin: 0 -18px 4px; height: 128px; background: var(--surface-sunken) center / cover no-repeat; }
    .ev-day { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-family: var(--f-display); font-size: 20px; font-weight: 700; letter-spacing: -.015em; margin: 34px 0 6px; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
    .ev-day span { font-family: var(--f-body); font-size: 13px; font-weight: 500; color: var(--muted); letter-spacing: 0; }
    .ev-list { list-style: none; margin: 0; padding: 0; }
    .ev-item { border-bottom: 1px solid var(--line); }
    .ev-line { all: unset; box-sizing: border-box; cursor: pointer; width: 100%; display: grid; grid-template-columns: 84px 1fr; gap: 14px; padding: 14px 4px; min-height: 44px; }
    .ev-line:hover b { text-decoration: underline; text-underline-offset: 3px; }
    .ev-line:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--radius-s); }
    .ev-time { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; padding-top: 1px; }
    .ev-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .ev-main b { font-size: 16px; font-weight: 600; line-height: 1.35; }
    .ev-where { font-size: 14px; color: var(--muted); }
    .ev-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
    .ev-tags:empty { display: none; }
    .ev-flag { font-size: 12.5px; font-weight: 600; color: var(--signal-caution); padding: 3px 0; }
    .ev-flag.warn { color: var(--signal-warn); }
    .ev-item.off b { text-decoration: line-through; color: var(--muted); }
    .ev-more { padding: 0 4px 18px 102px; font-size: 15px; line-height: 1.55; }
    .ev-more p { margin: 0 0 10px; max-width: 62ch; }
    .ev-when { font-weight: 600; }
    .ev-types { font-size: 13.5px; color: var(--muted); }
    .ev-link { font-weight: 600; color: var(--ink); }
    @media (max-width: 760px) {
      .ev-seg { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-inline: -16px !important; padding-inline: 16px; }
      .ev-seg::-webkit-scrollbar { display: none; }
      .ev-seg button { flex: none; }
      .ev-line { grid-template-columns: 70px 1fr; gap: 10px; }
      .ev-more { padding-left: 84px; }
    }`;
  document.head.appendChild(style);
})();
