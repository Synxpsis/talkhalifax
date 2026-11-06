// TalkHalifax: push alerts for urgent notices. Loaded by app.js for the Alerts section of the profile, and on a notice
// to offer alerts.
// Readers pick which kinds they want and quiet hours; the editor decides on Telegram which notices are sent.
(function () {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async r => { const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "HTTP " + r.status); return d; });
  const standalone = navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const hourLabel = m => { const h = Math.floor(m / 60); return h === 0 ? "midnight" : h === 12 ? "noon" : `${h % 12} ${h < 12 ? "a.m." : "p.m."}`; };

  let root, info = null, reg = null, noWorker = false, sub = null, saved = null, busy = false, note = "", err = "";

  /** The service worker that receives alerts, or null if this browser won't run one (within 5 seconds). */
  async function worker() {
    const r = await navigator.serviceWorker.getRegistration().catch(() => null) || await navigator.serviceWorker.register("/sw.js").catch(() => null);
    if (!r) return null;
    return Promise.race([navigator.serviceWorker.ready, new Promise(res => setTimeout(() => res(null), 5000))]);
  }

  /** Where things stand: alerts switched on for the site, this browser's subscription and its saved choices. */
  async function load() {
    info = info || await fetch("/api/push").then(r => r.json()).catch(() => ({ enabled: false, kinds: [] }));
    if (!supported || !info.enabled) return;
    reg = reg || await worker();
    if (!reg) { noWorker = true; return; }
    sub = await reg.pushManager.getSubscription();
    saved = sub ? await post("/api/push/status", { endpoint: sub.endpoint }).catch(() => null) : null;
    // A subscription the server forgot (alerts turned off elsewhere, or too many failures) starts over
    if (sub && saved && !saved.subscribed) saved = null;
  }

  /** Why this browser can't get alerts, or "" if it can. */
  function blocker() {
    if (!info) return "Loading…";
    if (!info.enabled) return "Alerts aren't switched on yet. Check back soon.";
    if (ios && !standalone) return "On iPhone and iPad, alerts work once TalkHalifax is on your Home Screen: tap Share, then Add to Home Screen, and open it from there.";
    if (!supported || noWorker) return "This browser can't get alerts. Try Chrome, Edge, Firefox or Safari.";
    if (Notification.permission === "denied") return "Notifications are blocked for this site in your browser settings. Allow them there, then come back.";
    return "";
  }

  function render() {
    if (!root) return;
    const why = blocker(), on = !!(sub && saved);
    const kinds = on ? saved.kinds : (info?.kinds || []).filter(k => k.default).map(k => k.id);
    const q = on ? saved.quiet : { start: 22 * 60, end: 7 * 60 }, quietOn = on ? !!saved.quiet : true;
    const hours = [...Array(24)].map((_, h) => h * 60);
    const sel = (id, v) => `<select id="${id}">${hours.map(m => `<option value="${m}"${m === v ? " selected" : ""}>${hourLabel(m)}</option>`).join("")}</select>`;
    const lede = "Get an alert on this device when there's an urgent notice: a weather warning, a big power outage, a road closure, a police or fire emergency. A person on our team decides which notices are urgent enough to send. Nothing else is sent. No account needed.";
    root.innerHTML = `<p class="al-lede">${lede}</p>
      ${why ? `<div class="msg">${esc(why)}</div>` : `
      <form class="al-form" id="alForm">
        <p class="al-state">${on ? "✓ Alerts are on for this device." : "Alerts are off for this device."}</p>
        <fieldset><legend>Send me alerts about</legend>
          ${info.kinds.map(k => `<label class="al-check"><input type="checkbox" name="kind" value="${esc(k.id)}"${kinds.includes(k.id) ? " checked" : ""}> ${esc(k.label)}</label>`).join("")}
        </fieldset>
        <fieldset><legend>Quiet hours</legend>
          <label class="al-check"><input type="checkbox" id="alQuiet"${quietOn ? " checked" : ""}> Don't send alerts overnight</label>
          <div class="al-hours"${quietOn ? "" : " hidden"}><label>From ${sel("alFrom", q ? q.start : 1320)}</label><label>to ${sel("alTo", q ? q.end : 420)}</label></div>
          <p class="al-hint">Halifax time. Alerts during quiet hours are skipped, not held for later.</p>
        </fieldset>
        ${err ? `<p class="al-err" role="alert">${esc(err)}</p>` : note ? `<p class="al-note" role="status">${esc(note)}</p>` : ""}
        <div class="al-actions">
          <button type="submit" class="btn primary"${busy ? " disabled" : ""}>${on ? "Save changes" : "Turn on alerts"}</button>
          ${on ? `<button type="button" class="btn ghost" id="alOff"${busy ? " disabled" : ""}>Turn off alerts</button>` : ""}
        </div>
      </form>`}
      <p class="al-hint al-foot">For emergencies, follow official channels and sign up for hfxALERT at <a href="https://halifax.ca/hfxalert" target="_blank" rel="noopener">halifax.ca/hfxalert</a>. To get alerts we keep this browser's alert address and your choices, and nothing that identifies you. Turning alerts off deletes them. <a href="#privacy" data-go="privacy">Privacy</a></p>`;
  }

  function choices() {
    const f = root.querySelector("#alForm");
    const kinds = [...f.querySelectorAll('input[name="kind"]:checked')].map(i => i.value);
    const quiet = f.querySelector("#alQuiet").checked ? { start: +f.querySelector("#alFrom").value, end: +f.querySelector("#alTo").value } : null;
    return { kinds, quiet };
  }
  const keyBytes = k => Uint8Array.from(atob(k.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((k.length + 3) % 4)), c => c.charCodeAt(0));

  async function save() {
    const { kinds, quiet } = choices();
    if (!kinds.length) { err = "Pick at least one kind of alert, or turn alerts off."; note = ""; render(); return; }
    busy = true; err = ""; note = ""; render();
    try {
      if (!sub) {
        if (await Notification.requestPermission() !== "granted") throw new Error("Notifications weren't allowed, so alerts are still off.");
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.publicKey) });
      }
      const d = await post("/api/push/subscribe", { subscription: sub.toJSON(), kinds, quiet });
      const was = !!saved; saved = { subscribed: true, kinds: d.kinds, quiet: d.quiet };
      note = was ? "Saved." : "Alerts are on. You'll get one when there's an urgent notice you picked.";
    } catch (e) { err = e.message || "That didn't work. Try again."; }
    busy = false; render();
  }

  async function turnOff() {
    busy = true; err = ""; note = ""; render();
    try {
      if (sub) { await post("/api/push/unsubscribe", { endpoint: sub.endpoint }); await sub.unsubscribe().catch(() => {}); }
      sub = null; saved = null; note = "Alerts are off, and this device's alert address is deleted.";
    } catch (e) { err = e.message || "That didn't work. Try again."; }
    busy = false; render();
  }

  function wire(el) {
    el.addEventListener("submit", e => { if (e.target.id === "alForm") { e.preventDefault(); if (!busy) save(); } });
    el.addEventListener("click", e => { if (e.target.id === "alOff" && !busy) turnOff(); });
    el.addEventListener("change", e => { if (e.target.id === "alQuiet") root.querySelector(".al-hours").hidden = !e.target.checked; });
  }

  window.THAlerts = {
    async open(el) {
      if (root !== el) { root = el; wire(el); }
      note = ""; err = "";
      render();
      await load().catch(() => {});
      render();
    },
    /** A short offer under a notice, only where alerts can work and aren't on yet. */
    async offer(el) {
      await load().catch(() => {});
      if (!el.isConnected || blocker() && !(ios && !standalone && info?.enabled) || (sub && saved)) return;
      el.innerHTML = `<div class="al-offer glass"><div><b>Get urgent notices like this one as alerts</b><span>${ios && !standalone ? "Add TalkHalifax to your Home Screen first, then turn alerts on." : "Only when a person on our team decides a notice is urgent. Pick which kinds."}</span></div>
        <button type="button" class="btn primary" data-go="alerts">Turn on alerts</button></div>`;
    },
  };

  const style = document.createElement("style");
  style.textContent = `
    .al-form { max-width: 560px; margin-top: 8px; }
    .al-lede { margin: 0 0 14px; max-width: 62ch; color: var(--ink-muted); font-size: 15px; line-height: 1.5; }
    .al-hint.al-foot { margin: 6px 0 0; max-width: 62ch; }
    #alertsH { scroll-margin-top: calc(env(safe-area-inset-top, 0px) + var(--hdr, 64px) + 16px); }
    .al-state { font-weight: 600; margin: 0 0 18px; }
    .al-form fieldset { border: 0; padding: 0; margin: 0 0 22px; }
    .al-form legend { font-size: 12px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: 8px; padding: 0; }
    .al-check { display: flex; align-items: center; gap: 12px; min-height: 44px; font-size: 16px; cursor: pointer; }
    .al-check input { width: 20px; height: 20px; accent-color: var(--ink); margin: 0; }
    .al-hours { display: flex; flex-wrap: wrap; gap: 12px; margin: 4px 0 6px 32px; }
    .al-hours[hidden] { display: none; }
    .al-hours label { display: flex; align-items: center; gap: 8px; font-size: 15px; }
    .al-hours select { font: inherit; color: var(--ink); background: var(--field); border: 1px solid var(--line); border-radius: var(--radius-s); padding: 8px 10px; min-height: 40px; }
    .al-hint { font-size: 13.5px; color: var(--muted); margin: 4px 0 0 32px; }
    .al-actions { display: flex; flex-wrap: wrap; gap: 12px; }
    .al-actions .btn[disabled] { opacity: .55; cursor: default; }
    .al-err { color: var(--warn); font-weight: 600; }
    .al-note { color: var(--ok); font-weight: 600; }
    .al-offer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 20px; margin-top: 18px; padding: 16px 18px; border-radius: var(--radius-l); }
    .al-offer b { display: block; font-size: 15.5px; }
    .al-offer span { display: block; font-size: 14px; color: var(--muted); margin-top: 2px; max-width: 46ch; }`;
  document.head.appendChild(style);
})();
