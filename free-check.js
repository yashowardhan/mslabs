(function () {
  'use strict';

  // Use a custom domain (e.g. https://api.mslabsstudio.com) so WAF rules and the Cache API work. workers.dev supports neither.
  var API_BASE = 'https://mslabs-proxy.yashkaushikbits19.workers.dev';
  var CONTACT_URL = 'index.html'; // swap for your Cal.com/Calendly link if you have one
  var CLIENT_TIMEOUT_MS = 90000;

  var $ = function (id) { return document.getElementById(id); };
  var form = $('check-form'), statusEl = $('check-status'), submitBtn = $('check-submit');
  var progress = $('progress'), results = $('results');
  var state, steps;

  /* ---------- tiny helpers ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function setStatus(msg, kind) {
    statusEl.textContent = msg || '';
    statusEl.className = 'form-status' + (kind ? ' is-' + kind : '');
  }
  function track(name, props) {
    try {
      if (window.plausible) window.plausible(name, { props: props || {} });
      if (window.gtag) window.gtag('event', name, props || {});
    } catch (e) { /* analytics must never break the tool */ }
  }
  function rateScore(v) { return v == null ? '' : v >= 90 ? 'good' : v >= 50 ? 'ok' : 'poor'; }
  function rateVital(key, v) {
    var t = { lcp: [2500, 4000], tbt: [200, 600], cls: [0.1, 0.25], fcp: [1800, 3000] }[key];
    return v == null ? '' : v <= t[0] ? 'good' : v <= t[1] ? 'ok' : 'poor';
  }

  /* ---------- year + nav ---------- */
  var year = $('year'); if (year) year.textContent = new Date().getFullYear();
  var toggle = $('nav-toggle'), navLinks = $('nav-links');
  if (toggle && navLinks) toggle.addEventListener('click', function () {
    var open = navLinks.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  /* ---------- rendering ---------- */
  function card(label, value, sub, tone, pending) {
    var c = el('article', 'metric-card' + (pending ? ' pending' : ''));
    c.appendChild(el('span', 'metric-label', label));
    c.appendChild(el('strong', 'metric-value ' + (tone || ''), pending ? '…' : (value == null ? 'n/a' : String(value))));
    if (sub) c.appendChild(el('small', 'metric-sub', sub));
    return c;
  }

  function scoreCard(label, getter, sub, errKey) {
    var v = getter();
    var pending = v === undefined && !state[errKey];
    if (state[errKey] && v === undefined) return card(label, 'n/a', state[errKey], '', false);
    return card(label, v, sub, rateScore(v), pending);
  }

  function renderCards() {
    var m = state.mobile, d = state.desktop;
    $('score-grid').replaceChildren(
      scoreCard('Mobile speed', function () { return m ? m.scores.performance : undefined; }, 'Most visitors are on phones', 'mobileError'),
      scoreCard('Desktop speed', function () { return d ? d.scores.performance : undefined; }, 'Laptop and desktop', 'desktopError'),
      scoreCard('Accessibility', function () { return m ? m.scores.accessibility : undefined; }, 'Usable by everyone', 'mobileError'),
      scoreCard('SEO basics', function () { return m ? m.scores.seo : undefined; }, 'Findable on Google', 'mobileError'),
      scoreCard('Best practices', function () { return m ? m.scores.bestPractices : undefined; }, 'Modern, safe code', 'mobileError')
    );
    var mt = m && m.metrics;
    function vit(label, key, sub) {
      if (!mt) return state.mobileError ? card(label, 'n/a', state.mobileError, '', false) : card(label, null, sub, '', true);
      var x = mt[key] || {};
      return card(label, x.display || 'n/a', sub, rateVital(key, x.value), false);
    }
    $('vitals-grid').replaceChildren(
      vit('Main content visible', 'lcp', 'Target: under 2.5 s'),
      vit('Time frozen while loading', 'tbt', 'Target: under 200 ms'),
      vit('Layout jumping', 'cls', 'Target: under 0.1'),
      vit('First thing appears', 'fcp', 'Target: under 1.8 s')
    );
  }

  function fixItem(f) {
    var li = el('li', 'fix-item');
    var t = el('div', 'fix-title');
    t.appendChild(el('span', 'badge ' + f.sev, f.sev === 'high' ? 'Fix first' : f.sev === 'med' ? 'Worth fixing' : 'Nice to have'));
    t.appendChild(el('span', '', f.title));
    li.appendChild(t);
    li.appendChild(el('p', 'fix-plain', f.plain));
    return li;
  }

  function row(label, ok, note) {
    var li = el('li', 'check-row');
    var left = el('div', '');
    left.appendChild(document.createTextNode(label));
    if (note) left.appendChild(el('small', '', note));
    li.appendChild(left);
    li.appendChild(el('span', ok === true ? 'badge-ok' : ok === false ? 'badge-err' : 'badge-warn', ok === true ? 'OK' : ok === false ? 'Missing' : 'Unknown'));
    return li;
  }

  function renderDetails() {
    var p = state.page, h = state.headers, files = state.files || {};
    var basics = $('basics'), hl = $('headers');
    basics.replaceChildren(); hl.replaceChildren();
    if (state.pageError) {
      basics.appendChild(el('li', 'fix-plain', state.pageError));
      hl.appendChild(el('li', 'fix-plain', state.pageError));
    } else if (p && !p.notHtml) {
      basics.append(
        row('HTTPS (secure connection)', p.https),
        row('Page title', !!p.title, p.title ? p.title.length + ' characters' : 'Shown in Google results'),
        row('Search description', !!p.description, 'The snippet under your Google listing'),
        row('Mobile viewport', p.viewport),
        row('One main heading (H1)', p.h1 === 1, p.h1 + ' found'),
        row('Allowed in search (no noindex)', !p.noindex),
        row('Social share preview', p.ogTitle && p.ogImage, 'Image and headline for WhatsApp, LinkedIn, Facebook'),
        row('Canonical link', !!p.canonical),
        row('robots.txt', files.robots == null ? null : files.robots),
        row('sitemap.xml', files.sitemap == null ? null : files.sitemap)
      );
    } else if (!p) {
      basics.appendChild(el('li', 'fix-plain', 'Checking…'));
      hl.appendChild(el('li', 'fix-plain', 'Checking…'));
    }
    if (h) {
      hl.append(
        row('HSTS (forces HTTPS)', h.hsts),
        row('Clickjacking protection', h.clickjacking),
        row('MIME sniffing protection', h.nosniff),
        row('Referrer policy', h.referrer),
        row('Content Security Policy', h.csp, 'Advanced hardening, often optional for brochure sites')
      );
    }

    var opp = $('opportunities'); opp.replaceChildren();
    var list = (state.mobile && state.mobile.opportunities) || [];
    if (state.mobile && !list.length) opp.appendChild(el('li', 'fix-plain', 'No major speed opportunities flagged. Nice.'));
    else if (!state.mobile) opp.appendChild(el('li', 'fix-plain', state.mobileError || 'Running the speed test…'));
    list.forEach(function (o) {
      var li = el('li', 'fix-item');
      li.appendChild(el('div', 'fix-title', o.title));
      var saving = [];
      if (o.savingsMs) saving.push('could save about ' + (o.savingsMs / 1000).toFixed(1) + ' s');
      if (o.savingsKb) saving.push('about ' + o.savingsKb + ' KB lighter');
      li.appendChild(el('p', 'fix-plain', o.why + (saving.length ? ' (' + saving.join(', ') + ')' : '')));
      opp.appendChild(li);
    });

    var ls = $('links'), sum = $('link-summary'); ls.replaceChildren();
    if (state.links) {
      var L = state.links;
      sum.textContent = L.checked
        ? L.checked + ' same-site links checked: ' + L.broken + ' broken' + (L.unverified ? ', ' + L.unverified + ' couldn\'t be verified (often bot protection).' : '.')
        : 'No same-site links found on the homepage to check.';
      L.items.forEach(function (it) {
        var li = el('li', 'check-row');
        li.appendChild(el('span', 'link-url', it.url.replace(/^https?:\/\//, '')));
        var ok = it.state === 'ok';
        li.appendChild(el('span', ok ? 'badge-ok' : it.state === 'broken' ? 'badge-err' : 'badge-warn',
          ok ? 'OK' : it.state === 'broken' ? 'Broken ' + it.status : 'Unverified'));
        ls.appendChild(li);
      });
    } else {
      sum.textContent = state.pageError ? '' : 'Checking links…';
    }
  }

  function headline(score) {
    if (score == null) return 'Here is what we could measure.';
    if (score >= 90) return 'Your site is in good shape. A few things to polish.';
    if (score >= 70) return 'Solid foundation, but fixable issues are holding it back.';
    if (score >= 50) return 'Real problems that visitors and Google will notice.';
    return 'Your site needs attention. It is likely losing visitors.';
  }

  function renderFinal(r) {
    var score = r.overall;
    var ring = $('ring');
    ring.style.setProperty('--p', score == null ? 0 : score);
    ring.style.setProperty('--c', score == null ? '#64748b' : score >= 90 ? '#34d399' : score >= 50 ? '#fbbf24' : '#f87171');
    $('ring-num').textContent = score == null ? 'n/a' : score;
    ring.setAttribute('aria-label', 'Overall score ' + (score == null ? 'unavailable' : score + ' out of 100'));
    $('results-title').textContent = headline(score);
    var highs = (r.findings || []).filter(function (f) { return f.sev === 'high'; }).length;
    $('results-subtitle').textContent = r.host + ' · ' + (r.findings || []).length + ' findings' + (highs ? ', ' + highs + ' to fix first' : '') +
      '. Overall is our blend of Google\'s mobile speed, SEO, accessibility and best-practice scores.';

    var f = r.findings || [], fl = $('findings'), more = $('findings-more');
    fl.replaceChildren(); more.replaceChildren();
    if (!f.length) fl.appendChild(el('li', 'fix-plain', 'No significant issues detected in the automated checks.'));
    f.slice(0, 3).forEach(function (x) { fl.appendChild(fixItem(x)); });
    f.slice(3).forEach(function (x) { more.appendChild(fixItem(x)); });
    $('more-findings').hidden = f.length <= 3;
    $('more-summary').textContent = 'Show ' + (f.length - 3) + ' more';

    var wp = !!(r.page && r.page.isWordPress);
    var midText = wp
      ? 'Your site looks like WordPress. We handle exactly these fixes (speed, updates, security) on a monthly plan.'
      : 'Most of these are quick wins for a developer. We can walk you through which ones matter for your goals.';
    $('mid-cta-text').textContent = midText; $('mid-cta').hidden = !f.length;
    $('wp-link').hidden = !wp;
    $('final-cta').hidden = false; $('summary-cta').hidden = false;

    var q = '?from=free-check&site=' + encodeURIComponent(r.host) + (score != null ? '&score=' + score : '') + '&issues=' + f.length;
    document.querySelectorAll('[data-cta]').forEach(function (a) {
      if (a.tagName === 'A' && a.getAttribute('data-cta') !== 'final-wp') a.href = CONTACT_URL + q + '#contact';
    });
    $('sticky-text').textContent = highs ? highs + ' issue' + (highs > 1 ? 's' : '') + ' to fix first' : 'Want help with these?';
    $('sticky-cta').classList.add('show');
  }

  function render() { renderCards(); renderDetails(); }

  /* ---------- progress ---------- */
  function setStep(name, s) {
    var li = document.querySelector('#steps [data-step="' + name + '"]');
    if (li) li.setAttribute('data-s', s);
    var all = document.querySelectorAll('#steps li'), done = 0;
    all.forEach(function (n) { if (n.getAttribute('data-s') !== 'run') done++; });
    var pct = Math.max(6, Math.round((done / all.length) * 100));
    $('progress-fill').style.width = pct + '%';
    $('progress-bar').setAttribute('aria-valuenow', pct);
  }

  /* ---------- stream handling ---------- */
  function handle(ev) {
    switch (ev.event) {
      case 'page': state.page = ev.page; state.headers = ev.headers; setStep('page', 'done'); break;
      case 'page_error': state.pageError = ev.message; setStep('page', 'err'); setStep('links', 'err'); break;
      case 'links': state.files = ev.files; state.links = ev.links; setStep('links', 'done'); break;
      case 'psi_mobile': state.mobile = ev.mobile; setStep('mobile', 'done'); break;
      case 'psi_desktop': state.desktop = ev.desktop; setStep('desktop', 'done'); break;
      case 'psi_error':
        state[ev.strategy + 'Error'] = ev.message; setStep(ev.strategy, 'err'); break;
      case 'report':
        state = ev.report; ['page', 'mobile', 'desktop', 'links'].forEach(function (s) { setStep(s, 'done'); });
        results.hidden = false;
        render(); renderFinal(state);
        progress.hidden = true;
        if (!handle.scrolled) { handle.scrolled = true; results.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        $('results-title').focus({ preventScroll: true });
        track('check_completed', { overall: state.overall, wordpress: !!(state.page && state.page.isWordPress) });
        return;
      case 'fatal': throw new Error(ev.message);
    }
    results.hidden = false;
    render();
    if (!handle.scrolled) { handle.scrolled = true; results.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  function waitForToken(ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        var f = form.querySelector('[name="cf-turnstile-response"]');
        if (f && f.value) return resolve(f.value);
        if (Date.now() - t0 > ms) return resolve('');
        setTimeout(poll, 200);
      })();
    });
  }

  function utm() {
    var out = {}, p = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) { if (p.get(k)) out[k] = p.get(k); });
    return out;
  }

  function invalid(input, msg) {
    input.setAttribute('aria-invalid', 'true'); input.focus(); setStatus(msg, 'error');
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    ['check-url', 'check-email'].forEach(function (id) { $(id).removeAttribute('aria-invalid'); });
    var rawUrl = $('check-url').value.trim(), email = $('check-email').value.trim(), name = $('check-name').value.trim();

    if (!rawUrl) return invalid($('check-url'), 'Please enter your website address.');
    try { new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl); }
    catch (e) { return invalid($('check-url'), 'That doesn\'t look like a website address. Try something like example.com.'); }
    if (!$('check-email').validity.valid || !email) return invalid($('check-email'), 'Please enter a valid email so we can send follow-up notes.');

    submitBtn.disabled = true;
    setStatus('Verifying…');
    var token = await waitForToken(8000);
    if (!token) { submitBtn.disabled = false; return setStatus('We couldn\'t verify the security check. Please refresh and try again.', 'error'); }

    state = {}; handle.scrolled = false;
    results.hidden = true; $('final-cta').hidden = true; $('summary-cta').hidden = true; $('sticky-cta').classList.remove('show');
    document.querySelectorAll('#steps li').forEach(function (li) { li.setAttribute('data-s', 'run'); });
    $('progress-fill').style.width = '6%';
    progress.hidden = false;
    setStatus('');
    track('check_started');

    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, CLIENT_TIMEOUT_MS);
    try {
      var res = await fetch(API_BASE + '/api/check', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ name: name, email: email, url: rawUrl, hp_field: $('hp-field').value, turnstileToken: token, source: location.pathname, ref: document.referrer, utm: utm() })
      });
      if (!res.ok || !res.body) {
        var j = await res.json().catch(function () { return {}; });
        throw new Error(j.error || 'Server error (' + res.status + ')');
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '', got = false;
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        var i;
        while ((i = buf.indexOf('\n')) >= 0) {
          var line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          var ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.event === 'report') got = true;
          handle(ev);
        }
      }
      if (!got) throw new Error('The check ended early. Please try again.');
      setStatus('Done. Your report is below.', 'ok');
    } catch (e) {
      progress.hidden = true;
      var msg = e && e.name === 'AbortError' ? 'The check took too long. Please try again, or email us and we\'ll run it manually.' : (e.message || 'Could not reach the check service.');
      if (state && (state.mobile || state.page)) { results.hidden = false; }
      setStatus(msg, 'error');
      track('check_failed');
    } finally {
      clearTimeout(timer);
      submitBtn.disabled = false;
      try { if (window.turnstile) window.turnstile.reset(); } catch (e) { /* ignore */ }
    }
  });

  /* ---------- share + prefill ---------- */
  $('share-report').addEventListener('click', async function () {
    var v = $('check-url').value.trim(); if (!v) return;
    var u = new URL(location.origin + location.pathname); u.searchParams.set('url', v);
    var btn = $('share-report');
    try { await navigator.clipboard.writeText(u.toString()); btn.textContent = '✓ Link copied'; setTimeout(function () { btn.textContent = 'Copy check link'; }, 2500); }
    catch (e) { window.prompt('Copy this link:', u.toString()); }
    track('share_clicked');
  });
  var pre = new URLSearchParams(location.search).get('url');
  if (pre) $('check-url').value = pre;

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-cta]');
    if (a) track('cta_click', { cta: a.getAttribute('data-cta') });
  });
})();

