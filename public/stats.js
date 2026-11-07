// Anonymous counts for the editor: how many people have the site open, and how often each story is shown and opened.
// No cookie and nothing saved in the browser. The id below is made fresh when the page loads and is gone when it closes.
(() => {
  const EVERY_MS = 120_000, MAX_SHOWN = 60, MAX_OPENED = 10;
  const sid = [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, "0")).join("");
  const shown = new Set(), opened = new Set(), counted = new Set();
  const LISTED = "[data-article]:not(.back):not(.by-link)";

  function send() {
    if (document.visibilityState !== "visible" && !shown.size && !opened.size) return;
    if (navigator.onLine === false) return;
    const body = JSON.stringify({ sid, shown: [...shown].slice(0, MAX_SHOWN), opened: [...opened].slice(0, MAX_OPENED) });
    [...shown].slice(0, MAX_SHOWN).forEach(id => shown.delete(id));
    [...opened].slice(0, MAX_OPENED).forEach(id => opened.delete(id));
    try {
      if (navigator.sendBeacon(`${location.origin}/api/stats`, new Blob([body], { type: "application/json" }))) return;
    } catch (e) { /* counts aren't worth an error */ }
    fetch("/api/stats", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  }

  // A story counts as shown once per page load, when at least half its card is on screen
  const watch = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = e.target.dataset.article;
      if (id && !counted.has(id)) { counted.add(id); shown.add(id); }
      watch.unobserve(e.target);
    }
  }, { threshold: 0.5 }) : null;

  let pending = 0;
  const scan = () => {
    pending = 0;
    document.querySelectorAll(LISTED).forEach(el => { if (!counted.has(el.dataset.article)) watch.observe(el); });
  };
  if (watch) {
    new MutationObserver(() => { pending = pending || setTimeout(scan, 500); }).observe(document.body, { childList: true, subtree: true });
    scan();
  }

  document.addEventListener("click", e => {
    const el = e.target.closest && e.target.closest(LISTED);
    if (el && el.dataset.article) opened.add(el.dataset.article);
  }, true);

  document.addEventListener("visibilitychange", send);
  setInterval(() => { if (document.visibilityState === "visible") send(); }, EVERY_MS);
  setTimeout(send, 2000);
})();
