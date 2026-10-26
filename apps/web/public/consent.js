/* Branded consent card for Cloudflare Zaraz consent API. Served by the site as /consent.js;
   Zaraz itself loads only after a yes (see load()).
   Non-blocking: small corner card, no overlay, no scroll lock, equal-weight Accept/Decline.
   Re-open: any link to #cookie-settings or [data-cookie-settings], or window.cookieSettings(). */
(function () {
  if (window.__hcc) return; window.__hcc = 1;
  var CFG = {"lang": "bg", "cookie": "cf_consent", "privacy": "/privacy", "delay": 2500, "badge": "<svg viewBox=\"0 0 24 24\" fill=\"none\"><circle cx=\"8\" cy=\"9\" r=\"1.8\" fill=\"#ff4a2b\"/><circle cx=\"16\" cy=\"9\" r=\"1.8\" fill=\"#ff4a2b\"/><path d=\"M5.5 13.2c1.4 3 3.8 4.6 6.5 4.6s5.1-1.6 6.5-4.6\" stroke=\"#ff4a2b\" stroke-width=\"2.4\" stroke-linecap=\"round\"/></svg>", "css": ":host{all:initial;position:fixed;right:88px;bottom:24px;z-index:2147483000;font-family:var(--font-sans,\"Golos Text\",ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif);-webkit-font-smoothing:antialiased}.hcc-card{box-sizing:border-box;display:flex;gap:14px;width:380px;max-width:calc(100vw - 32px);background:#fefdfb;color:#101418;border:1px solid #e3dfd4;border-radius:18px;padding:16px 16px 16px 16px;box-shadow:0 2px 6px #1014181a,0 12px 28px #10141829;opacity:0;transform:translateY(12px) scale(.98);transition:opacity .28s ease,transform .32s cubic-bezier(.2,.9,.25,1.15)}:host(.hcc-in) .hcc-card{opacity:1;transform:none}.hcc-badge{flex:0 0 40px;height:40px;border-radius:999px;background:#fff1ee;display:grid;place-items:center}.hcc-badge svg{width:24px;height:24px}.hcc-body{flex:1;min-width:0}.hcc-kicker{margin:2px 0 4px;font:700 14px/1.25 var(--font-display,\"Unbounded\",ui-sans-serif,system-ui,sans-serif);color:#101418}.hcc-text{margin:0 0 12px;font-size:13.5px;line-height:1.5;color:#313d49}.hcc-link{color:#0b7a40;font-weight:600;text-decoration:none}.hcc-link:hover{text-decoration:underline}.hcc-actions{display:flex;gap:8px}.hcc-btn{flex:1;appearance:none;cursor:pointer;font:600 13.5px/1 var(--font-sans,\"Golos Text\",system-ui,sans-serif);padding:11px 14px;border-radius:999px;border:1.5px solid transparent;transition:background .15s,border-color .15s,transform .1s}.hcc-btn:active{transform:scale(.97)}.hcc-yes{background:#ff4a2b;color:#fff}.hcc-yes:hover{background:#ec3b1d}.hcc-no{background:#fff;color:#101418;border-color:#e3dfd4}.hcc-no:hover{border-color:#8a8373}.hcc-btn:focus-visible,.hcc-link:focus-visible{outline:2px solid #0b7a40;outline-offset:2px}@media (max-width:640px){:host{left:10px;right:10px;bottom:calc(76px + env(safe-area-inset-bottom))}.hcc-card{width:auto;max-width:none}}@media (prefers-reduced-motion:reduce){.hcc-card{transition:none}}", "text": {"bg": {"label": "Съгласие за статистика", "kicker": "Помогни ни да подобрим картата", "body": "Може ли да виждаме кои места и функции се ползват (Google Analytics)? При „да“ браузърът ти пази случаен идентификатор, иначе Google не получава нищо.", "more": "Поверителност", "yes": "Да, разбира се", "no": "Не, благодаря"}, "en": {"label": "Analytics consent", "kicker": "Help us improve the map", "body": "May we see which places and features get used (Google Analytics)? A yes stores a random ID in your browser; otherwise Google gets nothing.", "more": "Privacy", "yes": "Yes, sure", "no": "No, thanks"}}};
  var KEY = 'hcc_v1';
  function lang() {
    var l = (document.documentElement.lang || CFG.lang).slice(0, 2).toLowerCase();
    return CFG.text[l] ? l : CFG.lang;
  }
  function decided() {
    try { if (localStorage.getItem(KEY)) return true; } catch (e) {}
    return document.cookie.indexOf(CFG.cookie + '=') > -1;
  }
  function ready(cb) {
    if (window.zaraz && zaraz.consent && zaraz.consent.APIReady) return cb();
    document.addEventListener('zarazConsentAPIReady', cb, { once: true });
  }
  var root;
  function close() {
    if (!root) return;
    root.classList.remove('hcc-in');
    setTimeout(function () { root && root.remove(); root = null; }, 260);
  }
  function zarazThere() {
    return !!(window.zaraz || document.querySelector('script[src*="/cdn-cgi/zaraz/"]'));
  }
  var loading;
  function load() {
    if (loading || zarazThere()) return;
    loading = 1;
    var s = document.createElement('script');
    s.src = '/cdn-cgi/zaraz/i.js';
    s.async = true;
    document.head.appendChild(s);
  }
  function grant() {
    ready(function () {
      zaraz.consent.set({ analytics: true });
      if (zaraz.consent.sendQueuedEvents) zaraz.consent.sendQueuedEvents();
    });
    load();
  }
  function choose(yes) {
    if (yes) grant();
    else if (zarazThere()) ready(function () { zaraz.consent.set({ analytics: false }); });
    try { localStorage.setItem(KEY, yes ? 'y' : 'n'); } catch (e) {}
    close();
  }
  function show() {
    if (root) return;
    var l = lang();
    var t = CFG.text[l];
    root = document.createElement('div');
    root.className = 'hcc';
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', t.label);
    root.style.cssText = 'position:fixed;z-index:2147483000;';
    var sh = root.attachShadow ? root.attachShadow({ mode: 'open' }) : root;
    sh.innerHTML =
      '<style>' + CFG.css + '</style>' +
      '<div class="hcc-card">' +
      (CFG.badge ? '<div class="hcc-badge" aria-hidden="true">' + CFG.badge + '</div>' : '') +
      '<div class="hcc-body">' +
      '<p class="hcc-kicker">' + t.kicker + '</p>' +
      '<p class="hcc-text">' + t.body + ' <a class="hcc-link" href="' + (l === 'en' ? '/en' : '') + CFG.privacy + '">' + t.more + '</a></p>' +
      '<div class="hcc-actions">' +
      '<button type="button" class="hcc-btn hcc-yes">' + t.yes + '</button>' +
      '<button type="button" class="hcc-btn hcc-no">' + t.no + '</button>' +
      '</div></div></div>';
    document.body.appendChild(root);
    sh.querySelector('.hcc-yes').onclick = function () { choose(true); };
    sh.querySelector('.hcc-no').onclick = function () { choose(false); };
    setTimeout(function () { root && root.classList.add('hcc-in'); }, 40);
  }
  window.cookieSettings = function () { show(); };
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href$="#cookie-settings"],[data-cookie-settings]');
    if (a) { e.preventDefault(); show(); }
  });
  function boot() {
    try { if (localStorage.getItem(KEY) === 'y') grant(); } catch (e) {}
    if (location.hash === '#cookie-settings') return show();
    if (!decided()) setTimeout(show, CFG.delay || 900);
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
