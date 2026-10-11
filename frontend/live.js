/* ============================================================================
   Axo Business Hub — LIVE API MODE
   ----------------------------------------------------------------------------
   index.html is a demo with built-in sample data. This file connects it to the
   real backend (backend/, see docs/POS-API.md) when a merchant signs in with
   an email and password:

     sign in → /auth/login            balance    → /merchants/me
     accept  → /payment-requests      QR         → /payment-requests/:id/qr.svg
     wait    → poll the request       new money  → poll /transactions?since=
     refunds → /transactions/:id/refund   report → /reports/settlement
     Till / Paybill → /paynumbers     integrations → /api-keys, /webhook-endpoints

   Only screens backed by the API are shown in live mode. Every demo-only tool
   says so instead of showing sample numbers as if they were real. Nothing here
   decides that money moved — the UI only ever shows what the server reports.
   ========================================================================== */
(function () {
  'use strict';

  // Opened from this machine (or a file) ⇒ the local dev API; opened from the
  // hosted site ⇒ the hosted API. ?api=… still overrides either.
  var LOCAL_API = 'http://localhost:4000';
  var HOSTED_API = 'https://axo-business.onrender.com';
  var DEFAULT_API = (location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) ? LOCAL_API : HOSTED_API;
  var STORE = 'axo.hub.session';
  var API_KEY_STORE = 'axo.hub.apiBase';

  var L = (window.AXO_LIVE = {
    on: false, base: DEFAULT_API, token: null, refreshToken: null, role: 'owner',
    env: null, merchant: null, currency: 'KES', since: null, pollTimer: null, seq: 0,
  });

  /* ---------------------------------------------------------------- storage */
  // Browser storage can be unavailable (private windows, blocked site data);
  // live mode must still work, it just won't survive a reload then.
  function store(key, value) {
    try { if (value == null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  function load(key) {
    try { var v = sessionStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  // ?api=… in the page URL picks the server (and is remembered), e.g. for a
  // staging API or a test run; otherwise the last one used, or localhost.
  function savedApiBase() {
    try {
      var q = new URLSearchParams(location.search).get('api');
      if (q) { localStorage.setItem(API_KEY_STORE, q.replace(/\/+$/, '')); return q.replace(/\/+$/, ''); }
      return localStorage.getItem(API_KEY_STORE) || DEFAULT_API;
    } catch (e) { return DEFAULT_API; }
  }
  function rememberApiBase(b) { try { localStorage.setItem(API_KEY_STORE, b); } catch (e) {} }

  /* ------------------------------------------------------------------ money */
  // The same rule as the backend (chat.lib currencyDecimals): KES and the other
  // East African shillings are whole units; everything else, USD included
  // (Somalia), has cents. Amounts travel as integer strings of minor units.
  var ZERO_DECIMAL = { KES: 1, UGX: 1, TZS: 1, RWF: 1, SOS: 1 };
  function decimals(c) { return ZERO_DECIMAL[String(c || '').toUpperCase()] ? 0 : 2; }

  function fmtMinor(minor, currency) {
    var c = currency || L.currency;
    var d = decimals(c);
    var n;
    try { n = BigInt(minor == null ? 0 : minor); } catch (e) { return c + ' —'; }
    var neg = n < 0n; if (neg) n = -n;
    var s = n.toString().padStart(d + 1, '0');
    var whole = s.slice(0, s.length - d) || '0';
    var frac = d ? '.' + s.slice(s.length - d) : '';
    return (neg ? '−' : '') + c + ' ' + whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + frac;
  }

  /** "1,250.50" → "125050" for USD; refuses more precision than the currency has. */
  function parseAmount(text, currency) {
    var d = decimals(currency || L.currency);
    var s = String(text || '').replace(/,/g, '').trim();
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    var parts = s.split('.');
    var frac = parts[1] || '';
    if (frac.replace(/0+$/, '').length > d) return null;
    var minor = BigInt((parts[0] || '0') + (d ? (frac + '00').slice(0, d) : ''));
    return minor > 0n ? minor.toString() : null;
  }

  /* --------------------------------------------------------------- helpers */
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return x.toString(16).padStart(2, '0'); }).join('');
  }
  function ago(iso) {
    if (!iso) return '';
    var s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' hr ago';
    return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function today() {
    var d = new Date();
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  function can() {
    for (var i = 0; i < arguments.length; i++) if (arguments[i] === L.role) return true;
    return false;
  }

  var MESSAGES = {
    invalid_credentials: 'Wrong email or password.',
    network: 'Can’t reach the Axo API. Is the backend running?',
    forbidden: 'Your role can’t do that — ask the owner.',
    unauthorized: 'Your session ended — sign in again.',
    bad_amount: 'Enter a valid amount.',
    sale_ref_conflict: 'That sale reference is already used for a different amount.',
    unknown_customer: 'No Axo customer with that tag.',
    currency_not_accepted: 'Your business doesn’t accept that currency.',
    refund_exceeds_remaining: 'That’s more than is left to refund on this payment.',
    already_fully_refunded: 'This payment has already been fully refunded.',
    insufficient_balance: 'Not enough balance to refund that.',
    refund_not_supported_for_this_rail: 'This payment came in over an external rail; it can’t be refunded from here yet.',
    number_taken: 'That number is taken.',
    duplicate_account_line: 'That account line already exists.',
    https_required: 'Webhook URLs must use https.',
    requires_staff_login: 'Sign in as a person to do that.',
  };
  function errText(e) { return MESSAGES[e && e.code] || (e && e.code ? 'Error: ' + e.code.replace(/_/g, ' ') : 'Something went wrong.'); }

  /* -------------------------------------------------------------- API client */
  function ApiError(code, status) { this.code = code; this.status = status; }

  async function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (L.token) headers.authorization = 'Bearer ' + L.token;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    var res;
    try {
      res = await fetch(L.base + path, { method: opts.method || 'GET', headers: headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    } catch (e) {
      throw new ApiError('network', 0);
    }
    if (res.status === 401 && L.refreshToken && !opts.retried && path.indexOf('/auth/') !== 0) {
      if (await refresh()) return api(path, Object.assign({}, opts, { retried: true }));
      endSession('Your session ended — sign in again.');
      throw new ApiError('unauthorized', 401);
    }
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
    if (!res.ok) throw new ApiError((data && data.error) || 'http_' + res.status, res.status);
    return opts.raw ? text : data;
  }

  async function refresh() {
    try {
      var res = await fetch(L.base + '/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: L.refreshToken }) });
      if (!res.ok) return false;
      L.token = (await res.json()).accessToken;
      persist();
      return true;
    } catch (e) { return false; }
  }

  function persist() {
    store(STORE, L.on ? { base: L.base, token: L.token, refreshToken: L.refreshToken, role: L.role } : null);
  }

  /* -------------------------------------------------------------- sign in/out */
  var demoSignIn = window.doSignIn;
  var demoSignOut = window.signOut;
  var demoRender = window.render;
  var demoOpenSheet = window.openSheet;
  var demoRoleMenu = window.openRoleMenu;

  window.doSignIn = async function () {
    var email = ($('#siEmail') && $('#siEmail').value || '').trim();
    var password = ($('#siPass') && $('#siPass').value) || '';
    var base = (($('#siApi') && $('#siApi').value) || savedApiBase()).trim().replace(/\/+$/, '');
    var msg = $('#siMsg');
    if (!email || !password) { if (msg) msg.textContent = 'Enter your email and password — or explore the demo below.'; return; }
    if (msg) msg.textContent = 'Signing in…';
    L.base = base;
    try {
      var r = await api('/auth/login', { method: 'POST', body: { email: email, password: password } });
      L.token = r.accessToken; L.refreshToken = r.refreshToken; L.role = r.role;
      rememberApiBase(base);
      await startSession();
      if (msg) msg.textContent = '';
      $('#siPass').value = '';
      toast('Signed in to ' + L.merchant.tradingName);
    } catch (e) {
      L.token = null;
      if (msg) msg.textContent = errText(e);
    }
  };

  /** Explore the built-in sample data instead (the original demo sign-in). */
  window.liveExploreDemo = function () { endSession(); demoSignIn(); };

  async function startSession() {
    var me = await api('/merchants/me');
    var health = await api('/health').catch(function () { return { env: 'unknown' }; });
    L.merchant = me; L.currency = me.currency; L.env = health.env; L.on = true;
    var initials = me.tradingName.split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
    // A minimal business record so the shared top bar and helpers work.
    BUSINESSES.live = {
      logo: initials, name: esc(me.tradingName), type: me.axoId + ' · ' + me.country, tier: 'small',
      country: me.country, currency: me.currency, balance: 0, feed: [], kpis: [], week: [0, 0, 0, 0, 0, 0, 0],
      units: null, settleTo: 'Axo balance', bankTier: 2, bankName: 'Axo account', usdc: 0, usdt: 0, walletAddr: '—', live: true,
    };
    CUR = 'live'; ROLE = L.role; TAB = 'home';
    persist();
    $('#signWrap').classList.remove('on');
    $('#land').classList.add('hide');
    $('#onb').classList.add('hide');
    chrome();
    render();
    await baselineFeed();
    startPolling();
  }

  function endSession(message) {
    stopPolling();
    var wasOn = L.on;
    L.on = false; L.token = null; L.refreshToken = null; L.merchant = null;
    persist();
    delete BUSINESSES.live;
    chrome();
    if (wasOn) { demoSignOut(); if (message) { openSignIn(); var m = $('#siMsg'); if (m) m.textContent = message; } }
  }
  window.signOut = function () { if (L.on) { endSession(); toast('Signed out'); } else demoSignOut(); };

  /** Banner, sidebar footer and top-bar demo switch reflect which mode is on. */
  function chrome() {
    var banner = document.querySelector('.demo-banner');
    if (banner) {
      if (!L.on) {
        banner.hidden = false; banner.style.background = '';
        banner.textContent = 'DEMO DATA — this dashboard is not connected to the Axo API. Balances, payments and "Simulate" actions are not real money.';
      } else if (L.env === 'live') {
        banner.hidden = true;
      } else {
        banner.hidden = false; banner.style.background = '#1d4ed8';
        banner.textContent = 'SANDBOX — connected to ' + L.base + '. Test money only.';
      }
    }
    var envEl = document.querySelector('.sb-env');
    if (envEl) envEl.textContent = L.on ? (L.env === 'live' ? '● Live API' : '● Sandbox API') : '● Demo data';
    var sw = document.querySelector('.demo-switch'); if (sw) sw.style.display = L.on ? 'none' : '';
    var sd = document.querySelector('.sb-demo'); if (sd) sd.style.display = L.on ? 'none' : '';
  }

  window.openRoleMenu = function () {
    if (!L.on) return demoRoleMenu();
    var r = ROLES[L.role] || ROLES.owner;
    $('#sheet').innerHTML = '<div class="sheet-grip"></div><h3>' + esc(L.merchant.tradingName) + '</h3>' +
      '<div class="sub">Signed in as <b>' + r.ic + ' ' + r.label + '</b> — your role is set by the business owner.</div>' +
      '<div class="recpt" style="margin-top:12px">' +
      row('Axo ID', esc(L.merchant.axoId)) + row('Currency', esc(L.currency)) +
      row('API', esc(L.base)) + row('Environment', L.env === 'live' ? 'Live' : 'Sandbox (test money)') + '</div>' +
      '<button class="big-btn ghost" style="margin-top:12px;color:var(--rose)" onclick="signOut();closeSheet()">Sign out</button>';
    $('#sheetBg').classList.add('on');
  };

  /* ------------------------------------------------------------- rendering */
  var LIVE_TABS = {
    home: { ic: '⌂', label: 'Home', screen: screenHome },
    payments: { ic: '≣', label: 'Payment requests', screen: screenRequests },
    transactions: { ic: '🧾', label: 'Transactions', screen: screenTransactions },
    settlements: { ic: '📊', label: 'Settlements', screen: screenSettlements, roles: ['owner', 'manager', 'accountant'] },
    payids: { ic: '🔢', label: 'Till & Paybill', screen: screenPayIds },
    api: { ic: '🔌', label: 'Integrations', screen: screenIntegrations, roles: ['owner'] },
    tools: { ic: '⚙︎', label: 'Tools', screen: screenTools },
  };
  function allowed(tab) { var t = LIVE_TABS[tab]; return !!t && (!t.roles || t.roles.indexOf(L.role) >= 0); }

  window.render = function () {
    if (!L.on) return demoRender();
    L.seq++;
    renderTop();
    liveNav();
    liveSidebar();
    var s = $('#scroll');
    var t = LIVE_TABS[TAB];
    var html;
    if (!t) html = notConnected();
    else if (!allowed(TAB)) html = '<div class="empty" style="padding:48px 0"><div class="e-i">🔒</div><div style="font-weight:700;margin-bottom:4px">Not available for your role</div><div style="font-size:12.5px;color:var(--dim)">Ask the business owner for access.</div></div>';
    else {
      try { html = t.screen(); } catch (e) { console.warn('[Axo live]', e); html = '<div class="empty" style="padding:40px 0"><div class="e-i">⚠️</div>Couldn’t load this screen.</div>'; }
    }
    s.innerHTML = html;
    s.scrollTop = 0;
  };

  function liveNav() {
    var items = [['home', '⌂', 'Home'], ['accept', '＋', 'Accept'], ['payments', '≣', 'Requests'], ['tools', '⚙︎', 'Tools']];
    $('#nav').innerHTML = items.map(function (i) {
      var on = i[0] === TAB || (i[0] === 'tools' && ['transactions', 'settlements', 'payids', 'api'].indexOf(TAB) >= 0);
      return '<div class="nav-item ' + (on ? 'on' : '') + '" data-k="' + i[0] + '"><span class="n-i">' + i[1] + '</span>' + i[2] + '</div>';
    }).join('');
    $('#nav').querySelectorAll('.nav-item').forEach(function (el) {
      el.onclick = function () { var k = el.dataset.k; if (k === 'accept') { openSheet('accept'); return; } TAB = k; render(); };
    });
  }

  function liveSidebar() {
    var sb = $('#sbNav'); if (!sb) return;
    var sbb = $('#sbBiz'); if (sbb) sbb.textContent = L.merchant.tradingName;
    var keys = ['home', 'payments', 'transactions', 'settlements', 'payids', 'api'].filter(allowed);
    sb.innerHTML = '<div class="sb-sec-lbl">Connected to Axo</div>' + keys.map(function (k) {
      return '<div class="sb-item ' + (k === TAB ? 'on' : '') + '" data-k="' + k + '"><span class="si-ic">' + LIVE_TABS[k].ic + '</span>' + LIVE_TABS[k].label + '</div>';
    }).join('');
    sb.querySelectorAll('.sb-item').forEach(function (el) { el.onclick = function () { TAB = el.dataset.k; render(); }; });
  }

  /**
   * Async sections: a screen renders a placeholder, then fills it once the API
   * answers — unless the user has moved on (the render sequence changed).
   */
  function section(id, loader) {
    var seq = L.seq;
    setTimeout(function () {
      loader().then(function (html) {
        var el = document.getElementById(id);
        if (el && seq === L.seq) el.innerHTML = html;
      }, function (e) {
        var el = document.getElementById(id);
        if (el && seq === L.seq) el.innerHTML = '<div class="note-line">⚠️ ' + esc(errText(e)) + '</div>';
      });
    }, 0);
    return '<div id="' + id + '"><div class="spin" style="width:26px;height:26px"></div></div>';
  }

  function row(k, v) { return '<div class="rr"><span>' + k + '</span><span>' + v + '</span></div>'; }
  function back(title, sub) {
    return '<div class="sec-h" style="margin-top:8px"><a onclick="TAB=\'tools\';render()" style="color:var(--dim)">‹ Tools</a></div>' +
      '<div style="font-size:20px;font-weight:800;margin:2px 0 2px">' + title + '</div>' + (sub ? '<div class="sec-sub">' + sub + '</div>' : '');
  }

  function notConnected() {
    return '<div class="empty" style="padding:44px 12px"><div class="e-i">🧪</div>' +
      '<div style="font-weight:700;margin-bottom:6px">Not connected to the API yet</div>' +
      '<div style="font-size:12.5px;color:var(--dim);max-width:340px;margin:0 auto 14px">This tool only exists in the demo so far, so it isn’t shown with your real account. Sign out and choose “Explore the demo” to try it with sample data.</div>' +
      '<button class="big-btn" style="max-width:220px" onclick="TAB=\'home\';render()">Back to home</button></div>';
  }

  /* ------------------------------------------------------------------ HOME */
  function screenHome() {
    return '<div class="hero"><div class="hero-lbl"><span class="live"></span>AVAILABLE BALANCE</div>' +
      section('lvBal', loadBalance) +
      '<div class="hero-sub">Axo balance · customer payments settle here instantly</div>' +
      '<div class="hero-actions"><button class="hero-btn primary" onclick="openSheet(\'accept\')">＋ Request payment</button>' +
      '<button class="hero-btn ghost" onclick="TAB=\'payments\';render()">≣ Requests</button></div></div>' +
      (can('owner', 'manager', 'accountant') ? '<div class="sec-h">Today <a onclick="TAB=\'settlements\';render()">Report</a></div>' + section('lvToday', loadToday) : '') +
      '<div class="sec-h">Recent payments <a onclick="TAB=\'transactions\';render()">See all</a></div>' +
      section('lvFeed', function () { return loadFeed(6); });
  }

  async function loadBalance() {
    var me = await api('/merchants/me');
    var acct = (me.accounts || []).find(function (a) { return a.type === 'axo_balance' && a.currency === L.currency; });
    return '<div class="hero-amt" style="font-size:34px;font-weight:800;margin:6px 0">' + fmtMinor(acct ? acct.balanceMinor : 0) + '</div>';
  }

  async function loadToday() {
    var r = await api('/reports/settlement?date=' + today());
    var c = r.collections;
    var ok = r.reconciliation.status === 'balanced';
    return '<div class="kpis">' +
      kpi('💰', fmtMinor(c.grossMinor, r.currency), 'Collected') +
      kpi('🧾', String(c.count), 'Payments') +
      kpi('↩️', fmtMinor(c.refundsMinor, r.currency), 'Refunds') +
      kpi(ok ? '✅' : '⚠️', ok ? 'Balanced' : r.reconciliation.exceptions.length + ' issues', 'Reconciliation') +
      '</div>';
  }
  function kpi(ic, v, l) {
    return '<div class="kpi"><div class="k-ico" style="background:rgba(37,181,115,.12)">' + ic + '</div><div class="k-v">' + v + '</div><div class="k-l">' + l + '</div></div>';
  }

  var TXN_META = {
    payment_in: ['📥', 'Payment received', 'in'], refund: ['↩️', 'Refund', 'out'], payout: ['🏦', 'Payout', 'out'],
    reversal: ['↩️', 'Reversal', 'out'], bill: ['🧾', 'Bill', 'out'],
  };
  var TX_CACHE = {};

  function txRow(t) {
    TX_CACHE[t.id] = t;
    var m = TXN_META[t.type] || ['•', t.type, 'in'];
    var incoming = m[2] === 'in';
    var st = { confirmed: ['st-done', 'Completed'], pending: ['st-pend', 'Pending'], awaiting_approval: ['st-pend', 'Awaiting approval'], failed: ['st-fail', 'Failed'], reversed: ['st-fail', 'Reversed'] }[t.status] || ['st-pend', t.status];
    // Only a confirmed payment has actually arrived; say so for the others.
    var title = t.type === 'payment_in' ? ({ pending: 'Payment pending', failed: 'Payment failed' }[t.status] || m[1]) : m[1];
    var refunded = t.type === 'payment_in' && t.refundedMinor && t.refundedMinor !== '0' ? ' · refunded ' + fmtMinor(t.refundedMinor, t.currency) : '';
    return '<div class="txn" style="cursor:pointer" onclick="liveTxDetail(\'' + esc(t.id) + '\')">' +
      '<div class="tx-ic" style="background:' + (incoming ? 'rgba(37,181,115,.12)' : 'rgba(224,107,92,.1)') + '">' + m[0] + '</div>' +
      '<div class="tx-m"><div class="tx-t">' + title + (t.customerRef ? ' · ' + esc(t.customerRef) : '') + '</div><div class="tx-s">' + ago(t.createdAt) + refunded + '</div></div>' +
      '<div class="tx-r"><div class="tx-a" style="color:' + (incoming ? 'var(--axo)' : 'var(--rose)') + '">' + (incoming ? '+' : '−') + fmtMinor(t.amountMinor, t.currency) + '</div>' +
      '<span class="tx-st ' + st[0] + '">' + esc(st[1]) + '</span></div></div>';
  }

  async function loadFeed(limit, query) {
    var rows = await api('/transactions' + (query || ''));
    if (!rows.length) return '<div class="empty" style="padding:26px 0"><div class="e-i">🌱</div>No payments yet. Tap <b>Request payment</b> to take your first one.</div>';
    return rows.slice(0, limit || rows.length).map(txRow).join('');
  }

  /* --------------------------------------------- new-payment notifications */
  async function baselineFeed() {
    try {
      var rows = await api('/transactions');
      L.since = rows.length ? rows[0].createdAt : new Date(0).toISOString();
    } catch (e) { L.since = new Date(0).toISOString(); }
  }

  function startPolling() {
    stopPolling();
    L.pollTimer = setInterval(pollNew, 5000);
  }
  function stopPolling() { if (L.pollTimer) clearInterval(L.pollTimer); L.pollTimer = null; }

  async function pollNew() {
    if (!L.on || !L.since) return;
    try {
      var rows = await api('/transactions?since=' + encodeURIComponent(L.since));
      if (!rows.length) return;
      L.since = rows[0].createdAt;
      rows.slice().reverse().forEach(function (t) {
        if (t.type === 'payment_in' && t.status === 'confirmed') {
          var line = fmtMinor(t.amountMinor, t.currency) + (t.customerRef ? ' from ' + t.customerRef : '');
          toast('💰 Received ' + line);
          if (typeof pushNotif === 'function') pushNotif('💰', 'Payment received', line);
        }
      });
      if (TAB === 'home' || TAB === 'transactions' || TAB === 'payments') render();
    } catch (e) { /* transient; the next tick retries */ }
  }

  /* ----------------------------------------------------- PAYMENT REQUESTS */
  var REQ_FILTER = '';
  function screenRequests() {
    var chips = [['', 'All'], ['pending', 'Waiting'], ['paid', 'Paid'], ['expired', 'Expired'], ['cancelled', 'Cancelled'], ['declined', 'Declined']];
    return '<div class="sec-h" style="margin-top:8px">Payment requests</div>' +
      '<div class="sec-sub">' + (L.role === 'cashier' ? 'The requests you raised. ' : '') + 'Each one is one sale: paid once, from the customer’s own Axo with their PIN.</div>' +
      '<button class="big-btn" style="margin:4px 0 12px" onclick="openSheet(\'accept\')">＋ New request</button>' +
      '<div class="tx-filters">' + chips.map(function (c) { return '<span class="txf ' + (REQ_FILTER === c[0] ? 'on' : '') + '" onclick="liveReqFilter(\'' + c[0] + '\')">' + c[1] + '</span>'; }).join('') + '</div>' +
      section('lvReqs', loadRequests);
  }
  window.liveReqFilter = function (f) { REQ_FILTER = f; render(); };

  async function loadRequests() {
    var rows = await api('/payment-requests' + (REQ_FILTER ? '?status=' + REQ_FILTER : ''));
    if (!rows.length) return '<div class="empty" style="padding:26px 0"><div class="e-i">📭</div>No requests here yet.</div>';
    return rows.map(function (r) {
      var st = { pending: ['st-pend', 'Waiting'], paid: ['st-done', 'Paid'], expired: ['st-fail', 'Expired'], cancelled: ['st-fail', 'Cancelled'], declined: ['st-fail', 'Declined'] }[r.status] || ['st-pend', r.status];
      var title = r.description || (r.saleRef ? 'Sale ' + r.saleRef : 'Payment request');
      return '<div class="txn" style="cursor:pointer" onclick="liveShowRequest(\'' + esc(r.id) + '\')">' +
        '<div class="tx-ic" style="background:rgba(37,181,115,.12)">' + (r.targeted ? '⚡' : '📷') + '</div>' +
        '<div class="tx-m"><div class="tx-t">' + esc(title) + '</div><div class="tx-s">' + (r.saleRef ? esc(r.saleRef) + ' · ' : '') + ago(r.createdAt) + '</div></div>' +
        '<div class="tx-r"><div class="tx-a">' + fmtMinor(r.amountMinor, r.currency) + '</div><span class="tx-st ' + st[0] + '">' + st[1] + '</span></div></div>';
    }).join('');
  }

  /* ------------------------------------------------------------ ACCEPT sheets */
  function sheetAccept() {
    return '<h3>Accept a payment</h3><div class="sub">Your customer pays from their own Axo and confirms with their PIN. Nothing is charged until they do.</div>' +
      '<div class="methods">' +
      '<div class="method" onclick="openSheet(\'qr\')"><div class="m-ico">📷</div><div class="m-t">Show a QR</div><div class="m-s">For this sale — they scan & pay</div></div>' +
      '<div class="method" onclick="openSheet(\'stk\')"><div class="m-ico">⚡</div><div class="m-t">Send to a customer</div><div class="m-s">They approve with their PIN</div></div>' +
      '<div class="method" onclick="closeSheet();TAB=\'payids\';render()"><div class="m-ico">🔢</div><div class="m-t">Till & Paybill</div><div class="m-s">Your fixed Axo numbers</div></div>' +
      '</div>';
  }

  function amountField(id) {
    return '<div class="field2"><span class="pre">' + esc(L.currency) + '</span><input id="' + id + '" placeholder="' + (decimals(L.currency) ? '0.00' : '0') + '" inputmode="decimal" autocomplete="off"></div>';
  }

  function sheetQR() {
    return '<h3>Request a payment</h3><div class="sub">Creates a QR for this one sale. It can be paid once, then it’s done.</div>' +
      amountField('lvAmt') +
      '<div class="field2"><span class="pre">📝</span><input id="lvDesc" placeholder="What’s it for? (optional)" maxlength="140"></div>' +
      '<div class="field2"><span class="pre">#</span><input id="lvRef" placeholder="Sale / receipt no. (optional)" maxlength="64"></div>' +
      '<button class="big-btn" id="lvGo" onclick="liveCreateRequest(false)">Show QR</button>';
  }

  function sheetSTK() {
    return '<h3>Send to a customer</h3><div class="sub">They get the request in their Axo chat and approve it with their PIN. You can’t take money without their yes.</div>' +
      '<div class="field2"><span class="pre">@</span><input id="lvTag" placeholder="their Axo tag, e.g. amina" autocomplete="off"></div>' +
      amountField('lvAmt') +
      '<div class="field2"><span class="pre">📝</span><input id="lvDesc" placeholder="What’s it for? (optional)" maxlength="140"></div>' +
      '<button class="big-btn" id="lvGo" onclick="liveCreateRequest(true)">Send request</button>';
  }

  window.liveCreateRequest = async function (targeted) {
    var amount = parseAmount($('#lvAmt').value, L.currency);
    if (!amount) { toast(decimals(L.currency) ? 'Enter an amount like 12.50' : 'Enter a whole amount, e.g. 500'); return; }
    var body = { amountMinor: amount };
    var desc = ($('#lvDesc') && $('#lvDesc').value || '').trim(); if (desc) body.description = desc;
    var ref = ($('#lvRef') && $('#lvRef').value || '').trim(); if (ref) body.saleRef = ref;
    if (targeted) {
      var tag = ($('#lvTag').value || '').trim().replace(/^@/, '');
      if (!tag) { toast('Enter the customer’s Axo tag'); return; }
      body.customerTag = '@' + tag;
    }
    var btn = $('#lvGo'); if (btn) { btn.disabled = true; btn.textContent = 'Creating…'; }
    try {
      // The idempotency key makes a double-tap or a retry return the same request.
      var r = await api('/payment-requests', { method: 'POST', body: body, headers: { 'idempotency-key': uuid() } });
      liveShowRequest(r.id);
    } catch (e) {
      toast(errText(e));
      if (btn) { btn.disabled = false; btn.textContent = targeted ? 'Send request' : 'Show QR'; }
    }
  };

  /** One request: its QR (if open), then live status until it is paid or ends. */
  window.liveShowRequest = async function (id) {
    var r;
    try { r = await api('/payment-requests/' + encodeURIComponent(id)); } catch (e) { toast(errText(e)); return; }
    var qr = '';
    if (!r.targeted && r.status === 'pending') {
      try { qr = await api('/payment-requests/' + encodeURIComponent(id) + '/qr.svg', { raw: true }); } catch (e) { qr = ''; }
    }
    $('#sheet').innerHTML = '<div class="sheet-grip"></div><div id="lvReq" data-id="' + esc(id) + '"></div>';
    $('#sheetBg').classList.add('on');
    paintRequest(r, qr);
    if (r.status === 'pending') watchRequest(id, qr);
  };

  function paintRequest(r, qr) {
    var el = $('#lvReq'); if (!el) return;
    var amount = '<div style="font-size:30px;font-weight:800;text-align:center;margin:6px 0">' + fmtMinor(r.amountMinor, r.currency) + '</div>';
    var what = r.description || (r.saleRef ? 'Sale ' + r.saleRef : '');
    var head = '<h3 style="text-align:center">' + (r.status === 'paid' ? 'Paid ✅' : r.targeted ? 'Waiting for approval' : 'Scan to pay ' + esc(L.merchant.tradingName)) + '</h3>' +
      (what ? '<div class="sub" style="text-align:center">' + esc(what) + '</div>' : '');
    var body = '';
    if (r.status === 'pending') {
      body = r.targeted
        ? '<div class="spin"></div><div class="note-line" style="text-align:center">Sent to the customer’s Axo. They approve it with their PIN — this updates by itself.</div>'
        : (qr ? '<div style="background:#fff;border-radius:14px;padding:10px;max-width:260px;margin:8px auto">' + qr + '</div>' : '<div class="note-line">QR unavailable — the customer can still pay this request from the link.</div>') +
          '<div style="display:flex;align-items:center;justify-content:center;gap:8px;color:var(--dim);font-size:13px"><span class="spin" style="width:16px;height:16px;margin:0;border-width:2px"></span>Waiting for payment · expires at ' + new Date(r.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</div>';
      body += '<button class="big-btn ghost" style="margin-top:14px;color:var(--rose)" onclick="liveCancelRequest(\'' + esc(r.id) + '\')">Cancel request</button>';
    } else if (r.status === 'paid') {
      body = '<div style="text-align:center;font-size:54px">✅</div><div class="recpt">' +
        row('Status', '<span style="color:var(--axo)">Paid — confirmed on the Axo ledger</span>') +
        (r.saleRef ? row('Sale', esc(r.saleRef)) : '') + row('Paid', ago(r.resolvedAt)) +
        '<div id="lvPayer"></div>' + row('Reference', esc((r.merchantTransactionId || '').slice(0, 8).toUpperCase())) + '</div>' +
        '<button class="big-btn" style="margin-top:12px" onclick="closeSheet()">Done</button>';
      if (r.merchantTransactionId) fillPayer(r.merchantTransactionId);
    } else {
      var why = { expired: 'This request expired before it was paid.', cancelled: 'This request was cancelled.', declined: 'The customer declined this request.' }[r.status] || r.status;
      body = '<div class="note-line" style="text-align:center">' + esc(why) + ' Nothing was charged.</div><button class="big-btn" style="margin-top:12px" onclick="openSheet(\'accept\')">New request</button>';
    }
    el.innerHTML = head + amount + body;
  }

  async function fillPayer(txnId) {
    try {
      var t = await api('/charges/' + encodeURIComponent(txnId));
      var el = $('#lvPayer'); if (el && t.customerRef) el.innerHTML = row('Paid by', esc(t.customerRef));
    } catch (e) {}
  }

  function watchRequest(id, qr) {
    var tick = async function () {
      var el = $('#lvReq');
      // Stop as soon as the sheet is closed or shows another request.
      if (!el || el.getAttribute('data-id') !== id || !$('#sheetBg').classList.contains('on')) return;
      try {
        var r = await api('/payment-requests/' + encodeURIComponent(id));
        if (r.status !== 'pending') {
          paintRequest(r, qr);
          if (r.status === 'paid') { toast('💰 Paid — ' + fmtMinor(r.amountMinor, r.currency)); if (TAB === 'home' || TAB === 'payments') render(); }
          return;
        }
      } catch (e) {}
      setTimeout(tick, 2000);
    };
    setTimeout(tick, 2000);
  }

  window.liveCancelRequest = async function (id) {
    try {
      await api('/payment-requests/' + encodeURIComponent(id) + '/cancel', { method: 'POST', body: {} });
      toast('Request cancelled — nothing was charged');
      liveShowRequest(id);
      if (TAB === 'payments') render();
    } catch (e) { toast(errText(e)); }
  };

  var LIVE_SHEETS = { accept: sheetAccept, qr: sheetQR, stk: sheetSTK };
  window.openSheet = function (k) {
    if (!L.on) return demoOpenSheet(k);
    if (!LIVE_SHEETS[k]) { toast('That isn’t connected to the API yet'); return; }
    $('#sheet').innerHTML = '<div class="sheet-grip"></div>' + LIVE_SHEETS[k]();
    $('#sheetBg').classList.add('on');
    setTimeout(function () { var i = $('#lvTag') || $('#lvAmt'); if (i) i.focus(); }, 60);
  };

  /* ---------------------------------------------------------- TRANSACTIONS */
  var TX_FILTER = '';
  function screenTransactions() {
    var chips = [['', 'All'], ['payment_in', 'Payments'], ['refund', 'Refunds'], ['payout', 'Payouts']];
    return back('Transactions', 'Every movement on your Axo balance, straight from the ledger.') +
      '<div class="tx-filters">' + chips.map(function (c) { return '<span class="txf ' + (TX_FILTER === c[0] ? 'on' : '') + '" onclick="liveTxFilter(\'' + c[0] + '\')">' + c[1] + '</span>'; }).join('') +
      '<span class="txf" onclick="liveExportCsv()">⬇ CSV</span></div>' +
      section('lvTx', function () { return loadFeed(200, TX_FILTER ? '?type=' + TX_FILTER : ''); }) +
      '<div class="note-line">Balances come from the double-entry ledger: every payment is a balanced posting, and nothing is ever edited or deleted.</div>';
  }
  window.liveTxFilter = function (f) { TX_FILTER = f; render(); };

  window.liveExportCsv = async function () {
    try {
      var csv = await api('/transactions/export', { raw: true });
      var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      var a = document.createElement('a'); a.href = url; a.download = 'axo-transactions-' + today() + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (e) { toast(errText(e)); }
  };

  window.liveTxDetail = function (id) {
    var t = TX_CACHE[id]; if (!t) return;
    var m = TXN_META[t.type] || ['•', t.type, 'in'];
    var refundable = t.type === 'payment_in' && t.status === 'confirmed' && t.provider === 'axo' && can('owner', 'accountant');
    var remaining = 0n;
    try { remaining = BigInt(t.amountMinor) - BigInt(t.refundedMinor || 0); } catch (e) {}
    $('#sheet').innerHTML = '<div class="sheet-grip"></div><h3 style="margin:2px 0">' + m[0] + ' ' + m[1] + '</h3>' +
      '<div class="sub" style="color:var(--dim);font-size:12.5px;margin-bottom:10px">' + esc(t.id) + '</div>' +
      '<div style="font-size:30px;font-weight:800;color:' + (m[2] === 'in' ? 'var(--axo)' : 'var(--rose)') + ';margin-bottom:10px">' + (m[2] === 'in' ? '+' : '−') + fmtMinor(t.amountMinor, t.currency) + '</div>' +
      '<div class="recpt">' + row('Status', esc(t.status)) + (t.customerRef ? row('Customer', esc(t.customerRef)) : '') +
      row('When', new Date(t.createdAt).toLocaleString()) + row('Rail', esc(t.provider)) +
      (t.type === 'payment_in' ? row('Refunded', fmtMinor(t.refundedMinor || 0, t.currency)) : '') + '</div>' +
      (refundable && remaining > 0n
        ? '<div class="sec-h" style="margin-top:14px">Refund to the customer’s Axo</div>' +
          '<div class="field2"><span class="pre">' + esc(t.currency) + '</span><input id="lvRfAmt" inputmode="decimal" value="' + fmtMinor(remaining, t.currency).replace(/^[^ ]+ /, '').replace(/,/g, '') + '"></div>' +
          '<div class="field2"><span class="pre">📝</span><input id="lvRfWhy" placeholder="Reason (optional)" maxlength="140"></div>' +
          '<button class="big-btn" id="lvRfGo" onclick="liveRefund(\'' + esc(t.id) + '\')">Refund</button>' +
          '<div class="note-line">Goes straight back to the customer’s wallet. You can refund up to ' + fmtMinor(remaining, t.currency) + ' in total.</div>'
        : (t.type === 'payment_in' && remaining <= 0n ? '<div class="note-line" style="margin-top:12px">↩️ Fully refunded.</div>' : ''));
    $('#sheetBg').classList.add('on');
  };

  window.liveRefund = async function (id) {
    var t = TX_CACHE[id];
    var amount = parseAmount($('#lvRfAmt').value, t.currency);
    if (!amount) { toast('Enter a valid amount'); return; }
    var btn = $('#lvRfGo'); btn.disabled = true; btn.textContent = 'Refunding…';
    try {
      await api('/transactions/' + encodeURIComponent(id) + '/refund', {
        method: 'POST', headers: { 'idempotency-key': uuid() },
        body: { amountMinor: amount, reason: ($('#lvRfWhy').value || '').trim() || undefined },
      });
      closeSheet();
      toast('↩️ Refunded ' + fmtMinor(amount, t.currency) + ' to the customer');
      render();
    } catch (e) { toast(errText(e)); btn.disabled = false; btn.textContent = 'Refund'; }
  };

  /* ------------------------------------------------------------ SETTLEMENTS */
  var REPORT_DATE = null;
  function screenSettlements() {
    var d = REPORT_DATE || today();
    return back('Settlements', 'What you collected, refunded and kept — and a check that both ledgers agree.') +
      '<div class="sfield" style="margin:6px 0 12px"><label>DAY (UTC)</label><input type="date" value="' + d + '" max="' + today() + '" onchange="liveReportDate(this.value)"></div>' +
      section('lvRep', function () { return loadReport(d); });
  }
  window.liveReportDate = function (d) { REPORT_DATE = d; render(); };

  async function loadReport(d) {
    var r = await api('/reports/settlement?date=' + d);
    var c = r.collections;
    var payouts = Object.keys(r.payouts).map(function (k) { return row('Payouts · ' + esc(k), r.payouts[k].count + ' · ' + fmtMinor(r.payouts[k].amountMinor, r.currency)); }).join('');
    var ok = r.reconciliation.status === 'balanced';
    return '<div class="recpt">' +
      row('Payments', String(c.count)) + row('Collected (gross)', fmtMinor(c.grossMinor, r.currency)) +
      row('Refunds', '−' + fmtMinor(c.refundsMinor, r.currency)) + row('Axo fees', fmtMinor(c.feesMinor, r.currency)) +
      row('<b>Net</b>', '<b>' + fmtMinor(c.netMinor, r.currency) + '</b>') +
      row('Settled to', 'Your Axo balance (instant)') + payouts +
      row('Balance now', fmtMinor(r.closingBalanceMinor, r.currency)) + '</div>' +
      '<div class="note-line" style="margin-top:12px">' + (ok
        ? '✅ Reconciled — all ' + r.reconciliation.checked + ' movements match on the customer and business ledgers.'
        : '⚠️ ' + r.reconciliation.exceptions.length + ' movement(s) don’t reconcile: ' + r.reconciliation.exceptions.map(function (x) { return esc(x.transactionId.slice(0, 8)) + ' (' + esc(x.problem.replace(/_/g, ' ')) + ')'; }).join(', ')) + '</div>';
  }

  /* ---------------------------------------------------------- TILL & PAYBILL */
  function screenPayIds() {
    return back('Till & Paybill', 'Your fixed Axo numbers. Customers type them in Axo — or scan their QR — to pay you any time.') +
      section('lvPn', loadPayNumbers) +
      (can('owner')
        ? '<div style="display:flex;gap:8px;margin-top:10px"><button class="big-btn" onclick="liveIssueNumber(\'till\')">＋ Till number</button><button class="big-btn ghost" onclick="liveIssueNumber(\'paybill\')">＋ Paybill</button></div>'
        : '');
  }

  async function loadPayNumbers() {
    var rows = await api('/paynumbers');
    if (!rows.length) return '<div class="empty" style="padding:24px 0"><div class="e-i">🔢</div>No numbers yet.' + (can('owner') ? ' Get your first Till below.' : ' Ask the owner to issue one.') + '</div>';
    return rows.map(function (p) {
      var lines = p.kind === 'paybill' && p.lines.length
        ? '<div style="font-size:12px;color:var(--dim);margin-top:6px">Accounts: ' + p.lines.map(function (l) { return esc(l.account) + (l.name ? ' (' + esc(l.name) + ')' : ''); }).join(', ') + '</div>' : '';
      return '<div class="recpt" style="margin-bottom:10px"><div style="display:flex;justify-content:space-between;align-items:center">' +
        '<div><div style="font-size:11px;color:var(--dim);letter-spacing:.6px">' + p.kind.toUpperCase() + (p.label ? ' · ' + esc(p.label) : '') + '</div>' +
        '<div style="font-size:28px;font-weight:800;letter-spacing:3px;color:var(--axo)">' + esc(p.number) + '</div></div>' +
        (p.kind !== 'payid' ? '<button class="big-btn ghost" style="width:auto;padding:8px 14px" onclick="liveNumberQr(\'' + p.kind + '\')">QR</button>' : '') + '</div>' + lines +
        (p.kind === 'paybill' && can('owner', 'manager') ? '<div style="margin-top:8px"><a style="color:var(--axo);cursor:pointer;font-size:13px;font-weight:700" onclick="liveAddLine(\'' + esc(p.id) + '\')">＋ Add account line</a></div>' : '') +
        '</div>';
    }).join('');
  }

  window.liveIssueNumber = async function (kind) {
    try {
      var p = await api('/paynumbers', { method: 'POST', body: { kind: kind } });
      toast('🔢 Your new ' + kind + ' is ' + p.number);
      render();
    } catch (e) { toast(errText(e)); }
  };

  window.liveNumberQr = async function (kind) {
    try {
      var r = await api('/collect/qr?kind=' + kind);
      $('#sheet').innerHTML = '<div class="sheet-grip"></div><h3 style="text-align:center">' + (kind === 'till' ? 'Till ' : 'Paybill ') + esc(r.number) + '</h3>' +
        '<div class="sub" style="text-align:center">Print it or show it at the counter. The customer enters the amount and confirms with their PIN.</div>' +
        '<div style="background:#fff;border-radius:14px;padding:10px;max-width:260px;margin:8px auto">' + r.svg + '</div>';
      $('#sheetBg').classList.add('on');
    } catch (e) { toast(errText(e)); }
  };

  window.liveAddLine = function (id) {
    $('#sheet').innerHTML = '<div class="sheet-grip"></div><h3>Add an account line</h3><div class="sub">Customers pay “Paybill + account”, e.g. RENT or UNIT12.</div>' +
      '<div class="field2"><span class="pre">#</span><input id="lvLnAcct" placeholder="Account code, e.g. RENT" maxlength="32"></div>' +
      '<div class="field2"><span class="pre">📝</span><input id="lvLnName" placeholder="Name (optional)" maxlength="80"></div>' +
      '<button class="big-btn" onclick="liveSaveLine(\'' + esc(id) + '\')">Add line</button>';
    $('#sheetBg').classList.add('on');
  };
  window.liveSaveLine = async function (id) {
    var account = ($('#lvLnAcct').value || '').trim();
    if (!account) { toast('Enter an account code'); return; }
    try {
      await api('/paynumbers/' + encodeURIComponent(id) + '/lines', { method: 'POST', body: { account: account, name: ($('#lvLnName').value || '').trim() || undefined } });
      closeSheet(); toast('Line added'); render();
    } catch (e) { toast(errText(e)); }
  };

  /* ------------------------------------------------------------ INTEGRATIONS */
  function screenIntegrations() {
    return back('Integrations', 'Connect your POS or back office. Full guide: docs/POS-API.md.') +
      '<div class="sec-h">API keys <a onclick="liveNewKey()">＋ New</a></div>' + section('lvKeys', loadKeys) +
      '<div class="sec-h">Webhooks <a onclick="liveNewHook()">＋ New</a></div>' + section('lvHooks', loadHooks) +
      '<div class="sec-h">Recent deliveries</div>' + section('lvDel', loadDeliveries);
  }

  async function loadKeys() {
    var rows = await api('/api-keys');
    if (!rows.length) return '<div class="note-line">No keys yet. Create one per till or POS terminal.</div>';
    return rows.map(function (k) {
      return '<div class="txn"><div class="tx-ic">🔑</div><div class="tx-m"><div class="tx-t">' + esc(k.name) + ' · ' + esc(k.role) + '</div>' +
        '<div class="tx-s">axo_sk_' + esc(k.prefix) + '_… · ' + (k.lastUsedAt ? 'used ' + ago(k.lastUsedAt) : 'never used') + '</div></div>' +
        '<div class="tx-r">' + (k.revokedAt ? '<span class="tx-st st-fail">Revoked</span>' : '<a style="color:var(--rose);cursor:pointer;font-size:13px" onclick="liveRevokeKey(\'' + esc(k.id) + '\')">Revoke</a>') + '</div></div>';
    }).join('');
  }

  window.liveNewKey = function () {
    $('#sheet').innerHTML = '<div class="sheet-grip"></div><h3>New API key</h3><div class="sub">For one till or POS terminal. It can raise and read payment requests; it can’t refund or change settings.</div>' +
      '<div class="field2"><span class="pre">🏷</span><input id="lvKeyName" placeholder="e.g. Front till" maxlength="60"></div>' +
      '<div class="sfield" style="margin:0 0 12px"><label>ROLE</label><select id="lvKeyRole" style="width:100%;background:none;border:none;color:var(--txt);font-size:15px;font-family:var(--font)"><option value="cashier">Cashier — its own requests</option><option value="manager">Manager — all requests</option></select></div>' +
      '<button class="big-btn" onclick="liveCreateKey()">Create key</button>';
    $('#sheetBg').classList.add('on');
  };
  window.liveCreateKey = async function () {
    var name = ($('#lvKeyName').value || '').trim();
    if (!name) { toast('Name the key'); return; }
    try {
      var k = await api('/api-keys', { method: 'POST', body: { name: name, role: $('#lvKeyRole').value } });
      showSecretOnce('API key created', 'Copy it into your POS now — it won’t be shown again.', k.key);
      if (TAB === 'api') render();
    } catch (e) { toast(errText(e)); }
  };
  window.liveRevokeKey = async function (id) {
    try { await api('/api-keys/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: {} }); toast('Key revoked'); render(); } catch (e) { toast(errText(e)); }
  };

  async function loadHooks() {
    var rows = await api('/webhook-endpoints');
    if (!rows.length) return '<div class="note-line">No webhook endpoints. Add one to be notified the moment a payment lands.</div>';
    return rows.map(function (h) {
      return '<div class="txn"><div class="tx-ic">📡</div><div class="tx-m"><div class="tx-t" style="word-break:break-all">' + esc(h.url) + '</div><div class="tx-s">added ' + ago(h.createdAt) + '</div></div>' +
        '<div class="tx-r">' + (h.active ? '<a style="color:var(--rose);cursor:pointer;font-size:13px" onclick="liveDisableHook(\'' + esc(h.id) + '\')">Disable</a>' : '<span class="tx-st st-fail">Disabled</span>') + '</div></div>';
    }).join('');
  }
  window.liveNewHook = function () {
    $('#sheet').innerHTML = '<div class="sheet-grip"></div><h3>New webhook</h3><div class="sub">We POST signed payment events here (payment.succeeded, payment.refunded…).</div>' +
      '<div class="field2"><span class="pre">🔗</span><input id="lvHookUrl" placeholder="https://pos.example.com/axo" inputmode="url"></div>' +
      '<button class="big-btn" onclick="liveCreateHook()">Add endpoint</button>';
    $('#sheetBg').classList.add('on');
  };
  window.liveCreateHook = async function () {
    var url = ($('#lvHookUrl').value || '').trim();
    try {
      var h = await api('/webhook-endpoints', { method: 'POST', body: { url: url } });
      showSecretOnce('Webhook added', 'Use this secret to verify the Axo-Signature header. It won’t be shown again.', h.secret);
      if (TAB === 'api') render();
    } catch (e) { toast(errText(e)); }
  };
  window.liveDisableHook = async function (id) {
    try { await api('/webhook-endpoints/' + encodeURIComponent(id) + '/disable', { method: 'POST', body: {} }); toast('Endpoint disabled'); render(); } catch (e) { toast(errText(e)); }
  };

  async function loadDeliveries() {
    var rows = await api('/webhook-deliveries');
    if (!rows.length) return '<div class="note-line">Nothing delivered yet.</div>';
    return rows.slice(0, 15).map(function (d) {
      var st = { delivered: ['st-done', 'Delivered'], pending: ['st-pend', 'Retrying'], failed: ['st-fail', 'Failed'] }[d.status] || ['st-pend', d.status];
      return '<div class="txn"><div class="tx-ic">✉️</div><div class="tx-m"><div class="tx-t">' + esc(d.event) + '</div><div class="tx-s">' + ago(d.createdAt) + ' · ' + d.attempts + ' attempt(s)' + (d.lastError ? ' · ' + esc(d.lastError) : '') + '</div></div>' +
        '<div class="tx-r"><span class="tx-st ' + st[0] + '">' + st[1] + '</span></div></div>';
    }).join('');
  }

  function showSecretOnce(title, sub, secret) {
    $('#sheet').innerHTML = '<div class="sheet-grip"></div><h3>' + title + '</h3><div class="sub">' + sub + '</div>' +
      '<div class="api-key" style="margin:12px 0"><div class="ak-l">Shown once</div><div class="ak-v" style="word-break:break-all"><span id="lvSecret">' + esc(secret) + '</span></div></div>' +
      '<button class="big-btn" onclick="liveCopySecret()">Copy</button><button class="big-btn ghost" style="margin-top:8px" onclick="closeSheet()">I’ve saved it</button>';
    $('#sheetBg').classList.add('on');
  }
  window.liveCopySecret = function () {
    var v = $('#lvSecret').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(function () { toast('Copied'); }, function () { toast('Select the text and copy it'); });
    else toast('Select the text and copy it');
  };

  /* ------------------------------------------------------------------ TOOLS */
  function screenTools() {
    var tiles = [['transactions', '🧾', 'Transactions', 'Ledger history · refunds'], ['settlements', '📊', 'Settlements', 'Daily report · reconciliation'],
      ['payids', '🔢', 'Till & Paybill', 'Your Axo numbers · QR'], ['api', '🔌', 'Integrations', 'POS keys · webhooks']].filter(function (t) { return allowed(t[0]); });
    return '<div class="sec-h" style="margin-top:8px">Tools</div><div class="biz-menu-grid">' +
      tiles.map(function (t) { return '<div class="biz-tile" onclick="TAB=\'' + t[0] + '\';render()"><div class="bt-ic">' + t[1] + '</div><div class="bt-t">' + t[2] + '</div><div class="bt-s">' + t[3] + '</div></div>'; }).join('') +
      '</div><div class="note-line">🧪 Stock, orders, invoices, payroll, credit, crypto and the other tools aren’t connected to the API yet. They’re only in the demo, so they’re hidden from your real account.</div>';
  }

  /* --------------------------------------------------------- resume session */
  // A reload keeps you signed in (tokens live in this tab's sessionStorage).
  var saved = load(STORE);
  if (saved && saved.token) {
    L.base = saved.base; L.token = saved.token; L.refreshToken = saved.refreshToken; L.role = saved.role;
    startSession().catch(function () { endSession(); });
  }
  var apiInput = document.getElementById('siApi');
  if (apiInput) apiInput.value = savedApiBase();
  chrome();
})();
