// TalkHalifax client: Home (glass cards), article rooms with a docked live chat, and a profile page.
// Data comes from the Worker's /api, chat from /rooms/<story>/ws (one ArticleRoom Durable Object per story).
(function () {
  const TZ = "America/Halifax";
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const linkify = s => esc(s).replace(/\b((?:engage)?halifax\.ca\/[A-Za-z0-9/_-]+)/g, '<a href="https://$1" target="_blank" rel="noopener">$1</a>');

  // ---------- Time helpers (always Halifax time) ----------
  const fmt = o => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, ...o });
  const hm = t => fmt({ hour: "numeric", minute: "2-digit" }).format(new Date(t)).replace(/\./g, "");
  const shortDate = t => fmt({ month: "short", day: "numeric" }).format(new Date(t));
  const fullDate = t => fmt({ month: "short", day: "numeric", year: "numeric" }).format(new Date(t));
  function ago(t) {
    const m = Math.max(0, Math.round((Date.now() - new Date(t)) / 60000));
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    if (m < 1440) return Math.round(m / 60) + " h ago";
    const d = Math.round(m / 1440);
    if (d === 1) return "yesterday";
    if (d < 14) return d + " days ago";
    return Math.round(d / 7) + " weeks ago";
  }

  // ---------- State ----------
  const S = {
    me: null, providers: {}, stories: null, full: {}, weather: null, alerts: null, offline: false,
    sort: "active", current: "home", article: null, user: null, userFrom: null, users: {},
  };
  const reported = new Set(); // messages and comments this person has reported
  const room = { ws: null, id: null, messages: [], profiles: {}, here: [], readers: 0, you: null, error: "", typing: false, armed: null, armedTimer: null, tries: 0, closing: false };

  async function getJSON(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }

  // ---------- People ----------
  const PERSON_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 20c1.4-3.6 4.2-5.4 7.5-5.4s6.1 1.8 7.5 5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const VIEWER_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4.2" fill="currentColor"/><path d="M3.8 21c.9-4.2 4.2-6.6 8.2-6.6s7.3 2.4 8.2 6.6z" fill="currentColor"/></svg>';
  const hue = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 45%)`; };
  /** A small round avatar: photo when there is one, otherwise an initial on a stable colour. */
  function avatar(p, cls = "av") {
    if (p && p.avatar) return `<span class="${cls}"><img alt="" src="${esc(p.avatar)}" referrerpolicy="no-referrer"></span>`;
    const name = (p && p.name) || "?";
    return `<span class="${cls}" style="background:${p ? hue(p.id) : "var(--ink-faint)"}" aria-hidden="true">${esc(name.trim()[0] || "?").toUpperCase()}</span>`;
  }
  const nameOf = uid => uid === (S.me && S.me.id) ? "You" : (room.profiles[uid] && room.profiles[uid].name) || "Someone";

  // ---------- Home ----------
  /** Banners pinned under the header on Home, for urgent things only: weather warnings, then urgent city notices.
   *  Everything else is on the Notices page. */
  function renderBanners() {
    const el = $("#abars");
    const t = x => (x ? new Date(x).getTime() : 0);
    const items = [];
    for (const a of (S.alerts && S.alerts.items) || []) {
      if (a.cat !== "Weather" || a.kind !== "Warning") continue;
      const until = t(a.until) ? `Until ${shortDate(a.until)}, ${hm(a.until)}` : "";
      items.push({ rank: 0, sev: "", label: "Weather · Warning",
        title: a.title, meta: until, at: t(a.publishedAt), link: `href="${esc(a.url)}" target="_blank" rel="noopener"` });
    }
    for (const n of S.stories || []) {
      if (n.kind !== "notice" || Date.now() - t(n.publishedAt) >= 7 * 864e5) continue;
      const type = noticeType(n);
      if (noticeSeverity(n, type) !== "urgent") continue;
      items.push({ rank: 1, sev: "", label: type + (n.statusLabel ? " · " + n.statusLabel : ""),
        title: n.headline, meta: shortDate(n.publishedAt), at: t(n.publishedAt), link: `href="#article-${esc(n.id)}" data-article="${esc(n.id)}"` });
    }
    items.sort((a, b) => a.rank - b.rank || b.at - a.at);
    el.hidden = S.current !== "home" || !items.length;
    if (el.hidden) { el.innerHTML = ""; return; }
    const shown = S.allBanners ? items : items.slice(0, 1);
    // The first banner carries the toggle for the rest, so a stack costs no extra row when collapsed
    const toggle = items.length > 1 ? `<button type="button" class="abar-tog" id="abarMore" aria-expanded="${!!S.allBanners}">${S.allBanners ? "Less" : `+${items.length - 1} more`}</button>` : "";
    el.innerHTML = shown.map((b, i) => `<div class="abar${b.sev}"><div class="wrap abar-row"><a class="abar-in" ${b.link}>
        <span class="abar-k">${esc(b.label)}</span><span class="abar-t">${esc(b.title)}</span>${b.meta ? `<span class="abar-m">${esc(b.meta)}</span>` : ""}
      </a>${i === 0 ? toggle : ""}</div></div>`).join("");
    const more = $("#abarMore");
    if (more) more.onclick = () => { S.allBanners = !S.allBanners; renderBanners(); };
  }

  const tms = x => (x ? new Date(x).getTime() : 0);
  const loadingMsg = () => `<div class="msg">${S.offline ? "TalkHalifax can't reach its server right now. Check your connection and reload." : "Loading…"}</div>`;
  const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /** Swap in new cards, sliding the ones that moved, fading in new stories and fading out ones that left (moved to Articles). */
  function setCards(box, html) {
    if (box.dataset.html === html) return;
    const old = new Map();
    const animate = !reducedMotion() && box.offsetParent && typeof box.animate === "function";
    if (animate) box.querySelectorAll(".card[data-article]").forEach(el => old.set(el.dataset.article, { el, r: el.getBoundingClientRect() }));
    const boxR = box.getBoundingClientRect();
    box.innerHTML = html; box.dataset.html = html;
    if (!animate || !old.size) return;
    const seen = new Set();
    box.querySelectorAll(".card[data-article]").forEach(el => {
      const id = el.dataset.article, was = old.get(id), now = el.getBoundingClientRect();
      seen.add(id);
      if (!was) return el.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "ease-out" });
      const dx = was.r.left - now.left, dy = was.r.top - now.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 520, easing: "cubic-bezier(.2, .7, .2, 1)" });
    });
    for (const [id, { el, r }] of old) {
      if (seen.has(id)) continue;
      el.classList.add("ghost"); el.removeAttribute("data-article"); el.setAttribute("aria-hidden", "true"); el.tabIndex = -1;
      Object.assign(el.style, { left: r.left - boxR.left + "px", top: r.top - boxR.top + "px", width: r.width + "px", height: r.height + "px" });
      box.appendChild(el);
      el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.96)" }], { duration: 360, easing: "ease-in", fill: "forwards" }).onfinish = () => el.remove();
    }
  }

  /** Home is the developing stories, the most recently updated first. */
  function renderHome() {
    renderBanners(); // city notices live in the banners now
    if (!S.stories) { setCards($("#devCards"), loadingMsg()); return; }
    const t = tms;
    const updated = x => Math.max(t(x.lastUpdate), t(x.developingSince), t(x.publishedAt));
    const dev = S.stories.filter(x => x.kind === "article" && x.stage === "developing").sort((a, b) => updated(b) - updated(a));
    const devCards = dev.map((x, i) => {
      const r = x.room;
      const recentUpdate = x.lastUpdate && Date.now() - t(x.lastUpdate) < 864e5;
      const left = recentUpdate ? `<span class="upd">Updated ${hm(x.lastUpdate)}</span>`
        : r.lastAt ? `<span>Last message ${ago(r.lastAt)}${r.lastAuthor ? " from " + esc(r.lastAuthor) : ""}</span>`
        : `<span>${shortDate(x.publishedAt)}</span>`;
      // Live viewer count: everyone with the story open right now, chatting or not
      const viewers = `<span class="viewers${r.here ? " on" : ""}" aria-label="${r.here} ${r.here === 1 ? "person" : "people"} here now">${VIEWER_SVG}<b>${r.here}</b></span>`;
      return `<button type="button" class="card glass${i === 0 ? " lead" : ""}" data-article="${esc(x.id)}">
        <span class="k">${esc(x.area || x.section || "Halifax")}</span>
        <span class="tt">${esc(x.headline)}</span>
        ${x.dek ? `<span class="dk">${esc(x.dek)}</span>` : ""}
        <span class="ft">${left}${viewers}</span></button>`;
    }).join("");
    setCards($("#devCards"), devCards || '<div class="msg">Nothing developing right now. New stories appear here as the newsroom publishes them, and settled ones are in <a href="#articles" data-go="articles">Articles</a>.</div>');
  }

  /** Articles: settled stories with threaded comments. */
  function renderArticles() {
    document.querySelectorAll("[data-sort]").forEach(b => b.setAttribute("aria-pressed", b.dataset.sort === S.sort));
    if (!S.stories) { $("#artCards").innerHTML = loadingMsg(); return; }
    const t = tms;
    const key = {
      active: x => -Math.max(x.comments.lastAt || 0, t(x.archivedAt)),
      new: x => -t(x.publishedAt),
      top: x => -x.comments.count,
    }[S.sort];
    const arts = S.stories.filter(x => x.kind === "article" && x.stage === "archived").sort((a, b) => key(a) - key(b));
    $("#artCards").innerHTML = arts.map(x => {
      const c = x.comments;
      return `<button type="button" class="card glass archived" data-article="${esc(x.id)}">
        <span class="k">${esc(x.area || x.section || "Halifax")}</span>
        <span class="tt">${esc(x.headline)}</span>
        ${x.dek ? `<span class="dk">${esc(x.dek)}</span>` : ""}
        <span class="ft"><span>${c.lastAt ? "Last comment " + ago(c.lastAt) : shortDate(x.publishedAt)}</span><span class="pill${c.count ? "" : " zero"}">${c.count} ${c.count === 1 ? "comment" : "comments"}</span></span></button>`;
    }).join("") || '<div class="msg">No articles yet. Developing stories move here once they settle.</div>';
  }
  document.querySelectorAll("[data-sort]").forEach(b => b.addEventListener("click", () => { S.sort = b.dataset.sort; renderArticles(); }));

  // ---------- Notices: city notices and weather alerts, coloured by severity ----------
  const N_TYPES = ["Emergency", "Police", "Roads", "Water", "Transit", "Winter", "Weather", "City"];
  /** What a city notice is about, from its section and headline. */
  function noticeType(n) {
    const s = (n.section || "").toLowerCase(), h = (n.headline || "").toLowerCase();
    if (/fire|emergenc/.test(s) || /\b(fire|evacuat|emergency|hazmat|shelter in place)/.test(h)) return "Emergency";
    if (/police/.test(s) || /\b(police|rcmp|homicide|arrest|charged|missing (person|man|woman|youth|boy|girl))/.test(h)) return "Police";
    if (/winter/.test(s) || /parking ban|snow|plow/.test(h)) return "Winter";
    if (/water/.test(s) || /boil[- ]water|water main|water service/.test(h)) return "Water";
    if (/transit/.test(s) || /\b(ferry|bus|transit)\b/.test(h)) return "Transit";
    if (/road|transportation/.test(s) || /traffic|road|lane|highway|detour|bridge|street|drive/.test(h)) return "Roads";
    return "City";
  }
  const RESOLVED = /\b(lifted|final update|resolved|reopened|located|cancell?ed|ended|over)\b/i;
  /** urgent (safety), disruption (getting around, water), info, or resolved */
  function noticeSeverity(n, type) {
    if (n.supersededBy || RESOLVED.test(n.statusLabel || "") || RESOLVED.test(n.headline || "")) return "resolved";
    if (type === "Emergency" || /boil[- ]water|missing|evacuat|shelter in place/i.test(n.headline || "")) return "urgent";
    if (["Roads", "Water", "Transit", "Winter"].includes(type)) return "disruption";
    return "info";
  }
  const SEV_RANK = { urgent: 0, disruption: 1, info: 2, resolved: 3 };
  /** Every notice as one shape: city notices from the newsroom, weather alerts from ECCC. */
  function allNotices() {
    const out = [];
    for (const n of S.stories || []) {
      if (n.kind !== "notice") continue;
      const type = noticeType(n), sev = noticeSeverity(n, type);
      out.push({ id: n.id, type, sev, status: n.statusLabel, title: n.headline, dek: n.dek, area: n.area, at: tms(n.publishedAt),
        old: sev === "resolved" || Date.now() - tms(n.publishedAt) > 7 * 864e5, link: `data-article="${esc(n.id)}"` });
    }
    for (const a of (S.alerts && S.alerts.items) || []) {
      if (a.cat !== "Weather") continue;
      out.push({ id: "w:" + a.title, type: "Weather", sev: a.kind === "Warning" ? "urgent" : a.kind === "Watch" ? "disruption" : "info",
        status: a.kind, title: a.title, dek: a.detail, area: "", at: tms(a.publishedAt), old: false,
        until: a.until, link: `href="${esc(a.url)}" target="_blank" rel="noopener"` });
    }
    return out;
  }
  function noticeCard(n) {
    const tag = n.link.startsWith("href") ? "a" : "button";
    return `<${tag} ${tag === "button" ? 'type="button" ' : ""}class="ncard ${n.sev}" ${n.link}>
      <span class="nk">${esc(n.type)}${n.status ? `<span class="st">${esc(n.status)}</span>` : ""}</span>
      <span class="tt">${esc(n.title)}</span>
      ${n.dek ? `<span class="dk">${esc(n.dek)}</span>` : ""}
      <span class="ft"><span>${n.until ? `Until ${shortDate(n.until)}, ${hm(n.until)}` : n.at ? shortDate(n.at) + ", " + hm(n.at) : ""}</span><span>${esc(n.area || "")}</span></span>
    </${tag}>`;
  }
  function renderNotices() {
    if (!S.stories) { $("#nActive").innerHTML = loadingMsg(); return; }
    const all = allNotices(), f = S.nFilter || "All";
    const active = all.filter(n => !n.old);
    const types = N_TYPES.filter(t => all.some(n => n.type === t));
    $("#nFilters").innerHTML = ["All", ...types].map(t => {
      const c = t === "All" ? active.length : active.filter(n => n.type === t).length;
      return `<button type="button" data-nf="${t}" aria-pressed="${t === f}">${t}${c ? `<span class="c">${c}</span>` : ""}</button>`;
    }).join("");
    const shown = all.filter(n => f === "All" || n.type === f);
    const now = shown.filter(n => !n.old).sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.at - a.at);
    const earlier = shown.filter(n => n.old).sort((a, b) => b.at - a.at).slice(0, 24);
    $("#nActive").innerHTML = now.map(noticeCard).join("") || `<div class="msg">No current ${f === "All" ? "" : f.toLowerCase() + " "}notices.</div>`;
    $("#nEarlierH").hidden = !earlier.length;
    $("#nEarlier").innerHTML = earlier.map(noticeCard).join("");
  }
  $("#nFilters").addEventListener("click", e => { const b = e.target.closest("[data-nf]"); if (b) { S.nFilter = b.dataset.nf; renderNotices(); } });

  // ---------- Article room ----------
  const narrow = () => window.matchMedia("(max-width: 960px)").matches;
  let chatOpen = false;
  let chatHidden = false;
  try { chatHidden = localStorage.getItem("talkhalifax.chatHidden") === "1"; } catch (e) {}
  function setChatHidden(h) {
    chatHidden = h;
    try { localStorage.setItem("talkhalifax.chatHidden", h ? "1" : "0"); } catch (e) {}
    applyChatState();
  }
  function applyChatState() {
    const chat = $("#chat"), reopen = $("#chatReopen"), toggle = $("#chatToggle");
    const small = narrow();
    document.body.classList.toggle("chat-open", S.current === "article" && !!chat && !small && !chatHidden);
    if (!chat) return;
    chat.classList.toggle("hidden", !small && chatHidden);
    chat.classList.toggle("open", small && chatOpen);
    if (reopen) reopen.hidden = small || !chatHidden;
    if (toggle) {
      toggle.setAttribute("aria-label", small ? (chatOpen ? "Collapse chat" : "Expand chat") : "Hide chat");
      toggle.setAttribute("aria-expanded", String(small ? chatOpen : !chatHidden));
    }
  }
  window.addEventListener("resize", applyChatState);

  /** Back to the list the story lives in: Notices, Articles for settled ones, Developing Stories for the rest. */
  const back = a => a && a.kind === "notice" ? `<button type="button" class="back" data-go="notices">← Notices</button>`
    : a && a.kind === "article" && a.stage === "archived"
    ? `<button type="button" class="back" data-go="articles">← Articles</button>`
    : `<button type="button" class="back" data-go="home">← Developing Stories</button>`;

  const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch (e) { return "the source"; } };

  /** The article itself (shared by Developing and Articles views, and swapped in place on live updates). */
  function articleHTML(a) {
    const isNotice = a.kind === "notice";
    const newer = isNotice && a.supersededBy && (S.stories || []).find(s => s.id === a.supersededBy);
    const developing = a.kind === "article" && a.stage === "developing";
    const showUpdate = developing && a.lastUpdate && a.updateNote;
    const mod = S.me && S.me.role === "moderator" && a.kind === "article";
    return `
      <article>
        <div class="kicker${isNotice ? " notice" : ""}">${isNotice ? "City notice" + (a.statusLabel ? " · " + esc(a.statusLabel) : "") : (developing ? "Developing · " : "") + esc(a.section) + " · " + esc(a.area || "Halifax")}</div>
        <h1>${esc(a.headline)}</h1>
        ${a.dek ? `<p class="dek">${esc(a.dek)}</p>` : ""}
        <div class="byline">${a.author ? `<span class="by">By <button type="button" class="by-link" data-user="${esc(a.author.id)}">${esc(a.author.name)}</button>, AI journalist</span>` : ""}<span class="ai">${isNotice ? "Rewritten by AI from an official notice, facts only" : "Written by AI from an official release"}</span><span>${fullDate(a.publishedAt)}</span>${a.lastUpdate ? `<span>Updated ${fullDate(a.lastUpdate)}, ${hm(a.lastUpdate)}</span>` : ""}${a.readMin ? `<span>${a.readMin} min read</span>` : ""}</div>
        ${showUpdate ? `<div class="updated-banner"><b>Latest update</b> · ${esc(ago(a.lastUpdate))}: ${esc(a.updateNote)}</div>` : ""}
        ${newer ? `<button type="button" class="banner" data-article="${esc(newer.id)}"><b>There's a newer update.</b> <span>${esc(newer.headline)} →</span></button>` : ""}
        ${a.facts.length ? `<dl class="facts">${a.facts.map(f => `<dt>${esc(f.k)}</dt><dd>${linkify(f.v)}</dd>`).join("")}</dl>` : ""}
        <div class="body">
          ${a.body.map(p => `<p>${linkify(p)}</p>`).join("")}
          ${a.means.length ? `<h2>${isNotice ? "What to do" : "What this means for you"}</h2><ul>${a.means.map(p => `<li>${linkify(p)}</li>`).join("")}</ul>` : ""}
        </div>
        <div class="source">Source: <a href="${esc(a.source)}" target="_blank" rel="noopener">original ${isNotice ? "notice" : "release"} on ${esc(hostOf(a.source))}</a>. Dates, times and places are copied from it; if anything differs, the original is right.</div>
        ${a.author ? `<button type="button" class="author-card" data-user="${esc(a.author.id)}" aria-label="${esc(a.author.name)}'s profile">${avatar({ id: a.author.id, name: a.author.name })}<span><b>${esc(a.author.name)}</b><span class="ac-bio">${esc(a.author.bio)}</span><span class="ac-more">See all of ${esc(a.author.name.split(" ")[0])}'s stories →</span></span></button>` : ""}
        ${mod ? `<div class="stage-tools">Moderator: <button type="button" id="stageBtn" data-stage="${developing ? "archived" : "developing"}">${developing ? "Move to Articles (closes and clears the chat)" : "Move back to Developing"}</button></div>` : ""}
      </article>`;
  }

  async function fetchStory(id) {
    const a = (await getJSON("/api/stories/" + encodeURIComponent(id))).story;
    S.full[id] = a;
    // Keep the home list in step with what this page now knows
    if (S.stories) { const i = S.stories.findIndex(s => s.id === id); if (i >= 0) S.stories[i] = { ...S.stories[i], ...a }; }
    return a;
  }

  async function renderArticle() {
    const v = $("#article");
    const id = S.article;
    v.classList.remove("wide");
    let a = S.full[id];
    if (!a) {
      v.innerHTML = `${back()}<div class="msg" style="margin-top:20px">Loading…</div>`;
      try { a = await fetchStory(id); }
      catch (e) { if (S.article === id) v.innerHTML = `${back()}<div class="msg" style="margin-top:20px">This story isn't available.</div>`; return; }
      if (S.article !== id) return;
    }

    if (a.kind === "skip") {
      v.innerHTML = `${back()}
        <article>
          <div class="kicker">${esc(a.section)}</div>
          <h1>${esc(a.headline)}</h1>
          <div class="byline"><span>Announcement from the Halifax Regional Municipality</span><span>${fullDate(a.publishedAt)}</span></div>
          <div class="body"><p style="color:var(--muted)">We haven't written this one up${a.reason ? ": " + esc(a.reason.toLowerCase()) : ""}.</p></div>
          <div class="source">Source and full text: <a href="${esc(a.source)}" target="_blank" rel="noopener">original release on halifax.ca</a>.</div>
        </article>`;
      window.scrollTo({ top: 0 }); return;
    }

    if (a.kind === "notice") {
      v.innerHTML = `<div class="room"><div>${back()}${articleHTML(a)}<p class="closed">Chat and comments are off for city notices. For emergencies, follow official channels and sign up for hfxALERT at <a href="https://halifax.ca/hfxalert" target="_blank" rel="noopener">halifax.ca/hfxalert</a>.</p><div id="alertOffer"></div></div></div>`;
      // Readers are offered alerts after opening a notice, never on a first visit to the site
      lazy("/alerts.js").then(() => { const o = $("#alertOffer"); if (o) window.THAlerts.offer(o); }).catch(() => {});
      wireStageTools(); window.scrollTo({ top: 0 }); return;
    }

    // ---- Articles: no live chat; threaded comments below ----
    if (a.stage !== "developing") {
      leaveRoom();
      v.innerHTML = `<div class="room"><div id="articleCol">${back(a)}${articleHTML(a)}</div></div>
        <section class="comments-sec" aria-labelledby="cmH">
          <div class="c-head2"><h2 id="cmH">Comments</h2><span id="cmCount"></span></div>
          <div id="cmCompose"></div>
          <ul class="cthread" id="cmList"><li class="msg" style="border:0">Loading comments…</li></ul>
        </section>`;
      wireStageTools();
      window.scrollTo({ top: 0 });
      loadComments(id);
      return;
    }

    // ---- Developing: article plus the docked live chat ----
    v.classList.add("wide");
    v.innerHTML = `<div class="room">
      <div id="articleCol">${back(a)}${articleHTML(a)}</div>
      <aside class="chat glass" id="chat" aria-label="Live chat about this story">
        <div class="chat-head" id="chatHead">
          <span class="grab" aria-hidden="true"></span>
          <h2>Live chat</h2>
          <span class="here" id="here"></span>
          <button type="button" class="chat-toggle" id="chatToggle" aria-controls="chat">
            <svg class="side" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 6l6 6-6 6M19 5v14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg class="down" width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 15l6-6 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div class="msgs" id="msgs" aria-live="polite"><div class="chat-empty">Connecting…</div></div>
        <div class="typing" id="typing"></div>
        <div class="chat-err" id="chatErr" hidden></div>
        <div id="composerSlot"></div>
      </aside>
      <button type="button" class="chat-reopen glass" id="chatReopen" hidden><span class="dot-live" aria-hidden="true"></span>Live chat <span class="n" id="reopenN"></span></button>
    </div>`;
    renderComposer();
    wireChat(v);
    wireStageTools();
    applyChatState();
    window.scrollTo({ top: 0 });
    connectRoom(id);
  }

  /** The newsroom updated the article: swap it in place without touching the chat. */
  async function refreshArticleInPlace(id) {
    let a;
    try { a = await fetchStory(id); } catch (e) { return; }
    const col = $("#articleCol");
    if (S.current !== "article" || S.article !== id || !col) return;
    col.innerHTML = back(a) + articleHTML(a);
    wireStageTools();
    const art = col.querySelector("article");
    if (art) { art.classList.remove("flash-update"); void art.offsetWidth; art.classList.add("flash-update"); }
  }

  /** The story moved to Articles while open: reload it as an article with comments. */
  async function storyClosed(id) {
    leaveRoom();
    delete S.full[id];
    if (S.current === "article" && S.article === id) { await renderArticle(); }
  }

  function wireStageTools() {
    const b = $("#stageBtn");
    if (!b) return;
    b.addEventListener("click", async () => {
      b.disabled = true;
      const r = await fetch(`/api/stories/${encodeURIComponent(S.article)}/stage`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stage: b.dataset.stage }),
      });
      if (!r.ok) { b.disabled = false; return; }
      const id = S.article;
      delete S.full[id];
      leaveRoom();
      await loadStories();
      if (S.current === "article" && S.article === id) renderArticle();
    });
  }

  // ---------- Comments (Articles) ----------
  const CM = { list: [], replyTo: null, armed: null, armedTimer: null };
  async function loadComments(id) {
    try { CM.list = (await getJSON(`/api/stories/${encodeURIComponent(id)}/comments`)).comments; }
    catch (e) { if ($("#cmList")) $("#cmList").innerHTML = `<li class="msg" style="border:0">Couldn't load comments.</li>`; return; }
    if (S.article === id) renderComments();
  }
  function composeHTML(kind) {
    return `<div class="c-compose" data-kind="${kind}">
      ${avatar({ id: S.me.id, name: S.me.name, avatar: S.me.avatarUrl })}
      <div>
        <label class="sr" for="cm-${kind}">${kind === "reply" ? "Reply" : "Comment"}</label>
        <textarea id="cm-${kind}" maxlength="2000" placeholder="${kind === "reply" ? "Write a reply…" : "Add a comment…"}"></textarea>
        <div class="row2"><span id="cmErr-${kind}"></span><button type="button" class="btn primary" disabled>${kind === "reply" ? "Reply" : "Comment"}</button></div>
      </div></div>`;
  }
  function commentHTML(c, replies) {
    const mine = S.me && c.uid === S.me.id, mod = S.me && S.me.role === "moderator";
    const acts = [];
    if (replies && S.me && !S.me.banned) acts.push(`<button type="button" data-reply="${esc(c.id)}">Reply</button>`);
    if (mine || mod) acts.push(CM.armed === c.id
      ? `<button type="button" class="danger" data-cdel="${esc(c.id)}">${mine ? "Delete" : "Remove"} for good</button>`
      : `<button type="button" data-cdel="${esc(c.id)}">${mine ? "Delete" : "Remove"}</button>`);
    else if (S.me && !S.me.banned) acts.push(reported.has(c.id) ? `<span>Reported</span>`
      : `<button type="button" data-crep="${esc(c.id)}">${CM.armed === "r:" + c.id ? "Report to a moderator?" : "Report"}</button>`);
    return `<div class="cm">
        ${avatar({ id: c.uid, name: c.name, avatar: c.avatar })}
        <div>
          <div class="who"><b>${esc(mine ? "You" : c.name || "Someone")}</b> <span>· ${ago(c.at)}</span></div>
          <p>${esc(c.text)}</p>
          <div class="acts">${acts.join("")}</div>
        </div>
      </div>`;
  }
  function renderComments() {
    const tops = CM.list.filter(c => !c.parentId);
    const total = CM.list.length;
    $("#cmCount").textContent = `${total} ${total === 1 ? "comment" : "comments"}`;
    $("#cmCompose").innerHTML = !S.me ? `<div class="chat-note" style="padding:14px 0"><a href="#profile">Sign in or create an account</a> to comment.</div>`
      : S.me.banned ? `<div class="chat-note" style="padding:14px 0">Your account can't post right now.</div>` : composeHTML("top");
    $("#cmList").innerHTML = tops.map(c => {
      const replies = CM.list.filter(r => r.parentId === c.id);
      return `<li>${commentHTML(c, true)}
        ${replies.length || CM.replyTo === c.id ? `<ul class="creplies">${replies.map(r => `<li>${commentHTML(r, false)}</li>`).join("")}
          ${CM.replyTo === c.id ? `<li>${composeHTML("reply")}</li>` : ""}</ul>` : ""}</li>`;
    }).join("") || `<li class="msg" style="border:0">No comments yet. Start the conversation.</li>`;
    wireComments();
  }
  function wireComments() {
    document.querySelectorAll(".c-compose").forEach(box => {
      const ta = box.querySelector("textarea"), btn = box.querySelector(".btn"), kind = box.dataset.kind;
      ta.addEventListener("input", () => { btn.disabled = !ta.value.trim(); });
      btn.addEventListener("click", async () => {
        const text = ta.value.trim();
        if (!text) return;
        btn.disabled = true;
        const r = await fetch(`/api/stories/${encodeURIComponent(S.article)}/comments`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, parentId: kind === "reply" ? CM.replyTo : null }),
        }).catch(() => null);
        const d = r ? await r.json().catch(() => ({})) : {};
        if (!r || !r.ok) { $("#cmErr-" + kind).textContent = d.error || "That didn't post. Try again."; btn.disabled = false; return; }
        CM.list.push(d.comment);
        CM.replyTo = null;
        renderComments();
      });
    });
    document.querySelectorAll("[data-reply]").forEach(b => b.addEventListener("click", () => {
      CM.replyTo = CM.replyTo === b.dataset.reply ? null : b.dataset.reply;
      renderComments();
      const ta = $("#cm-reply"); if (ta) ta.focus();
    }));
    document.querySelectorAll("[data-crep]").forEach(b => b.addEventListener("click", async () => {
      const id = b.dataset.crep;
      if (CM.armed !== "r:" + id) {
        CM.armed = "r:" + id; clearTimeout(CM.armedTimer);
        CM.armedTimer = setTimeout(() => { CM.armed = null; renderComments(); }, 4000);
        return renderComments();
      }
      CM.armed = null;
      const err = await sendReport("comment", id);
      if (err) { b.textContent = err; return; }
      reported.add(id);
      renderComments();
    }));
    document.querySelectorAll("[data-cdel]").forEach(b => b.addEventListener("click", async () => {
      const id = b.dataset.cdel;
      if (CM.armed !== id) {
        CM.armed = id; clearTimeout(CM.armedTimer);
        CM.armedTimer = setTimeout(() => { CM.armed = null; renderComments(); }, 4000);
        return renderComments();
      }
      CM.armed = null;
      const r = await fetch(`/api/comments/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
      if (r && r.ok) CM.list = CM.list.filter(c => c.id !== id && c.parentId !== id);
      renderComments();
    }));
  }

  function renderComposer() {
    const slot = $("#composerSlot");
    if (!slot) return;
    if (!S.me) {
      slot.innerHTML = `<div class="chat-note"><a href="#profile">Sign in or create an account</a> to join the chat.</div>`;
    } else if (S.me.banned) {
      slot.innerHTML = `<div class="chat-note">Your account can't post right now.</div>`;
    } else if (!$("#chatInput")) {
      slot.innerHTML = `<div class="composer">
          <label class="sr" for="chatInput">Message</label>
          <textarea id="chatInput" rows="1" maxlength="1000" placeholder="Say something about this…"></textarea>
          <button type="button" class="send" id="chatSend" aria-label="Send" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12h14M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
        </div>`;
      wireComposer();
    }
  }

  function wireChat(v) {
    const head = $("#chatHead"), toggle = $("#chatToggle"), reopen = $("#chatReopen");
    const setSheet = open => { chatOpen = open; applyChatState(); if (open) { const m = $("#msgs"); m.scrollTop = m.scrollHeight; } };
    toggle.addEventListener("click", e => { e.stopPropagation(); if (narrow()) return setSheet(!chatOpen); setChatHidden(true); reopen.focus(); });
    head.addEventListener("click", () => { if (narrow()) setSheet(!chatOpen); });
    reopen.addEventListener("click", () => { setChatHidden(false); const i = $("#chatInput"); (i || toggle).focus(); });
  }

  function wireComposer() {
    const ta = $("#chatInput"), send = $("#chatSend");
    const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; };
    const setTyping = on => { if (room.typing === on) return; room.typing = on; sendRoom({ t: "typing", on }); };
    const submit = () => {
      const text = ta.value.trim();
      if (!text) return;
      if (!sendRoom({ t: "send", text })) { showChatError("Not connected yet. Your message is still here; try again in a moment."); return; }
      ta.value = ""; grow(); send.disabled = true; setTyping(false);
    };
    ta.addEventListener("input", () => { grow(); send.disabled = !ta.value.trim(); setTyping(!!ta.value.trim()); });
    ta.addEventListener("blur", () => setTyping(false));
    ta.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
    send.addEventListener("click", submit);
  }

  // ---------- Room connection ----------
  function sendRoom(obj) {
    if (!room.ws || room.ws.readyState !== WebSocket.OPEN) return false;
    room.ws.send(JSON.stringify(obj));
    return true;
  }
  function leaveRoom() {
    if (room.ws) { room.closing = true; try { room.ws.close(); } catch (e) {} }
    Object.assign(room, { ws: null, id: null, messages: [], profiles: {}, here: [], readers: 0, you: null, error: "", typing: false, tries: 0 });
  }
  function connectRoom(id) {
    if (room.id === id && room.ws && room.ws.readyState <= 1) { renderChat(true); return; }
    leaveRoom();
    room.id = id; room.closing = false;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/rooms/${encodeURIComponent(id)}/ws`);
    room.ws = ws;
    ws.addEventListener("message", e => {
      if (room.ws !== ws) return;
      let d; try { d = JSON.parse(e.data); } catch (x) { return; }
      if (d.t === "hello") {
        room.tries = 0; room.you = d.you; room.messages = d.messages; Object.assign(room.profiles, d.profiles);
        room.error = ""; renderChat(true);
      } else if (d.t === "msg") {
        if (d.profile) room.profiles[d.m.uid] = d.profile;
        room.messages.push(d.m); renderChat(d.m.uid === (S.me && S.me.id));
      } else if (d.t === "del") {
        room.messages = room.messages.filter(m => m.id !== d.id); renderChat();
      } else if (d.t === "here") {
        room.here = d.here; room.readers = d.readers; Object.assign(room.profiles, d.profiles); renderHere();
      } else if (d.t === "error") {
        showChatError(d.text);
        // A message the screening turned away goes back in the box, so it can be reworded
        const i = $("#chatInput");
        if (d.rejected && i && !i.value.trim()) { i.value = d.rejected; $("#chatSend").disabled = false; }
      } else if (d.t === "article") {
        refreshArticleInPlace(id);
      } else if (d.t === "closed") {
        storyClosed(id);
      }
    });
    ws.addEventListener("close", () => {
      if (room.ws !== ws || room.closing) return;
      // Offline: wait for the connection to come back (the "online" listener reconnects)
      if (!navigator.onLine) { showChatError("You're offline. Chat reconnects when you're back online."); return; }
      // Reconnect with backoff while the person is still in this room
      const wait = Math.min(15000, 1000 * 2 ** room.tries++);
      showChatError("Reconnecting…");
      setTimeout(() => { if (S.current === "article" && S.article === id && room.ws === ws) { room.id = null; connectRoom(id); } }, wait);
    });
  }
  function showChatError(t) {
    room.error = t;
    const e = $("#chatErr");
    if (e) { e.hidden = !t; e.textContent = t; }
    if (t && t !== "Reconnecting…" && navigator.onLine) setTimeout(() => { if (room.error === t) showChatError(""); }, 6000);
  }

  function renderChat(toBottom) {
    const box = $("#msgs");
    if (!box) return;
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const myId = S.me && S.me.id, mod = S.me && S.me.role === "moderator";
    const groups = [];
    room.messages.forEach(m => {
      const g = groups[groups.length - 1];
      if (g && g.uid === m.uid && m.at - g.items[g.items.length - 1].at < 5 * 60000) g.items.push(m);
      else groups.push({ uid: m.uid, items: [m] });
    });
    box.innerHTML = room.messages.length ? groups.map(g => {
      // The newsroom's own notes ("Article updated: …") sit apart from people's messages
      if (g.uid === "newsroom") return `<div class="grp sys"><div class="meta"><b>Newsroom</b> · ${esc(hm(g.items[0].at))}</div>
        ${g.items.map(m => `<div class="bubble-row"><div class="bubble">${esc(m.text)}</div>${mod ? `<button type="button" class="x${room.armed === m.id ? " armed" : ""}" data-del="${esc(m.id)}" aria-label="Remove note">${room.armed === m.id ? "Remove?" : "×"}</button>` : ""}</div>`).join("")}</div>`;
      const mine = g.uid === myId;
      return `<div class="grp${mine ? " mine" : ""}">
        ${avatar(room.profiles[g.uid] || { id: g.uid, name: "" })}
        <div class="meta"><b>${esc(nameOf(g.uid))}</b> ${mine ? "You · " : "· "}${esc(hm(g.items[0].at))}</div>
        ${g.items.map(m => `<div class="bubble-row"><div class="bubble">${esc(m.text)}</div>${mine || mod
          ? `<button type="button" class="x${room.armed === m.id ? " armed" : ""}" data-del="${esc(m.id)}" aria-label="${mine ? "Delete" : "Remove"} message">${room.armed === m.id ? (mine ? "Delete?" : "Remove?") : "×"}</button>` : reportBtn(m)}</div>`).join("")}
      </div>`;
    }).join("") : `<div class="chat-empty">No messages yet.<br>Start the conversation about this article.</div>`;
    box.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => {
      const id = b.dataset.del;
      if (room.armed !== id) {
        room.armed = id; clearTimeout(room.armedTimer);
        room.armedTimer = setTimeout(() => { room.armed = null; renderChat(); }, 4000);
        return renderChat();
      }
      room.armed = null; sendRoom({ t: "del", id });
    }));
    box.querySelectorAll("[data-rep]").forEach(b => b.addEventListener("click", async () => {
      const id = b.dataset.rep;
      if (room.armed !== "r:" + id) {
        room.armed = "r:" + id; clearTimeout(room.armedTimer);
        room.armedTimer = setTimeout(() => { room.armed = null; renderChat(); }, 4000);
        return renderChat();
      }
      room.armed = null;
      const err = await sendReport("message", id);
      if (err) showChatError(err); else reported.add(id);
      renderChat();
    }));
    if (toBottom || near) box.scrollTop = box.scrollHeight;
    renderHere();
    const e = $("#chatErr"); if (e) { e.hidden = !room.error; e.textContent = room.error; }
  }

  // Signed-in readers can flag someone else's message for a moderator
  function reportBtn(m) {
    if (!S.me || S.me.banned) return "";
    if (reported.has(m.id)) return `<span class="x armed rep-done">Reported</span>`;
    const armed = room.armed === "r:" + m.id;
    return `<button type="button" class="x${armed ? " armed" : ""}" data-rep="${esc(m.id)}" aria-label="Report this message to a moderator">${armed ? "Report?" : "⚑"}</button>`;
  }
  /** Flag a chat message or comment. Returns an error to show, or "" when it went through. */
  async function sendReport(kind, id) {
    const r = await fetch("/api/reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, id }) }).catch(() => null);
    if (r && r.ok) return "";
    const d = r ? await r.json().catch(() => ({})) : {};
    return d.error || "That report didn't go through. Try again.";
  }

  function renderHere() {
    const here = $("#here"), typing = $("#typing");
    if (!here) return;
    const people = room.here;
    here.innerHTML = people.length
      ? `<span class="stack">${people.slice(0, 4).map(p => avatar(room.profiles[p.id] || { id: p.id, name: "" })).join("")}</span><span>${people.length} here</span>`
      : `<span>${room.messages.length} ${room.messages.length === 1 ? "message" : "messages"}</span>`;
    const rn = $("#reopenN"); if (rn) rn.textContent = people.length ? `${people.length} here` : String(room.messages.length);
    const typers = people.filter(p => p.typing && p.id !== (S.me && S.me.id)).map(p => nameOf(p.id));
    typing.textContent = !typers.length ? "" : typers.length === 1 ? `${typers[0]} is typing…`
      : typers.length === 2 ? `${typers[0]} and ${typers[1]} are typing…` : "Several people are typing…";
  }

  // ---------- Review queue (moderators) ----------
  // Drafts the newsroom held back with review: true. Approving publishes under Developing; discarding hides it for good.
  const RV = { armed: null };
  async function loadReview() {
    const box = $("#pReview");
    if (!box) return;
    let drafts;
    try { drafts = (await getJSON("/api/review")).drafts; } catch (e) { box.innerHTML = `<p class="msg" style="border:0">Couldn't load drafts.</p>`; return; }
    if (S.current !== "profile") return;
    box.innerHTML = drafts.length ? drafts.map(d => `<details class="draft glass">
        <summary><span class="k">${esc(d.kind)} · ${esc(d.area || "Halifax")}${d.author ? " · by " + esc(d.author) : ""} · ${ago(d.updatedAt)}</span><b>${esc(d.headline)}</b></summary>
        ${d.dek ? `<p class="dek-s">${esc(d.dek)}</p>` : ""}
        ${d.facts.length ? `<dl class="facts">${d.facts.map(f => `<dt>${esc(f.k)}</dt><dd>${esc(f.v)}</dd>`).join("")}</dl>` : ""}
        ${d.body.map(p => `<p>${esc(p)}</p>`).join("")}
        ${d.means.length ? `<ul>${d.means.map(p => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
        <p class="src-s">Source: <a href="${esc(d.source)}" target="_blank" rel="noopener">${esc(d.source)}</a></p>
        <div class="review-acts">
          <button type="button" class="btn primary" data-review="approve" data-id="${esc(d.id)}">Approve and publish</button>
          <button type="button" class="btn ghost" data-review="discard" data-id="${esc(d.id)}">${RV.armed === d.id ? "Discard for good" : "Discard"}</button>
        </div>
      </details>`).join("") : `<p class="msg" style="border:0">Nothing waiting. Sensitive stories the newsroom holds back show up here.</p>`;
    box.querySelectorAll("[data-review]").forEach(b => b.addEventListener("click", async () => {
      const { review: action, id } = b.dataset;
      if (action === "discard" && RV.armed !== id) { RV.armed = id; return loadReview(); }
      RV.armed = null;
      b.disabled = true;
      await fetch(`/api/stories/${encodeURIComponent(id)}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) });
      loadReview(); loadStories();
    }));
  }

  // ---------- Reports (moderators) ----------
  // Messages and comments readers flagged. Removing takes it down everywhere; banning is on the writer's profile.
  async function loadReports() {
    const box = $("#pReports");
    if (!box) return;
    let list;
    try { list = (await getJSON("/api/reports")).reports; } catch (e) { box.innerHTML = `<p class="msg" style="border:0">Couldn't load reports.</p>`; return; }
    if (S.current !== "profile") return;
    box.innerHTML = list.length ? list.map(r => `<div class="report glass">
        <span class="k">${r.kind === "message" ? "Chat message" : "Comment"} · ${r.reports} ${r.reports === 1 ? "report" : "reports"} · ${ago(r.at)}</span>
        <p class="rq">${esc(r.text)}</p>
        <p class="rw">By <button type="button" class="by-link" data-user="${esc(r.authorId)}">${esc(r.author || "someone")}</button>${r.banned ? " (banned)" : ""}
          in <button type="button" class="by-link" data-article="${esc(r.storyId)}">${esc(r.headline || "a story")}</button></p>
        <div class="review-acts">
          <button type="button" class="btn primary" data-rp="remove" data-id="${esc(r.id)}">Remove it</button>
          <button type="button" class="btn ghost" data-rp="dismiss" data-id="${esc(r.id)}">It's fine</button>
        </div>
      </div>`).join("") : `<p class="msg" style="border:0">No open reports. When readers flag a message or comment, it shows up here.</p>`;
    box.querySelectorAll("[data-rp]").forEach(b => b.addEventListener("click", async () => {
      b.disabled = true;
      await fetch(`/api/reports/${encodeURIComponent(b.dataset.id)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: b.dataset.rp }) }).catch(() => null);
      loadReports();
    }));
  }

  // ---------- Profile ----------
  let authMode = "login";
  // Turnstile (Cloudflare's bot check) on sign-up, loaded only when someone opens the sign-up form
  let tsReady = null, tsToken = "", tsWidget = null;
  function loadTurnstile() {
    if (!tsReady) tsReady = new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      sc.async = true; sc.onload = res; sc.onerror = () => { tsReady = null; rej(); };
      document.head.appendChild(sc);
    });
    return tsReady;
  }
  function resetTurnstile() { tsToken = ""; if (tsWidget != null && window.turnstile) window.turnstile.reset(tsWidget); }
  function renderMeButton() {
    const b = $("#meBtn");
    if (S.me) {
      b.innerHTML = S.me.avatarUrl ? `<img alt="" src="${esc(S.me.avatarUrl)}" referrerpolicy="no-referrer">`
        : `<span class="ini" style="background:${hue(S.me.id)}">${esc((S.me.name || "?")[0].toUpperCase())}</span>`;
      b.setAttribute("aria-label", `Your profile (${S.me.name || "signed in"})`);
    } else {
      b.innerHTML = PERSON_SVG; b.setAttribute("aria-label", "Sign in");
    }
  }

  /** Someone's public profile; for the newsroom's journalist, every story they wrote. */
  const UM = { armed: null, link: null };
  async function renderUser() {
    const v = $("#user"), id = S.user;
    const backBtn = S.userFrom && S.userFrom.startsWith("article-")
      ? `<button type="button" class="back" data-article="${esc(S.userFrom.slice(8))}">← Back to the story</button>` : back();
    if (!S.users[id]) v.innerHTML = `<div class="profile">${backBtn}${loadingMsg()}</div>`;
    let d = S.users[id];
    try { d = S.users[id] = await getJSON("/api/users/" + encodeURIComponent(id)); }
    catch (e) { if (!d) { if (S.current === "user" && S.user === id) v.innerHTML = `<div class="profile">${backBtn}<div class="msg">This profile isn't available.</div></div>`; return; } }
    if (S.current !== "user" || S.user !== id) return;
    const u = d.user, st = d.stories || [];
    const live = st.filter(x => x.stage === "developing").length;
    const stats = u.ai
      ? [[st.length, st.length === 1 ? "story" : "stories"], [live, "developing now"], [st.filter(x => x.kind === "notice").length, "notices"]]
      : [[d.stats.messages, d.stats.messages === 1 ? "message sent" : "messages sent"], [d.stats.rooms, d.stats.rooms === 1 ? "chat joined" : "chats joined"]];
    v.innerHTML = `<div class="profile">${backBtn}
      <div class="profile-card glass">
        <div class="pic">${u.avatar ? `<img alt="" src="${esc(u.avatar)}" referrerpolicy="no-referrer">` : avatar({ id: u.id, name: u.name }, "av").replace('class="av"', 'class="av" style="width:100%;height:100%;font-size:32px;background:' + hue(u.id) + '"')}</div>
        <div><h1>${esc(u.name || "Someone")}</h1><p>${u.ai ? "TalkHalifax journalist" : "Halifax"}${u.ai ? '<span class="role">AI</span>' : u.role === "moderator" ? '<span class="role">Moderator</span>' : ""}</p></div>
      </div>
      ${u.bio ? `<p class="u-bio">${esc(u.bio)}</p>` : ""}
      <div class="stats">${stats.map(([n, l]) => `<div class="stat glass"><b>${n || 0}</b><span>${l}</span></div>`).join("")}</div>
      ${u.ai ? `<h2 class="p-h">Stories by ${esc((u.name || "").split(" ")[0])}</h2>
      <div class="cards">${st.map(x => `<button type="button" class="card glass${x.stage === "archived" ? " archived" : ""}" data-article="${esc(x.id)}">
          <span class="k">${x.stage === "developing" ? "Developing · " : ""}${esc(x.kind === "notice" ? "Notice" : x.area || x.section || "Halifax")}</span>
          <span class="tt">${esc(x.headline)}</span>
          ${x.dek ? `<span class="dk">${esc(x.dek)}</span>` : ""}
          <span class="ft"><span>${shortDate(x.publishedAt)}</span></span></button>`).join("") || '<div class="msg">No stories yet.</div>'}</div>` : ""}
      ${d.mod ? `<h2 class="p-h">Moderator tools</h2>
      ${d.mod.banned ? `<p class="u-bio">Banned: they can read, but can't chat, comment or report.</p>` : ""}
      <div class="mod-tools">
        ${d.mod.banned ? `<button type="button" class="btn ghost" data-mod="unban">Unban</button>`
          : `<button type="button" class="btn ghost" data-mod="ban">Ban from posting</button>
             <button type="button" class="btn ghost${UM.armed === "purge" ? " danger-btn" : ""}" data-mod="purge">${UM.armed === "purge" ? "Ban and erase everything they posted?" : "Ban and remove their posts"}</button>`}
        ${d.mod.password ? `<button type="button" class="btn ghost" data-mod="reset">Make a password reset link</button>` : ""}
      </div>
      ${UM.link && UM.link.id === u.id ? `<div class="reset-link glass"><label for="rsUrl">Reset link for ${esc(u.name)}</label>
        <div class="row2"><input id="rsUrl" readonly value="${esc(UM.link.url)}"><button type="button" class="btn primary" id="rsCopy">Copy</button></div>
        <small>Works once, for the next hour. Send it to them privately; anyone with it can set their password.</small></div>` : ""}
      <div class="auth-err" id="umErr" role="alert" hidden></div>` : ""}
      <p class="p-note">${u.ai ? "An AI journalist: every story is written from an official release, and an editor approves articles before they publish." : `Joined ${shortDate(u.joined)}.`}</p>
    </div>`;
    v.querySelectorAll("[data-mod]").forEach(b => b.addEventListener("click", async () => {
      const act = b.dataset.mod, err = $("#umErr");
      if (act === "purge" && UM.armed !== "purge") { UM.armed = "purge"; return renderUser(); }
      UM.armed = null; b.disabled = true;
      const post = (path, body) => fetch(`/api/users/${encodeURIComponent(id)}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
      const r = act === "reset" ? await post("reset", {}) : await post("ban", { banned: act !== "unban", purge: act === "purge" });
      const out = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) { err.textContent = out.error || "That didn't work. Try again."; err.hidden = false; b.disabled = false; return; }
      if (act === "reset") UM.link = { id, url: out.url };
      renderUser();
    }));
    const copy = $("#rsCopy");
    if (copy) copy.addEventListener("click", async () => {
      const i = $("#rsUrl"); i.select();
      try { await navigator.clipboard.writeText(i.value); copy.textContent = "Copied"; } catch (e) { document.execCommand("copy"); copy.textContent = "Copied"; }
    });
  }

  /** A reset link a moderator sent: choose a new password, then you're signed in. */
  async function renderReset() {
    const v = $("#reset"), token = S.resetToken;
    v.innerHTML = `<div class="profile">${back()}${loadingMsg()}</div>`;
    let who;
    try {
      const r = await fetch("/auth/reset?token=" + encodeURIComponent(token));
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "This reset link isn't working. Ask a moderator for a new one.");
      who = d.username;
    } catch (e) {
      if (S.current === "reset") v.innerHTML = `<div class="profile">${back()}<div class="msg">${esc(e.message && !/fetch/i.test(e.message) ? e.message : "Can't reach TalkHalifax. Check your connection and try again.")}</div></div>`;
      return;
    }
    if (S.current !== "reset") return;
    v.innerHTML = `<div class="profile">${back()}
      <div class="profile-card glass"><div class="pic">${PERSON_SVG}</div>
        <div><h1>Choose a new password</h1><p>For <b>${esc(who)}</b>. This link works once.</p></div></div>
      <form class="auth-form glass" id="rsForm" novalidate>
        <input type="text" name="username" autocomplete="username" value="${esc(who)}" hidden>
        <label for="rsPass">New password</label>
        <input id="rsPass" type="password" autocomplete="new-password" minlength="8" maxlength="200" required aria-describedby="rsHint">
        <small id="rsHint">At least 8 characters. Anywhere else this account is signed in will be signed out.</small>
        <div class="auth-err" id="rsErr" role="alert" hidden></div>
        <button type="submit" class="btn primary" id="rsGo">Save and sign in</button>
      </form>
    </div>`;
    $("#rsForm").addEventListener("submit", async e => {
      e.preventDefault();
      const err = $("#rsErr"), go = $("#rsGo");
      go.disabled = true; err.hidden = true;
      const r = await fetch("/auth/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: $("#rsPass").value }) }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      if (!r || !r.ok) { err.textContent = d.error || "Can't reach TalkHalifax. Check your connection and try again."; err.hidden = false; go.disabled = false; return; }
      await loadMe();
      goTo("profile");
    });
  }

  async function renderProfile() {
    const v = $("#profile");
    const backBtn = back();
    if (!S.me) {
      const p = S.providers;
      const creating = authMode === "signup";
      v.innerHTML = `<div class="profile">${backBtn}
        <div class="profile-card glass"><div class="pic">${PERSON_SVG}</div>
          <div><h1>${creating ? "Join TalkHalifax" : "Welcome back"}</h1><p>${creating ? "Pick a username to chat about the city's news. No email needed." : "Sign in to join the live chats."}</p></div></div>
        <div class="auth-tabs" role="tablist" aria-label="Sign in or create an account">
          <button type="button" role="tab" class="sort" data-mode="login" aria-pressed="${!creating}" aria-selected="${!creating}">Sign in</button>
          <button type="button" role="tab" class="sort" data-mode="signup" aria-pressed="${creating}" aria-selected="${creating}">Create account</button>
        </div>
        <form class="auth-form glass" id="authForm" novalidate>
          <label for="authUser">Username</label>
          <input id="authUser" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" required
            ${creating ? 'pattern="[A-Za-z0-9_.\\-]{3,20}" aria-describedby="userHint"' : ""}>
          ${creating ? '<small id="userHint">3 to 20 characters: letters, numbers, dots, dashes or underscores. Shown next to your messages.</small>' : ""}
          <label for="authPass">Password</label>
          <input id="authPass" name="password" type="password" autocomplete="${creating ? "new-password" : "current-password"}" minlength="${creating ? 8 : 1}" maxlength="200" required ${creating ? 'aria-describedby="passHint"' : ""}>
          ${creating ? '<small id="passHint">At least 8 characters. There\'s no email reset: if you\'re locked out, a moderator can send you a reset link.</small>' : ""}
          ${creating && p.turnstile ? '<div class="ts-box" id="tsBox"></div>' : ""}
          <div class="auth-err" id="authErr" role="alert" hidden></div>
          <button type="submit" class="btn primary" id="authGo">${creating ? "Create account" : "Sign in"}</button>
        </form>
        ${p.google || p.dev ? `<div class="signin">
          ${p.google ? `<a class="btn ghost" href="/auth/google?return=${encodeURIComponent("/#profile")}">Continue with Google</a>` : ""}
          ${p.dev ? `<form class="dev" id="devForm"><label class="sr" for="devName">Name</label><input id="devName" placeholder="Your name (local dev)" maxlength="40" required><button class="btn ghost" type="submit">Dev sign-in</button></form>` : ""}
        </div>` : ""}
        <h2 class="p-h" id="alertsH">Alerts on this device</h2>
        <div id="pAlerts"><p class="msg" style="border:0">Loading…</p></div>
        <p class="p-note">How TalkHalifax handles your account and messages: <a href="#privacy">Privacy</a>.</p>
      </div>`;
      openAlerts();
      if (creating && p.turnstile) loadTurnstile().then(() => {
        if (!$("#tsBox")) return;
        tsToken = "";
        tsWidget = window.turnstile.render("#tsBox", { sitekey: p.turnstile, theme: "auto", size: "flexible",
          callback: t => { tsToken = t; }, "expired-callback": () => { tsToken = ""; }, "error-callback": () => { tsToken = ""; } });
      }).catch(() => { const e = $("#authErr"); if (e) { e.textContent = "The bot check didn't load. Check your connection and reload."; e.hidden = false; } });
      v.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { authMode = b.dataset.mode; renderProfile(); $("#authUser").focus(); }));
      $("#authForm").addEventListener("submit", async e => {
        e.preventDefault();
        const err = $("#authErr"), go = $("#authGo");
        const username = $("#authUser").value.trim(), password = $("#authPass").value;
        const fail = t => { err.textContent = t; err.hidden = false; go.disabled = false; };
        if (!username || !password) return fail("Enter a username and password.");
        if (creating && p.turnstile && !tsToken) return fail("Finish the check above the button first.");
        go.disabled = true; err.hidden = true;
        try {
          const r = await fetch(creating ? "/auth/signup" : "/auth/login", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password, turnstile: creating ? tsToken : undefined }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) { if (creating) resetTurnstile(); return fail(d.error || "That didn't work. Try again."); }
          await loadMe();
          if (S.current === "profile") renderProfile();
        } catch (x) { fail("Can't reach TalkHalifax. Check your connection and try again."); }
      });
      const f = $("#devForm");
      if (f) f.addEventListener("submit", e => { e.preventDefault(); location.href = `/auth/dev?name=${encodeURIComponent($("#devName").value)}&return=${encodeURIComponent("/#profile")}`; });
      return;
    }
    v.innerHTML = `<div class="profile">${backBtn}
      <div class="profile-card glass">
        <div class="pic">${S.me.avatarUrl ? `<img alt="" src="${esc(S.me.avatarUrl)}" referrerpolicy="no-referrer">` : avatar({ id: S.me.id, name: S.me.name }, "av").replace('class="av"', 'class="av" style="width:100%;height:100%;font-size:32px;background:' + hue(S.me.id) + '"')}</div>
        <div><h1 id="pName"></h1><p>Halifax${S.me.role === "moderator" ? '<span class="role">Moderator</span>' : ""}</p></div>
      </div>
      <div class="stats" id="pStats">
        <div class="stat glass"><b>–</b><span>messages sent</span></div>
        <div class="stat glass"><b>–</b><span>chats joined</span></div>
        <div class="stat glass"><b>–</b><span>in the last 24 hours</span></div>
      </div>
      ${S.me.role === "moderator" ? `<h2 class="p-h">Reports</h2><div id="pReports"><p class="msg" style="border:0">Loading…</p></div>` : ""}
      ${S.me.role === "moderator" ? `<h2 class="p-h">Drafts waiting for review</h2><div id="pReview"><p class="msg" style="border:0">Loading…</p></div>` : ""}
      <h2 class="p-h">Your recent messages</h2>
      <ul class="activity" id="pActivity"><li class="msg" style="border:0">Loading…</li></ul>
      <h2 class="p-h">Settings</h2>
      <div class="setting"><span>Show the live chat when I open an article<small>On a phone it always starts tucked away at the bottom.</small></span>
        <button type="button" class="switch" id="chatPref" role="switch" aria-checked="${!chatHidden}" aria-label="Show the live chat when I open an article"></button></div>
      <h2 class="p-h" id="alertsH">Alerts on this device</h2>
      <div id="pAlerts"><p class="msg" style="border:0">Loading…</p></div>
      ${S.me.password ? `<details class="setting-more"><summary>Change password</summary>
        <form class="auth-form glass" id="pwForm" novalidate>
          <input type="text" name="username" autocomplete="username" value="${esc(S.me.name || "")}" hidden>
          <label for="pwCur">Current password</label>
          <input id="pwCur" type="password" autocomplete="current-password" maxlength="200" required>
          <label for="pwNew">New password</label>
          <input id="pwNew" type="password" autocomplete="new-password" minlength="8" maxlength="200" required aria-describedby="pwHint">
          <small id="pwHint">At least 8 characters. You stay signed in here; anywhere else is signed out.</small>
          <div class="auth-err" id="pwErr" role="alert" hidden></div>
          <button type="submit" class="btn primary" id="pwGo">Change password</button>
        </form></details>` : ""}
      <button type="button" class="btn ghost signout" id="signOut">Sign out</button>
      <button type="button" class="btn ghost del-acct" id="delAcct">Delete my account</button>
      <p class="p-note">TalkHalifax keeps your ${S.me.password ? "username, a scrambled (hashed) copy of your password" : "name, email and photo from Google"}, and what you post. <a href="#privacy">Privacy</a></p>
    </div>`;
    $("#pName").textContent = S.me.name || "You";
    openAlerts();
    $("#chatPref").addEventListener("click", e => { setChatHidden(!chatHidden); e.currentTarget.setAttribute("aria-checked", String(!chatHidden)); });
    $("#signOut").addEventListener("click", async () => { await fetch("/auth/logout", { method: "POST" }); location.href = "/"; });
    let delArmed = false;
    $("#delAcct").addEventListener("click", async e => {
      const b = e.currentTarget;
      if (!delArmed) { delArmed = true; b.classList.add("danger-btn"); b.textContent = "Delete for good? Your messages and comments are erased too."; return; }
      b.disabled = true;
      const r = await fetch("/api/me", { method: "DELETE" }).catch(() => null);
      if (r && r.ok) { location.href = "/"; return; }
      b.disabled = false; b.textContent = "That didn't work. Tap to try again.";
    });
    const pw = $("#pwForm");
    if (pw) pw.addEventListener("submit", async e => {
      e.preventDefault();
      const err = $("#pwErr"), go = $("#pwGo");
      go.disabled = true; err.hidden = true;
      const r = await fetch("/auth/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ current: $("#pwCur").value, password: $("#pwNew").value }) }).catch(() => null);
      const d = r ? await r.json().catch(() => ({})) : {};
      go.disabled = false;
      if (!r || !r.ok) { err.textContent = d.error || "Can't reach TalkHalifax. Check your connection and try again."; err.hidden = false; return; }
      pw.reset(); err.textContent = "Password changed."; err.classList.add("ok"); err.hidden = false;
    });
    if (S.me.role === "moderator") { loadReports(); loadReview(); }
    try {
      const d = await getJSON("/api/me/messages");
      if (S.current !== "profile") return;
      const st = d.stats || {};
      $("#pStats").innerHTML = [[st.messages, (st.messages === 1 ? "message" : "messages") + " sent"], [st.rooms, (st.rooms === 1 ? "chat" : "chats") + " joined"], [st.today || 0, "in the last 24 hours"]]
        .map(([n, l]) => `<div class="stat glass"><b>${n || 0}</b><span>${l}</span></div>`).join("");
      $("#pActivity").innerHTML = d.messages.slice(0, 15).map(m => `<li><button type="button" data-article="${esc(m.storyId)}">
          <span class="q">${esc(m.text)}</span><span class="r">${ago(m.at)}</span>
          <span class="w">in ${esc(m.headline || "an article that's no longer listed")}</span></button></li>`).join("")
        || `<li class="msg" style="border:0">You haven't said anything yet. Open a discussion on the home page to join its live chat.</li>`;
    } catch (e) { $("#pActivity").innerHTML = `<li class="msg" style="border:0">Couldn't load your messages.</li>`; }
  }

  // ---------- Drawer (phones): the profile button opens the sections ----------
  const phone = () => window.matchMedia("(max-width: 760px)").matches;
  const drawer = $("#navDrawer");
  function renderDrawer() {
    const live = (S.stories || []).filter(x => x.kind === "article" && x.stage === "developing").length;
    const urgent = allNotices().filter(n => !n.old && n.sev === "urgent").length;
    const here = v => S.current === v ? ' aria-current="page"' : "";
    const who = S.me
      ? `${avatar({ id: S.me.id, name: S.me.name, avatar: S.me.avatarUrl })}<span><b>${esc(S.me.name || "You")}</b><small>${S.me.role === "moderator" ? "Moderator · " : ""}Your profile</small></span>`
      : `<span class="av anon">${PERSON_SVG}</span><span><b>Sign in</b><small>Or create an account to chat</small></span>`;
    drawer.innerHTML = `<div class="dr-in">
      <div class="dr-head">
        <button type="button" class="dr-who" data-go="profile"${here("profile")}>${who}</button>
        <button type="button" class="dr-x" id="drClose" aria-label="Close menu"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
      </div>
      <nav class="dr-nav" aria-label="Sections">
        <button type="button" class="dr-link" data-go="home"${here("home")}>Developing Stories${live ? `<span class="n">${live} LIVE</span>` : ""}</button>
        <button type="button" class="dr-link" data-go="articles"${here("articles")}>Articles</button>
        <button type="button" class="dr-link" data-go="notices"${here("notices")}>Notices${urgent ? `<span class="n">${urgent} URGENT</span>` : ""}</button>
        <button type="button" class="dr-link" data-go="events"${here("events")}>Events</button>
        <button type="button" class="dr-link" data-go="transit"${here("transit")}>Transit</button>
      </nav>
      <p class="dr-foot">Written by AI from official releases. <button type="button" class="by-link" data-go="privacy">Privacy</button></p>
    </div>`;
    $("#drClose").onclick = closeDrawer;
  }
  function openDrawer() {
    renderDrawer();
    drawer.classList.remove("closing");
    drawer.showModal();
    // showModal focuses the first button, which iOS outlines; start focus on the panel itself instead
    drawer.focus();
    $("#meBtn").setAttribute("aria-expanded", "true");
  }
  function closeDrawer() {
    if (!drawer.open) return;
    $("#meBtn").setAttribute("aria-expanded", "false");
    if (reducedMotion()) return drawer.close();
    drawer.classList.add("closing");
    setTimeout(() => { drawer.classList.remove("closing"); drawer.close(); }, 200);
  }
  drawer.addEventListener("cancel", e => { e.preventDefault(); closeDrawer(); }); // Escape slides it out too
  drawer.addEventListener("click", e => { if (e.target === drawer) closeDrawer(); }); // tap on the dimmed page
  window.matchMedia("(max-width: 760px)").addEventListener("change", e => { if (!e.matches) closeDrawer(); });
  $("#meBtn").addEventListener("click", () => phone() ? openDrawer() : goTo("profile"));

  // ---------- Navigation: Developing Stories (home), Articles, a profile, or one article room ----------
  const VIEWS = ["home", "articles", "notices", "events", "transit", "profile", "privacy"];
  function show(v) {
    if (v.startsWith("article-")) { S.article = v.slice(8); v = "article"; }
    else if (v.startsWith("user-")) {
      const id = v.slice(5);
      if (S.current !== "user" || S.user !== id) S.userFrom = S.current === "article" ? "article-" + S.article : S.current;
      S.user = id; v = "user";
    }
    else if (v.startsWith("reset-")) { S.resetToken = v.slice(6); v = "reset"; }
    else if (v.startsWith("transit")) { S.transitRoute = decodeURIComponent(v.slice(8)); v = "transit"; }
    // Alerts are a section of the profile, so old #alerts links land there
    const toAlerts = v === "alerts";
    if (toAlerts) v = "profile";
    else if (!VIEWS.includes(v)) v = "home";
    if (v !== "article") { S.article = null; chatOpen = false; leaveRoom(); }
    if (v !== "transit") window.THTransit?.close();
    S.current = v;
    renderBanners(); // Home only
    for (const id of [...VIEWS, "article", "user", "reset"]) $("#" + id).hidden = v !== id;
    document.body.classList.toggle("wide-view", v === "article");
    document.body.classList.toggle("transit-view", v === "transit");
    if (v === "profile") $("#meBtn").setAttribute("aria-current", "page"); else $("#meBtn").removeAttribute("aria-current");
    document.querySelectorAll(".hnav [data-go]").forEach(b => { if (b.dataset.go === v) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); });
    try { history.replaceState(null, "", "#" + hashOf(v)); } catch (e) {}
    if (v === "article") renderArticle(); else if (v === "user") renderUser(); else if (v === "reset") renderReset(); else if (v === "privacy") {} else if (v === "transit") openTransit(); else if (v === "events") openEvents(); else if (v === "profile") renderProfile(); else if (v === "articles") renderArticles(); else if (v === "notices") renderNotices(); else renderHome();
    applyChatState();
    // The profile can redraw once sign-in state loads, so keep landing on Alerts for a moment after the request
    if (toAlerts) { alertsScrollUntil = Date.now() + 2500; setTimeout(scrollToAlerts, 60); }
  }
  // The Transit map lives in its own script (and MapLibre), loaded the first time someone opens it
  let transitScript;
  function openTransit() {
    transitScript ||= new Promise((res, rej) => { const s = document.createElement("script"); s.src = "/transit.js"; s.onload = res; s.onerror = () => { transitScript = null; rej(); }; document.head.appendChild(s); });
    transitScript.then(() => { if (S.current === "transit") window.THTransit.open($("#transit"), S.transitRoute || ""); })
      .catch(() => { $("#transit").innerHTML = `<div class="msg">The transit map couldn't load. Check your connection and try again.</div>`; });
  }
  // Events and alerts live in their own scripts too, loaded the first time they're needed
  const scripts = {};
  const lazy = src => scripts[src] ||= new Promise((res, rej) => {
    const s = document.createElement("script"); s.src = src; s.onload = res;
    s.onerror = () => { delete scripts[src]; rej(); }; document.head.appendChild(s);
  });
  function openEvents() {
    lazy("/events.js").then(() => { if (S.current === "events") window.THEvents.open($("#events")); })
      .catch(() => { $("#events").innerHTML = `<div class="msg">The events list couldn't load. Check your connection and try again.</div>`; });
  }
  /** The Alerts section of the profile (signed in or not: alerts belong to the device, not an account). */
  let alertsScrollUntil = 0;
  function scrollToAlerts() { const a = $("#alertsH"); if (a && Date.now() < alertsScrollUntil) a.scrollIntoView({ block: "start" }); }
  function openAlerts() {
    const el = $("#pAlerts");
    if (!el) return;
    scrollToAlerts();
    lazy("/alerts.js").then(async () => { if (S.current === "profile" && el.isConnected) { await window.THAlerts.open(el, { embedded: true }); scrollToAlerts(); } })
      .catch(() => { el.innerHTML = `<div class="msg">Alerts couldn't load. Check your connection and try again.</div>`; });
  }
  const goTo = v => { closeDrawer(); show(v); window.scrollTo({ top: 0 }); };
  const hashOf = v => v === "article" ? "article-" + S.article : v === "user" ? "user-" + S.user : v === "reset" ? "reset-" + S.resetToken : v === "transit" && S.transitRoute ? "transit-" + encodeURIComponent(S.transitRoute) : v;
  document.addEventListener("click", e => {
    const a = e.target.closest("[data-article]");
    if (a) { e.preventDefault(); return goTo("article-" + a.dataset.article); }
    const p = e.target.closest("[data-user]");
    if (p) { e.preventDefault(); return goTo("user-" + p.dataset.user); }
    const g = e.target.closest("[data-go]");
    if (g) { e.preventDefault(); goTo(g.dataset.go); }
  });
  window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (h !== hashOf(S.current)) goTo(h); });

  // ---------- Pull to refresh ----------
  // Home-screen web apps on iOS have no browser reload, so pulling down from the top refreshes the current view.
  // In a normal browser tab the browser's own pull-to-refresh already does this, so it stays off there.
  async function refreshView() {
    if (S.current === "home") return Promise.all([loadStories(), loadAlerts()]);
    if (S.current === "articles") return loadStories();
    if (S.current === "notices") return Promise.all([loadStories(), loadAlerts()]);
    if (S.current === "profile") return loadMe();
    if (S.current === "user") return renderUser();
    if (S.current === "events") return window.THEvents?.refresh();
    if (S.current === "reset" || S.current === "privacy" || S.current === "transit") return;
    const id = S.article, before = S.full[id];
    let a;
    try { a = await fetchStory(id); } catch (e) { return; }
    if (S.current !== "article" || S.article !== id) return;
    const col = $("#articleCol");
    // A story that changed kind or stage (e.g. moved to Articles) needs its whole page rebuilt
    if (!before || before.kind !== a.kind || before.stage !== a.stage || !col) return renderArticle();
    col.innerHTML = back(a) + articleHTML(a);
    wireStageTools();
    if ($("#cmList")) loadComments(id);
    if (a.kind === "article" && a.stage === "developing") connectRoom(id); // reconnects if iOS dropped the socket
  }

  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  if (standalone && "ontouchstart" in window) {
    const THRESHOLD = 70, MAX = 110;
    const ptr = document.createElement("div");
    ptr.className = "ptr glass";
    ptr.setAttribute("aria-hidden", "true");
    ptr.innerHTML = '<svg class="arrow" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 5v13M6 12l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '<svg class="spin" width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 4a8 8 0 1 0 8 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
    document.body.appendChild(ptr);
    const status = document.createElement("div");
    status.className = "sr"; status.setAttribute("role", "status");
    document.body.appendChild(status);
    let startY = null, startX = 0, pull = 0, busy = false;
    const paint = () => {
      const p = Math.min(1, pull / THRESHOLD);
      ptr.style.transform = `translate(-50%, ${pull ? Math.min(pull, MAX) - 52 : -52}px) rotate(${busy ? 0 : p * 180}deg)`;
      ptr.style.opacity = busy ? 1 : p;
      ptr.classList.toggle("ready", !busy && pull >= THRESHOLD);
    };
    document.addEventListener("touchstart", e => {
      const t = e.target;
      if (busy || e.touches.length !== 1 || window.scrollY > 0 || t.closest(".chat, #transit, input, textarea, [contenteditable]")) { startY = null; return; }
      startY = e.touches[0].clientY; startX = e.touches[0].clientX; pull = 0;
    }, { passive: true });
    document.addEventListener("touchmove", e => {
      if (startY == null) return;
      const dy = e.touches[0].clientY - startY, dx = e.touches[0].clientX - startX;
      if (dy <= 0 || Math.abs(dx) > dy || window.scrollY > 0) { if (pull) { pull = 0; paint(); } return; }
      pull = dy * 0.5;
      ptr.classList.add("drag");
      paint();
    }, { passive: true });
    const end = async () => {
      if (startY == null) return;
      startY = null;
      ptr.classList.remove("drag");
      if (pull < THRESHOLD) { pull = 0; paint(); return; }
      busy = true; pull = THRESHOLD; ptr.classList.add("busy"); paint();
      status.textContent = "Refreshing";
      const minSpin = new Promise(r => setTimeout(r, 500)); // long enough to see that something happened
      try { await Promise.all([refreshView(), minSpin]); } catch (e) {}
      busy = false; pull = 0; ptr.classList.remove("busy"); paint();
      status.textContent = "Updated";
    };
    document.addEventListener("touchend", end);
    document.addEventListener("touchcancel", () => { startY = null; ptr.classList.remove("drag"); if (!busy) { pull = 0; paint(); } });
    paint();
  }

  // The docked chat sits just under the sticky header, whatever its height
  const hdr = document.querySelector("header");
  const setHdr = () => document.documentElement.style.setProperty("--hdr", hdr.offsetHeight + "px");
  setHdr(); if (window.ResizeObserver) new ResizeObserver(setHdr).observe(hdr);

  // ---------- Data ----------
  async function loadStories() {
    try { S.stories = (await getJSON("/api/stories")).stories; S.offline = false; }
    catch (e) { S.offline = !S.stories; }
    if (S.current === "home") renderHome(); else if (S.current === "articles") renderArticles(); else if (S.current === "notices") renderNotices();
  }
  async function loadAlerts() {
    try { S.alerts = (await getJSON("/api/alerts")).alerts || { items: [] }; } catch (e) {}
    if (S.current === "home") renderBanners(); else if (S.current === "notices") renderNotices();
  }
  async function loadMe() {
    try { const d = await getJSON("/api/me"); S.me = d.user; S.providers = d.providers; } catch (e) {}
    renderMeButton();
    if (S.current === "profile") renderProfile();
    if (S.current === "article") renderComposer();
  }

  // ---------- Offline and installed ----------
  const offlineBar = document.createElement("div");
  offlineBar.className = "offline-bar"; offlineBar.setAttribute("role", "status");
  offlineBar.textContent = "You're offline. Stories you've opened on this device are still here; chat comes back when you're online.";
  document.querySelector("header").after(offlineBar);
  const net = () => { offlineBar.hidden = navigator.onLine; document.body.classList.toggle("is-offline", !navigator.onLine); };
  net();
  window.addEventListener("offline", net);
  window.addEventListener("online", () => {
    net(); showChatError("");
    loadStories(); loadAlerts();
    const a = S.current === "article" && S.full[S.article];
    if (a && a.kind === "article" && a.stage === "developing") { room.id = null; connectRoom(S.article); }
  });
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
    // A tapped push alert, when the page couldn't be navigated directly
    navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.t === "go") location.href = e.data.url; });
  }

  // ---------- Footer ----------
  document.getElementById("sfYear").textContent = new Date().getFullYear();
  // "Install the app": the browser's own install prompt where it offers one (Chrome, Edge, Android once it's ready);
  // on iPhone, iPad and Android otherwise, a card with the steps. Hidden when it's already open as an installed app.
  let installPrompt = null;
  const sfInstall = document.getElementById("sfInstall"), installCard = document.getElementById("installCard");
  const installed = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/.test(navigator.userAgent);
  const showInstall = () => { sfInstall.hidden = installed() || !(installPrompt || isIOS || isAndroid); };
  showInstall();
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); installPrompt = e; showInstall(); });
  window.addEventListener("appinstalled", () => { installPrompt = null; sfInstall.hidden = true; if (installCard.open) installCard.close(); });
  const SHARE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  const MENU_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>`;
  function openInstallCard() {
    const otherIOSBrowser = /CriOS|FxiOS|EdgiOS/.test(navigator.userAgent), iPad = isIOS && !/iPhone|iPod/.test(navigator.userAgent);
    const steps = isIOS ? [
      `Tap the Share button <span class="ico">${SHARE_ICON}</span> ${otherIOSBrowser ? "in the address bar" : iPad ? "at the top of Safari" : "at the bottom of Safari"}.`,
      "Scroll down and tap <b>Add to Home Screen</b>.",
      "Tap <b>Add</b>. TalkHalifax is now on your Home Screen; open it from there.",
    ] : [
      `Tap the menu <span class="ico">${MENU_ICON}</span> at the top right of your browser.`,
      "Tap <b>Add to Home screen</b> or <b>Install app</b>.",
      "Tap <b>Install</b> or <b>Add</b>. TalkHalifax is now with your apps.",
    ];
    installCard.innerHTML = `<div class="ins-in">
      <div class="ins-head"><img src="/icons/icon-192.png" alt=""><h2 id="insTitle">Install TalkHalifax</h2>
        <button type="button" class="ins-x" id="insClose" aria-label="Close"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button></div>
      <ol>${steps.map(t => `<li><span>${t}</span></li>`).join("")}</ol>
      <p class="ins-note">It opens full screen like an app, keeps the stories you've read for when you're offline, and can get alerts for urgent notices.</p>
    </div>`;
    installCard.querySelector("#insClose").onclick = () => installCard.close();
    installCard.showModal();
  }
  installCard.addEventListener("click", e => { if (e.target === installCard) installCard.close(); }); // tap outside closes
  document.getElementById("sfInstallBtn").addEventListener("click", async () => {
    if (!installPrompt) return openInstallCard();
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => {});
    installPrompt = null; showInstall();
  });

  show(location.hash.slice(1) || "home");
  Promise.all([loadMe(), loadStories(), loadAlerts()]);
  // Home numbers ("2 here now", message counts) refresh while the page is visible
  setInterval(() => { if (!document.hidden && (S.current === "home" || S.current === "articles" || S.current === "notices")) loadStories(); }, 20000);
  setInterval(() => { if (!document.hidden) loadAlerts(); }, 10 * 60000);
})();
