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
    sort: "active", current: "home", article: null,
  };
  const room = { ws: null, id: null, messages: [], profiles: {}, here: [], readers: 0, you: null, error: "", typing: false, armed: null, armedTimer: null, tries: 0, closing: false };

  async function getJSON(url) {
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw new Error(url + " " + r.status);
    return r.json();
  }

  // ---------- People ----------
  const PERSON_SVG = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8.5" r="3.8" stroke="currentColor" stroke-width="1.8"/><path d="M4.5 20c1.4-3.6 4.2-5.4 7.5-5.4s6.1 1.8 7.5 5.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  const hue = id => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360; return `hsl(${h} 45% 45%)`; };
  /** A small round avatar: photo when there is one, otherwise an initial on a stable colour. */
  function avatar(p, cls = "av") {
    if (p && p.avatar) return `<span class="${cls}"><img alt="" src="${esc(p.avatar)}" referrerpolicy="no-referrer"></span>`;
    const name = (p && p.name) || "?";
    return `<span class="${cls}" style="background:${p ? hue(p.id) : "var(--ink-faint)"}" aria-hidden="true">${esc(name.trim()[0] || "?").toUpperCase()}</span>`;
  }
  const nameOf = uid => uid === (S.me && S.me.id) ? "You" : (room.profiles[uid] && room.profiles[uid].name) || "Someone";

  // ---------- Home ----------
  function renderToday() {
    const w = S.weather, c = (w && w.current) || {};
    const dash = w ? "–" : "…"; // "…" while loading, "–" when the source has no figure
    const cond = c.condition ? c.condition[0].toUpperCase() + c.condition.slice(1).toLowerCase() : "";
    const cell = (k, v, s = "") => `<div><span class="td-k">${k}</span><span class="td-v">${v}</span>${s ? `<span class="td-s">${esc(s)}</span>` : ""}</div>`;
    $("#todayLine").innerHTML =
      `<div class="td-date"><span class="td-k">${esc(fmt({ weekday: "long" }).format(new Date()))}</span><b>${esc(fmt({ month: "long", day: "numeric" }).format(new Date()))}</b></div>`
      + cell("Weather", c.tempC != null ? `${Math.round(c.tempC)}°C` : dash, cond)
      + cell("Sunrise", w && w.sunrise ? hm(w.sunrise) : dash)
      + cell("Sunset", w && w.sunset ? hm(w.sunset) : dash);
  }

  /** Banners pinned under the header on Home: weather warnings, then city notices, then watches and statements. */
  function renderBanners() {
    const el = $("#abars");
    const t = x => (x ? new Date(x).getTime() : 0);
    const items = [];
    for (const a of (S.alerts && S.alerts.items) || []) {
      if (a.cat !== "Weather") continue;
      const warn = a.kind === "Warning";
      const until = t(a.until) ? `Until ${shortDate(a.until)}, ${hm(a.until)}` : "";
      items.push({ rank: warn ? 0 : a.kind === "Watch" ? 2 : 3, sev: warn ? "" : " caution", label: `Weather · ${a.kind}`,
        title: a.title, meta: until, at: t(a.publishedAt), link: `href="${esc(a.url)}" target="_blank" rel="noopener"` });
    }
    for (const n of S.stories || []) {
      if (n.kind !== "notice" || n.supersededBy || Date.now() - t(n.publishedAt) >= 7 * 864e5) continue;
      items.push({ rank: 1, sev: "", label: "City notice" + (n.statusLabel ? " · " + n.statusLabel : ""),
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

  function renderHome() {
    renderToday();
    renderBanners();
    document.querySelectorAll(".sort").forEach(b => b.setAttribute("aria-pressed", b.dataset.sort === S.sort));
    if (!S.stories) {
      const m = `<div class="msg">${S.offline ? "TalkHalifax can't reach its server right now. Check your connection and reload." : "Loading…"}</div>`;
      $("#devCards").innerHTML = m; $("#artCards").innerHTML = m;
      return;
    }
    const t = x => (x ? new Date(x).getTime() : 0);

    renderBanners(); // city notices live in the banners now
    // ---- Developing: live stories by latest activity ----
    const dev = S.stories.filter(x => x.kind === "article" && x.stage === "developing")
      .sort((a, b) => Math.max(t(b.lastUpdate), b.room.lastAt || 0, b.room.here ? Date.now() : 0, t(b.developingSince))
                    - Math.max(t(a.lastUpdate), a.room.lastAt || 0, a.room.here ? Date.now() : 0, t(a.developingSince)));
    const devCards = dev.map((x, i) => {
      const r = x.room;
      const recentUpdate = x.lastUpdate && Date.now() - t(x.lastUpdate) < 864e5;
      const left = recentUpdate ? `<span class="upd">Updated ${hm(x.lastUpdate)}</span>`
        : r.here ? `<span class="recent">● ${r.here} here now</span>`
        : r.lastAt ? `<span>Last message ${ago(r.lastAt)}${r.lastAuthor ? " from " + esc(r.lastAuthor) : ""}</span>`
        : `<span>${shortDate(x.publishedAt)}</span>`;
      const right = r.here ? `${r.here} here` : `${r.messages} ${r.messages === 1 ? "message" : "messages"}`;
      return `<button type="button" class="card glass${i === 0 ? " lead" : ""}" data-article="${esc(x.id)}">
        <span class="k">${esc(x.area || x.section || "Halifax")}</span>
        <span class="tt">${esc(x.headline)}</span>
        ${x.dek ? `<span class="dk">${esc(x.dek)}</span>` : ""}
        <span class="ft">${left}<span class="pill${r.messages || r.here ? "" : " zero"}">${right}</span></span></button>`;
    }).join("");
    $("#devCards").innerHTML = devCards || '<div class="msg">Nothing developing right now. New stories appear here as the newsroom publishes them.</div>';

    // ---- Articles: settled stories with threaded comments ----
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
  document.querySelectorAll(".sort").forEach(b => b.addEventListener("click", () => { S.sort = b.dataset.sort; renderHome(); }));

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

  const BACK = `<button type="button" class="back" data-go="home">← All stories</button>`;

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
        <div class="byline"><span class="ai">${isNotice ? "Rewritten by AI from an official notice, facts only" : "Written by AI from an official release"}</span><span>${fullDate(a.publishedAt)}</span>${a.lastUpdate ? `<span>Updated ${fullDate(a.lastUpdate)}, ${hm(a.lastUpdate)}</span>` : ""}${a.readMin ? `<span>${a.readMin} min read</span>` : ""}</div>
        ${showUpdate ? `<div class="updated-banner"><b>Latest update</b> · ${esc(ago(a.lastUpdate))}: ${esc(a.updateNote)}</div>` : ""}
        ${newer ? `<button type="button" class="banner" data-article="${esc(newer.id)}"><b>There's a newer update.</b> <span>${esc(newer.headline)} →</span></button>` : ""}
        ${a.facts.length ? `<dl class="facts">${a.facts.map(f => `<dt>${esc(f.k)}</dt><dd>${linkify(f.v)}</dd>`).join("")}</dl>` : ""}
        <div class="body">
          ${a.body.map(p => `<p>${linkify(p)}</p>`).join("")}
          ${a.means.length ? `<h2>${isNotice ? "What to do" : "What this means for you"}</h2><ul>${a.means.map(p => `<li>${linkify(p)}</li>`).join("")}</ul>` : ""}
        </div>
        <div class="source">Source: <a href="${esc(a.source)}" target="_blank" rel="noopener">original ${isNotice ? "notice" : "release"} on halifax.ca</a>. Dates, times and places are copied from it; if anything differs, the original is right.</div>
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
      v.innerHTML = `${BACK}<div class="msg" style="margin-top:20px">Loading…</div>`;
      try { a = await fetchStory(id); }
      catch (e) { if (S.article === id) v.innerHTML = `${BACK}<div class="msg" style="margin-top:20px">This story isn't available.</div>`; return; }
      if (S.article !== id) return;
    }

    if (a.kind === "skip") {
      v.innerHTML = `${BACK}
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
      v.innerHTML = `<div class="room"><div>${BACK}${articleHTML(a)}<p class="closed">Chat and comments are off for city notices. For emergencies, follow official channels and sign up for hfxALERT at <a href="https://halifax.ca/hfxalert" target="_blank" rel="noopener">halifax.ca/hfxalert</a>.</p></div></div>`;
      wireStageTools(); window.scrollTo({ top: 0 }); return;
    }

    // ---- Articles: no live chat; threaded comments below ----
    if (a.stage !== "developing") {
      leaveRoom();
      v.innerHTML = `<div class="room"><div id="articleCol">${BACK}${articleHTML(a)}</div></div>
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
      <div id="articleCol">${BACK}${articleHTML(a)}</div>
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
    col.innerHTML = BACK + articleHTML(a);
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
      } else if (d.t === "article") {
        refreshArticleInPlace(id);
      } else if (d.t === "closed") {
        storyClosed(id);
      }
    });
    ws.addEventListener("close", () => {
      if (room.ws !== ws || room.closing) return;
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
    if (t && t !== "Reconnecting…") setTimeout(() => { if (room.error === t) showChatError(""); }, 6000);
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
          ? `<button type="button" class="x${room.armed === m.id ? " armed" : ""}" data-del="${esc(m.id)}" aria-label="${mine ? "Delete" : "Remove"} message">${room.armed === m.id ? (mine ? "Delete?" : "Remove?") : "×"}</button>` : ""}</div>`).join("")}
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
    if (toBottom || near) box.scrollTop = box.scrollHeight;
    renderHere();
    const e = $("#chatErr"); if (e) { e.hidden = !room.error; e.textContent = room.error; }
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

  // ---------- Profile ----------
  let authMode = "login";
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

  async function renderProfile() {
    const v = $("#profile");
    const back = BACK;
    if (!S.me) {
      const p = S.providers;
      const creating = authMode === "signup";
      v.innerHTML = `<div class="profile">${back}
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
          ${creating ? '<small id="passHint">At least 8 characters. There\'s no email reset yet, so keep it somewhere safe.</small>' : ""}
          <div class="auth-err" id="authErr" role="alert" hidden></div>
          <button type="submit" class="btn primary" id="authGo">${creating ? "Create account" : "Sign in"}</button>
        </form>
        ${p.google || p.dev ? `<div class="signin">
          ${p.google ? `<a class="btn ghost" href="/auth/google?return=${encodeURIComponent("/#profile")}">Continue with Google</a>` : ""}
          ${p.dev ? `<form class="dev" id="devForm"><label class="sr" for="devName">Name</label><input id="devName" placeholder="Your name (local dev)" maxlength="40" required><button class="btn ghost" type="submit">Dev sign-in</button></form>` : ""}
        </div>` : ""}
      </div>`;
      v.querySelectorAll("[data-mode]").forEach(b => b.addEventListener("click", () => { authMode = b.dataset.mode; renderProfile(); $("#authUser").focus(); }));
      $("#authForm").addEventListener("submit", async e => {
        e.preventDefault();
        const err = $("#authErr"), go = $("#authGo");
        const username = $("#authUser").value.trim(), password = $("#authPass").value;
        const fail = t => { err.textContent = t; err.hidden = false; go.disabled = false; };
        if (!username || !password) return fail("Enter a username and password.");
        go.disabled = true; err.hidden = true;
        try {
          const r = await fetch(creating ? "/auth/signup" : "/auth/login", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) return fail(d.error || "That didn't work. Try again.");
          await loadMe();
          if (S.current === "profile") renderProfile();
        } catch (x) { fail("Can't reach TalkHalifax. Check your connection and try again."); }
      });
      const f = $("#devForm");
      if (f) f.addEventListener("submit", e => { e.preventDefault(); location.href = `/auth/dev?name=${encodeURIComponent($("#devName").value)}&return=${encodeURIComponent("/#profile")}`; });
      return;
    }
    v.innerHTML = `<div class="profile">${back}
      <div class="profile-card glass">
        <div class="pic">${S.me.avatarUrl ? `<img alt="" src="${esc(S.me.avatarUrl)}" referrerpolicy="no-referrer">` : avatar({ id: S.me.id, name: S.me.name }, "av").replace('class="av"', 'class="av" style="width:100%;height:100%;font-size:32px;background:' + hue(S.me.id) + '"')}</div>
        <div><h1 id="pName"></h1><p>Halifax${S.me.role === "moderator" ? '<span class="role">Moderator</span>' : ""}</p></div>
      </div>
      <div class="stats" id="pStats">
        <div class="stat glass"><b>–</b><span>messages sent</span></div>
        <div class="stat glass"><b>–</b><span>chats joined</span></div>
        <div class="stat glass"><b>–</b><span>in the last 24 hours</span></div>
      </div>
      ${S.me.role === "moderator" ? `<h2 class="p-h">Drafts waiting for review</h2><div id="pReview"><p class="msg" style="border:0">Loading…</p></div>` : ""}
      <h2 class="p-h">Your recent messages</h2>
      <ul class="activity" id="pActivity"><li class="msg" style="border:0">Loading…</li></ul>
      <h2 class="p-h">Settings</h2>
      <div class="setting"><span>Show the live chat when I open an article<small>On a phone it always starts tucked away at the bottom.</small></span>
        <button type="button" class="switch" id="chatPref" role="switch" aria-checked="${!chatHidden}" aria-label="Show the live chat when I open an article"></button></div>
      <button type="button" class="btn ghost signout" id="signOut">Sign out</button>
      <p class="p-note">TalkHalifax stores your username, a scrambled (hashed) copy of your password, and your messages.</p>
    </div>`;
    $("#pName").textContent = S.me.name || "You";
    $("#chatPref").addEventListener("click", e => { setChatHidden(!chatHidden); e.currentTarget.setAttribute("aria-checked", String(!chatHidden)); });
    $("#signOut").addEventListener("click", async () => { await fetch("/auth/logout", { method: "POST" }); location.href = "/"; });
    if (S.me.role === "moderator") loadReview();
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

  // ---------- Navigation: Home, a profile, or one article room ----------
  function show(v) {
    if (v.startsWith("article-")) { S.article = v.slice(8); v = "article"; }
    else if (v !== "profile") v = "home";
    if (v !== "article") { S.article = null; chatOpen = false; leaveRoom(); }
    S.current = v;
    renderBanners(); // Home only
    $("#home").hidden = v !== "home";
    $("#profile").hidden = v !== "profile";
    $("#article").hidden = v !== "article";
    document.body.classList.toggle("wide-view", v === "article");
    if (v === "profile") $("#meBtn").setAttribute("aria-current", "page"); else $("#meBtn").removeAttribute("aria-current");
    try { history.replaceState(null, "", "#" + (v === "article" ? "article-" + S.article : v)); } catch (e) {}
    if (v === "article") renderArticle(); else if (v === "profile") renderProfile(); else renderHome();
    applyChatState();
  }
  const goTo = v => { show(v); window.scrollTo({ top: 0 }); };
  document.addEventListener("click", e => {
    const a = e.target.closest("[data-article]");
    if (a) return goTo("article-" + a.dataset.article);
    const g = e.target.closest("[data-go]");
    if (g) goTo(g.dataset.go);
  });
  window.addEventListener("hashchange", () => { const h = location.hash.slice(1); if (h !== (S.current === "article" ? "article-" + S.article : S.current)) goTo(h); });

  // ---------- Pull to refresh ----------
  // Home-screen web apps on iOS have no browser reload, so pulling down from the top refreshes the current view.
  // In a normal browser tab the browser's own pull-to-refresh already does this, so it stays off there.
  async function refreshView() {
    if (S.current === "home") return Promise.all([loadStories(), loadWeather(), loadAlerts()]);
    if (S.current === "profile") return loadMe();
    const id = S.article, before = S.full[id];
    let a;
    try { a = await fetchStory(id); } catch (e) { return; }
    if (S.current !== "article" || S.article !== id) return;
    const col = $("#articleCol");
    // A story that changed kind or stage (e.g. moved to Articles) needs its whole page rebuilt
    if (!before || before.kind !== a.kind || before.stage !== a.stage || !col) return renderArticle();
    col.innerHTML = BACK + articleHTML(a);
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
      if (busy || e.touches.length !== 1 || window.scrollY > 0 || t.closest(".chat, input, textarea, [contenteditable]")) { startY = null; return; }
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
    if (S.current === "home") renderHome();
  }
  async function loadWeather() {
    try { S.weather = (await getJSON("/api/weather")).weather; if (S.current === "home") renderToday(); } catch (e) {}
  }
  async function loadAlerts() {
    try { S.alerts = (await getJSON("/api/alerts")).alerts || { items: [] }; } catch (e) {}
    if (S.current === "home") renderBanners();
  }
  async function loadMe() {
    try { const d = await getJSON("/api/me"); S.me = d.user; S.providers = d.providers; } catch (e) {}
    renderMeButton();
    if (S.current === "profile") renderProfile();
    if (S.current === "article") renderComposer();
  }

  show(location.hash.slice(1) || "home");
  Promise.all([loadMe(), loadStories(), loadWeather(), loadAlerts()]);
  // Home numbers ("2 here now", message counts) refresh while the page is visible
  setInterval(() => { if (!document.hidden && S.current === "home") loadStories(); }, 20000);
  setInterval(() => { if (!document.hidden) { loadWeather(); loadAlerts(); } }, 10 * 60000);
  setInterval(() => { if (S.current === "home" && !document.hidden) renderToday(); }, 60000);
})();
