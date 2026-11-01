/* Branded consent card for Google Analytics (Google's own tag, gtag.js). Served by the site as /consent.js.
   Nothing from Google loads before a yes, and a no never loads it. After a yes (now, or stored), gtag.js loads
   once per page load with Google's default page views, on any page but the personal ones (PERSONAL).
   Personal pages: gtag.js never runs on one. A move into one while it runs switches Google off and loads that
   page afresh; a move out of one loads the public page afresh, so gtag.js starts there with that page's own
   address and title. A referrer that is one of our personal pages is not passed on.
   Withdrawing: Google off at once, and every _ga cookie deleted.
   Non-blocking: small corner card, no overlay, no scroll lock, equal-weight Accept/Decline.
   Re-open: any link to #cookie-settings or [data-cookie-settings], or window.cookieSettings(). */
(function () {
  if (window.__hcc) return; window.__hcc = 1;
  var CFG = {"lang": "bg", "privacy": "/privacy", "delay": 2500, "badge": "<svg viewBox=\"0 0 24 24\" fill=\"none\"><circle cx=\"8\" cy=\"9\" r=\"1.8\" fill=\"#ff4a2b\"/><circle cx=\"16\" cy=\"9\" r=\"1.8\" fill=\"#ff4a2b\"/><path d=\"M5.5 13.2c1.4 3 3.8 4.6 6.5 4.6s5.1-1.6 6.5-4.6\" stroke=\"#ff4a2b\" stroke-width=\"2.4\" stroke-linecap=\"round\"/></svg>", "css": ":host{all:initial;position:fixed;right:88px;bottom:24px;z-index:2147483000;font-family:var(--font-sans,\"Golos Text\",ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif);-webkit-font-smoothing:antialiased}.hcc-card{box-sizing:border-box;display:flex;gap:14px;width:380px;max-width:calc(100vw - 32px);background:#fefdfb;color:#101418;border:1px solid #e3dfd4;border-radius:18px;padding:16px 16px 16px 16px;box-shadow:0 2px 6px #1014181a,0 12px 28px #10141829;opacity:0;transform:translateY(12px) scale(.98);transition:opacity .28s ease,transform .32s cubic-bezier(.2,.9,.25,1.15)}:host(.hcc-in) .hcc-card{opacity:1;transform:none}.hcc-badge{flex:0 0 40px;height:40px;border-radius:999px;background:#fff1ee;display:grid;place-items:center}.hcc-badge svg{width:24px;height:24px}.hcc-body{flex:1;min-width:0}.hcc-kicker{margin:2px 0 4px;font:700 14px/1.25 var(--font-display,\"Unbounded\",ui-sans-serif,system-ui,sans-serif);color:#101418}.hcc-text{margin:0 0 12px;font-size:13.5px;line-height:1.5;color:#313d49}.hcc-link{color:#0b7a40;font-weight:600;text-decoration:none}.hcc-link:hover{text-decoration:underline}.hcc-actions{display:flex;gap:8px}.hcc-btn{flex:1;appearance:none;cursor:pointer;font:600 13.5px/1 var(--font-sans,\"Golos Text\",system-ui,sans-serif);padding:11px 14px;border-radius:999px;border:1.5px solid transparent;transition:background .15s,border-color .15s,transform .1s}.hcc-btn:active{transform:scale(.97)}.hcc-yes{background:#ff4a2b;color:#fff}.hcc-yes:hover{background:#ec3b1d}.hcc-no{background:#fff;color:#101418;border-color:#e3dfd4}.hcc-no:hover{border-color:#8a8373}.hcc-btn:focus-visible,.hcc-link:focus-visible{outline:2px solid #0b7a40;outline-offset:2px}@media (max-width:640px){:host{left:10px;right:10px;bottom:calc(76px + env(safe-area-inset-bottom))}.hcc-card{width:auto;max-width:none}}@media (prefers-reduced-motion:reduce){.hcc-card{transition:none}}", "text": {"bg": {"label": "Съгласие за статистика", "kicker": "Помогни ни да подобрим картата", "body": "Може ли да виждаме кои места и функции се ползват (Google Analytics)? При „да“ браузърът ти пази случаен идентификатор, иначе Google не получава нищо.", "more": "Поверителност", "yes": "Да, разбира се", "no": "Не, благодаря"}, "en": {"label": "Analytics consent", "kicker": "Help us improve the map", "body": "May we see which places and features get used (Google Analytics)? A yes stores a random ID in your browser; otherwise Google gets nothing.", "more": "Privacy", "yes": "Yes, sure", "no": "No, thanks"}}};
  var KEY = 'hcc_v1';
  var GA = 'G-XRJS0YRT3Q';
  var OFF = 'ga-disable-' + GA;
  var GTAG = 'https://www.googletagmanager.com/gtag/js?id=' + GA;
  // 390 days, under 13 months; gtag rolls it forward on every page load.
  var COOKIE_SECONDS = 33696000;
  // Account pages, pages that show people (standings, rosters, passports) and pages with a token in the
  // address. /klub/ is the whole club module: the offices, the member's pages, the purchase flow, and the
  // public club pages, where a club's own Google tag may run. sesiya/ is the old name of igra/.
  var PERSONAL = /^(\/en)?\/(admin(\/|$)|otmetka\/|sedmitsata\/otpisvane\/|pasport(\/|$)|profil(\/|$)|trenirovki(\/|$)|klasirane(\/|$)|kampanii\/[^/]+|sesiya\/|igra\/|klub(\/|$)|klubove\/(otmetka|otpisvane|pokana)\/|s\/|dobre-doshli(\/|$)|dev\/)/;
  var w = window, d = document;

  function personal(path) { return PERSONAL.test(path); }
  function answer() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  var current = location.pathname, loaded = false, leaving = false;
  function gtag() { w.dataLayer.push(arguments); }
  // While Google is switched off (a no, or a move into a personal page), nothing leaves for Google: gtag.js
  // also sends events it queued before, when the page is left.
  function guard() {
    var host = /(^|\.)(google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net)$/;
    function blocked(target) {
      if (w[OFF] !== true) return false;
      try { return host.test(new URL(String((target && target.url) || target), location.href).hostname); } catch (e) { return false; }
    }
    var nav = navigator;
    if (nav.sendBeacon) {
      var beacon = nav.sendBeacon;
      nav.sendBeacon = function (url) { return blocked(url) ? true : beacon.apply(nav, arguments); };
    }
    if (w.fetch) {
      var get = w.fetch;
      w.fetch = function (input) {
        return blocked(input) ? Promise.resolve(new Response(null, { status: 204 })) : get.apply(w, arguments);
      };
    }
  }
  function start() {
    if (loaded) { w[OFF] = false; return; }
    loaded = true;
    guard();
    // gtag reads document.referrer for the first page view: one of our personal pages is not passed on.
    try {
      var r = d.referrer ? new URL(d.referrer) : null;
      if (r && r.origin === location.origin && personal(r.pathname)) {
        Object.defineProperty(d, 'referrer', { configurable: true, get: function () { return ''; } });
      }
    } catch (e) {}
    w.dataLayer = w.dataLayer || [];
    w.gtag = gtag;
    gtag('js', new Date());
    gtag('config', GA, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_expires: COOKIE_SECONDS
    });
    var s = d.createElement('script');
    s.async = true;
    s.src = GTAG;
    d.head.appendChild(s);
  }
  // A fresh load of the address the router has just moved to. A reload sends the document's first referrer,
  // never the address being left.
  function fresh() {
    if (leaving) return;
    leaving = true;
    location.reload();
  }
  function moveTo(path) {
    if (path === current) return; // a change of query only (the map's own moves) is not a new page
    var from = current;
    current = path;
    if (answer() !== 'y') return;
    if (personal(path)) {
      if (loaded) { w[OFF] = true; fresh(); }
      return;
    }
    if (!loaded && personal(from)) return fresh();
    start();
  }
  function watch() {
    ['pushState', 'replaceState'].forEach(function (name) {
      var original = history[name];
      history[name] = function () {
        var result = original.apply(this, arguments);
        moveTo(location.pathname);
        return result;
      };
    });
    w.addEventListener('popstate', function () { moveTo(location.pathname); });
    // A page left by fresh() and brought back from the back-forward cache is loaded afresh too.
    w.addEventListener('pageshow', function (e) { if (e.persisted && leaving) location.reload(); });
    // A no given in another tab switches Google off here as well.
    w.addEventListener('storage', function (e) { if (e.key === KEY && e.newValue !== 'y' && loaded) forget(); });
  }
  // Withdrawing: Google off at once, then every _ga cookie, on this host and on each parent domain.
  function forget() {
    w[OFF] = true;
    var names = d.cookie.split(';').map(function (part) { return part.split('=')[0].trim(); })
      .filter(function (name) { return /^_ga(_|$)/.test(name); });
    var labels = location.hostname.split('.'), domains = [''];
    for (var i = 0; i < labels.length - 1; i++) domains.push('; domain=.' + labels.slice(i).join('.'));
    names.forEach(function (name) {
      domains.forEach(function (domain) { d.cookie = name + '=; Max-Age=0; path=/' + domain; });
    });
  }

  function lang() {
    var l = (d.documentElement.lang || CFG.lang).slice(0, 2).toLowerCase();
    return CFG.text[l] ? l : CFG.lang;
  }
  var root;
  function close() {
    if (!root) return;
    root.classList.remove('hcc-in');
    setTimeout(function () { root && root.remove(); root = null; }, 260);
  }
  function choose(yes) {
    try { localStorage.setItem(KEY, yes ? 'y' : 'n'); } catch (e) {}
    if (!yes) forget();
    else if (!personal(location.pathname)) start();
    close();
  }
  function show() {
    if (root) return;
    var l = lang();
    var t = CFG.text[l];
    root = d.createElement('div');
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
    d.body.appendChild(root);
    sh.querySelector('.hcc-yes').onclick = function () { choose(true); };
    sh.querySelector('.hcc-no').onclick = function () { choose(false); };
    setTimeout(function () { root && root.classList.add('hcc-in'); }, 40);
  }
  w.cookieSettings = function () { show(); };
  d.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href$="#cookie-settings"],[data-cookie-settings]');
    if (a) { e.preventDefault(); show(); }
  });
  function boot() {
    watch();
    if (answer() === 'y' && !personal(location.pathname)) start();
    if (location.hash === '#cookie-settings') return show();
    if (!answer()) setTimeout(show, CFG.delay || 900);
  }
  if (d.body) boot(); else d.addEventListener('DOMContentLoaded', boot);
})();
