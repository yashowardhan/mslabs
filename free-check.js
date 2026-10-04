(function () {
  'use strict';

  // Use a custom domain (e.g. https://api.mslabsstudio.com) so WAF rules and the Cache API work. workers.dev supports neither.
  var API_BASE = 'https://mslabs-proxy.yashkaushikbits19.workers.dev';
  var CONTACT_URL = 'index.html'; // swap for your Cal.com/Calendly link if you have one
  var SHARE_BASE = 'https://mslabsstudio.com/free-check.html';
  var CLIENT_TIMEOUT_MS = 90000;
  var COMPARE_TIMEOUT_MS = 75000;
  var LCP_TARGET_S = 2.5;
  var LOSS_PER_SEC_LOW = 0.03, LOSS_PER_SEC_HIGH = 0.07, LOSS_CAP = 0.35;

  var $ = function (id) { return document.getElementById(id); };
  var form = $('check-form'), statusEl = $('check-status'), submitBtn = $('check-submit');
  var progress = $('progress'), results = $('results');
  var state = {};

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

  // Funnel events: audit_started, audit_completed, cta_clicked, pdf_saved, report_shared (+ a few extras).
  // Works with gtag.js, GTM (dataLayer) and Plausible. Analytics must never break the tool.
  function track(name, props) {
    props = props || {};
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('event', name, props);                    // gtag also writes to dataLayer
      } else if (Array.isArray(window.dataLayer)) {
        var ev = { event: name }; for (var k in props) ev[k] = props[k];
        window.dataLayer.push(ev);
      }
      if (typeof window.plausible === 'function') window.plausible(name, { props: props });
    } catch (e) { /* ignore */ }
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2800);
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

  /* ---------- rendering: cards ---------- */
  function card(label, value, sub, tone, pending) {
    var c = el('article', 'metric-card' + (pending ? ' is-skeleton' : ''));
    c.appendChild(el('span', 'metric-label', label));
    if (pending) {
      c.setAttribute('aria-busy', 'true');
      c.appendChild(el('span', 'skel skel-value'));
      c.appendChild(el('span', 'skel skel-sub'));
      return c;
    }
    c.appendChild(el('strong', 'metric-value ' + (tone || ''), value == null ? 'n/a' : String(value)));
    if (sub) c.appendChild(el('small', 'metric-sub', sub));
    return c;
  }

  function skeleton(ul, n) {
    ul.replaceChildren();
    for (var i = 0; i < n; i++) {
      var li = el('li', 'fix-item'); li.setAttribute('aria-hidden', 'true');
      li.appendChild(el('span', 'skel skel-line'));
      li.appendChild(el('span', 'skel skel-line short'));
      ul.appendChild(li);
    }
  }

  function setSummaryLoading(host) {
    $('summary').classList.add('is-loading');
    $('ring').style.setProperty('--p', 28);
    $('ring-num').textContent = '';
    $('ring').setAttribute('aria-label', 'Analysis in progress');
    $('results-title').textContent = 'Analyzing ' + host + '…';
    $('results-subtitle').textContent = 'Results fill in below as each test finishes.';
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

  /* ---------- rendering: findings ---------- */
  function fixItem(f, num) {
    var li = el('li', 'fix-item');
    var tags = el('div', 'fix-tags');
    var effort = f.effort === 'big' ? 'big' : 'quick';
    tags.appendChild(el('span', 'badge ' + effort, effort === 'big' ? 'Bigger Job' : 'Quick Win'));
    tags.appendChild(el('span', 'badge ' + f.sev, f.sev === 'high' ? 'Fix first' : f.sev === 'med' ? 'Worth fixing' : 'Nice to have'));
    li.appendChild(tags);
    var t = el('div', 'fix-title');
    if (num) t.appendChild(el('span', 'fix-num', String(num)));
    t.appendChild(el('span', '', f.title));
    li.appendChild(t);
    li.appendChild(el('p', 'fix-plain', f.plain));
    return li;
  }

  function renderFindings(r) {
    var f = r.findings || [], top = $('top-fixes'), more = $('findings-more');
    top.replaceChildren(); more.replaceChildren();
    if (!f.length) top.appendChild(el('li', 'fix-plain', 'No significant issues detected in the automated checks.'));
    f.slice(0, 3).forEach(function (x, i) { top.appendChild(fixItem(x, i + 1)); });
    if (f.length > 3) f.slice(3).forEach(function (x) { more.appendChild(fixItem(x)); });
    else more.appendChild(el('li', 'fix-plain', 'No additional findings.'));
  }

  /* ---------- rendering: technical details ---------- */
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
    var basics = $('basics'), hl = $('headers'), lg = $('leadgen');
    basics.replaceChildren(); hl.replaceChildren(); lg.replaceChildren();
    if (state.pageError) {
      [basics, hl, lg].forEach(function (u) { u.appendChild(el('li', 'fix-plain', state.pageError)); });
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
      var ga = [];
      if (p.hasGA) ga.push('Google Analytics'); if (p.hasGTM) ga.push('Tag Manager');
      var contact = [];
      if (p.forms) contact.push(p.forms + ' form' + (p.forms > 1 ? 's' : ''));
      if (p.mailto) contact.push('email link'); if (p.tel) contact.push('tap-to-call');
      lg.append(
        row('Google Analytics / Tag Manager', !!(p.hasGA || p.hasGTM), ga.length ? ga.join(' + ') + ' detected' : 'Lets you see where leads come from'),
        row('Contact form, email or phone link', !!(p.forms || p.mailto || p.tel), contact.length ? contact.join(', ') : 'Gives ready buyers a way to reach you')
      );
      if (p.isWordPress) {
        var li = el('li', 'check-row'), d = el('div', '');
        d.appendChild(document.createTextNode('WordPress detected'));
        var parts = [];
        if (p.wpTheme) parts.push('Theme: ' + p.wpTheme);
        if (p.builders && p.builders.length) parts.push('Builder: ' + p.builders.join(', '));
        if (p.wpPlugins && p.wpPlugins.length) parts.push('Plugins: ' + p.wpPlugins.join(', '));
        if (parts.length) d.appendChild(el('small', '', parts.join(' · ')));
        li.appendChild(d);
        li.appendChild(el('span', 'badge-warn', 'Detected'));
        lg.appendChild(li);
      }
    } else if (!p) {
      skeleton(basics, 6); skeleton(hl, 5); skeleton(lg, 4);
    }
    if (state.mail) {
      var mm = state.mail;
      lg.append(
        row('SPF record (who may send your email)', mm.spf, 'Checked on ' + mm.domain),
        row('DMARC record (protects your email name)', mm.dmarc, 'Checked on _dmarc.' + mm.domain)
      );
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
    else if (!state.mobile) { if (state.mobileError) opp.appendChild(el('li', 'fix-plain', state.mobileError)); else skeleton(opp, 3); }
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
        var a = el('a', 'link-url', it.url.replace(/^https?:\/\//, ''));
        if (/^https?:\/\//i.test(it.url)) { a.href = it.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
        li.appendChild(a);
        var ok = it.state === 'ok';
        li.appendChild(el('span', ok ? 'badge-ok' : it.state === 'broken' ? 'badge-err' : 'badge-warn',
          ok ? 'OK' : it.state === 'broken' ? 'Broken ' + it.status : 'Unverified'));
        ls.appendChild(li);
      });
    } else {
      sum.textContent = state.pageError || '';
      if (!state.pageError) skeleton(ls, 4);
    }
  }

  /* ---------- business impact estimator ---------- */
  function lcpInfo() {
    var m = state.mobile;
    if (!m) return null;
    if (typeof m.fieldLcpMs === 'number') return { sec: m.fieldLcpMs / 1000, field: true };
    var lab = m.metrics && m.metrics.lcp && m.metrics.lcp.value;
    return typeof lab === 'number' ? { sec: lab / 1000, field: false } : null;
  }

  function fmtNum(n) { return n < 10 ? (Math.round(n * 10) / 10).toString() : Math.round(n).toLocaleString(); }
  function fmtMoney(n) { return '$' + Math.round(n).toLocaleString(); }

  function renderImpact() {
    var num = $('impact-lcp'), verdict = $('impact-verdict'), result = $('impact-result'), badge = $('impact-badge');
    num.className = 'impact-num';
    var info = lcpInfo();
    if (!info) {
      badge.hidden = true; result.textContent = '';
      if (state.mobileError) { num.textContent = 'n/a'; verdict.textContent = state.mobileError; }
      else { num.textContent = '…'; verdict.textContent = 'Measuring your load time…'; }
      return;
    }
    num.textContent = info.sec.toFixed(1) + ' s';
    num.classList.add(info.sec <= 2.5 ? 'good' : info.sec <= 4 ? 'ok' : 'poor');
    badge.hidden = false;
    badge.className = 'src-badge' + (info.field ? ' field' : '');
    badge.textContent = info.field ? 'Based on real Chrome visitors' : 'Based on slow mobile simulation';

    var delay = Math.max(0, info.sec - LCP_TARGET_S);
    if (delay <= 0) {
      verdict.textContent = 'Your main content appears within Google\'s 2.5 s target, so we don\'t estimate a speed penalty. Nice work.';
      result.textContent = '';
      return;
    }
    var rLow = Math.min(LOSS_PER_SEC_LOW * delay, LOSS_CAP), rHigh = Math.min(LOSS_PER_SEC_HIGH * delay, LOSS_CAP);
    var pLow = Math.round(rLow * 100), pHigh = Math.round(rHigh * 100);
    verdict.textContent = 'That is ' + delay.toFixed(1) + ' s past Google\'s 2.5 s target. Slow pages commonly lose roughly ' + pLow + '–' + pHigh + '% of conversions.';

    var V = parseFloat($('imp-visitors').value), C = parseFloat($('imp-conv').value), D = parseFloat($('imp-value').value);
    if (V > 0 && C > 0) {
      var leads = V * C / 100, lo = leads * rLow, hi = leads * rHigh;
      var txt = 'Roughly ' + fmtNum(lo) + '–' + fmtNum(hi) + ' leads lost per month';
      if (D > 0) txt += ' (about ' + fmtMoney(lo * D) + '–' + fmtMoney(hi * D) + ' per month)';
      result.textContent = txt + '.';
    } else {
      result.textContent = 'Add your visitors and conversion rate below for a monthly estimate.';
    }
  }

  /* ---------- filmstrip ---------- */
  function renderFilmstrip() {
    var wrap = $('filmstrip-wrap'), ol = $('filmstrip');
    var fs = state.mobile && state.mobile.filmstrip;
    ol.replaceChildren();
    if (!fs || !fs.length) { wrap.hidden = true; return; }
    var used = {}, idxs = [];
    [500, 1000, 2000, 3000].forEach(function (target) {          // closest frame to each key moment
      var best = -1, bestD = Infinity;
      fs.forEach(function (fr, i) { var d = Math.abs(fr.timing - target); if (d < bestD && !used[i]) { bestD = d; best = i; } });
      if (best >= 0) { used[best] = true; idxs.push(best); }
    });
    var last = fs.length - 1;                                     // plus the final frame (3 s+ / fully loaded)
    if (!used[last]) idxs.push(last);
    idxs.sort(function (a, b) { return a - b; });
    idxs.forEach(function (i) {
      var fr = fs[i];
      if (typeof fr.data !== 'string' || fr.data.indexOf('data:image/') !== 0) return;
      var secs = (fr.timing / 1000).toFixed(1) + ' s';
      var li = el('li', fr.timing > LCP_TARGET_S * 1000 ? 'late' : '');
      var fig = el('figure', '');
      var img = el('img'); img.src = fr.data; img.alt = 'Your page ' + secs + ' into loading'; img.loading = 'lazy'; img.decoding = 'async';
      fig.appendChild(img);
      fig.appendChild(el('figcaption', '', secs));
      li.appendChild(fig);
      ol.appendChild(li);
    });
    wrap.hidden = !ol.children.length;
  }

  /* ---------- final render ---------- */
  function headline(score) {
    if (score == null) return 'Here is what we could measure.';
    if (score >= 90) return 'Your site is in good shape, with a few things to polish.';
    if (score >= 70) return 'Solid foundation, but fixable issues are holding it back.';
    if (score >= 50) return 'Real problems that visitors and Google will notice.';
    return 'Your site needs attention and is likely losing visitors.';
  }

  function renderFinal(r) {
    $('summary').classList.remove('is-loading');
    var score = r.overall;
    var ring = $('ring');
    ring.style.setProperty('--p', score == null ? 0 : score);
    ring.style.setProperty('--c', score == null ? '#64748b' : score >= 90 ? '#34d399' : score >= 50 ? '#fbbf24' : '#f87171');
    $('ring-num').textContent = score == null ? 'n/a' : score;
    ring.setAttribute('aria-label', 'Overall score ' + (score == null ? 'unavailable' : score + ' out of 100'));
    $('results-title').textContent = headline(score);
    var f = r.findings || [];
    var highs = f.filter(function (x) { return x.sev === 'high'; }).length;
    $('results-subtitle').textContent = r.host + ' · overall score' + (score == null ? ' unavailable' : ' ' + score + '/100') + ' · ' + f.length + ' finding' + (f.length === 1 ? '' : 's');
    $('print-header').textContent = 'MS Labs Studio · Free Website Check · ' + r.host + ' · ' + new Date().toLocaleDateString();

    renderFindings(r);
    renderImpact();
    renderFilmstrip();

    $('wp-link').hidden = !(r.page && r.page.isWordPress);
    $('cta-block').hidden = false;
    $('compare-card').hidden = false;
    $('tech-details').hidden = false;

    var q = '?from=free-check&site=' + encodeURIComponent(r.host) + (score != null ? '&score=' + score : '') + '&issues=' + f.length;
    document.querySelectorAll('[data-cta]').forEach(function (a) {
      if (a.tagName === 'A' && a.getAttribute('data-cta') !== 'wp-care') a.href = CONTACT_URL + q + '#contact';
    });
    $('sticky-text').textContent = highs ? highs + ' issue' + (highs > 1 ? 's' : '') + ' to fix first' : 'Want help with these?';
    $('sticky-cta').classList.add('show');
  }

  function render() { renderCards(); renderDetails(); renderImpact(); renderFilmstrip(); }

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
      case 'links': state.files = ev.files; state.links = ev.links; state.mail = ev.mail || null; setStep('links', 'done'); break;
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
        track('audit_completed', { overall: state.overall, wordpress: !!(state.page && state.page.isWordPress), site: state.host });
        return;
      case 'fatal': throw new Error(ev.message);
    }
    results.hidden = false;
    render();
    if (!handle.scrolled) { handle.scrolled = true; results.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }

  function utm() {
    var out = {}, p = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'].forEach(function (k) { if (p.get(k)) out[k] = p.get(k); });
    return out;
  }

  function invalid(input, msg) {
    input.setAttribute('aria-invalid', 'true'); input.focus(); setStatus(msg, 'error');
  }

  async function runCheck() {
    if (submitBtn.disabled) return;
    ['check-url', 'check-email'].forEach(function (id) { $(id).removeAttribute('aria-invalid'); });
    var rawUrl = $('check-url').value.trim(), email = $('check-email').value.trim(), name = $('check-name').value.trim();

    if (!rawUrl) return invalid($('check-url'), 'Please enter your website address.');
    var parsed;
    try { parsed = new URL(/^https?:\/\//i.test(rawUrl) ? rawUrl : 'https://' + rawUrl); }
    catch (e) { return invalid($('check-url'), 'That doesn\'t look like a website address. Try something like example.com.'); }
    if (!$('check-email').validity.valid || !email) return invalid($('check-email'), 'Please enter a valid email so we can send follow-up notes.');

    submitBtn.disabled = true;
    setStatus('');
    var token = ''; // Turnstile disabled for testing

    state = {}; handle.scrolled = true;
    ['cta-block', 'compare-card', 'tech-details', 'filmstrip-wrap'].forEach(function (id) { $(id).hidden = true; });
    $('tech-details').open = false;
    $('cmp-result').hidden = true; $('cmp-result').replaceChildren(); $('cmp-status').textContent = '';
    $('sticky-cta').classList.remove('show');
    document.querySelectorAll('#steps li').forEach(function (li) { li.setAttribute('data-s', 'run'); });
    $('progress-fill').style.width = '6%';
    progress.hidden = false;
    setSummaryLoading(parsed.hostname);
    results.hidden = false;                 // show the skeleton layout immediately: nothing "pops in" later
    render();
    skeleton($('top-fixes'), 3);
    setStatus('Analyzing ' + parsed.hostname + '…');
    results.scrollIntoView({ behavior: 'smooth', block: 'start' });
    track('audit_started', { site: parsed.hostname });

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
      saveContact(email, name);
    } catch (e) {
      progress.hidden = true;
      var msg = e && e.name === 'AbortError' ? 'The check took too long. Please try again, or email us and we\'ll run it manually.' : (e.message || 'Could not reach the check service.');
      if (state && (state.mobile || state.page)) {
        $('summary').classList.remove('is-loading');
        $('results-title').textContent = 'Partial results';
        $('results-subtitle').textContent = 'Some tests did not finish. You can run the check again for the full report.';
        $('tech-details').hidden = false;
        results.hidden = false;
      } else {
        results.hidden = true;
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      setStatus(msg, 'error');
      track('audit_failed');
    } finally {
      clearTimeout(timer);
      submitBtn.disabled = false;
    }
  }
  form.addEventListener('submit', function (event) { event.preventDefault(); runCheck(); });

  /* ---------- impact inputs ---------- */
  ['imp-visitors', 'imp-conv', 'imp-value'].forEach(function (id) { $(id).addEventListener('input', renderImpact); });

  /* ---------- save as PDF ---------- */
  var reopen = [];
  window.addEventListener('beforeprint', function () {   // expand collapsed sections so the PDF contains everything
    reopen = [];
    document.querySelectorAll('#results details').forEach(function (d) { if (!d.open) { reopen.push(d); d.open = true; } });
  });
  window.addEventListener('afterprint', function () {
    reopen.forEach(function (d) { d.open = false; }); reopen = [];
  });
  $('save-pdf').addEventListener('click', function () {
    track('pdf_saved', { site: state.host || '' });
    window.print();
  });

  /* ---------- share with developer ---------- */
  function shareUrl() {
    var target = state.url || state.host || $('check-url').value.trim();
    if (!target) return '';
    return SHARE_BASE + '?url=' + encodeURIComponent(target);
  }
  $('share-dev').addEventListener('click', async function () {
    var url = shareUrl(); if (!url) return;
    try { await navigator.clipboard.writeText(url); toast('Link copied. Send it to your developer.'); }
    catch (e) { window.prompt('Copy this link:', url); }
    track('report_shared', { site: state.host || '' });
  });

  /* ---------- competitor comparison ---------- */
  function cmpSide(who, score, lead) {
    var s = el('div', 'cmp-side' + (lead ? ' lead' : ''));
    s.appendChild(el('div', 'who', who));
    s.appendChild(el('div', 'num ' + rateScore(score), score == null ? 'n/a' : String(score)));
    s.appendChild(el('div', 'check-note', 'Overall score'));
    return s;
  }

  function renderCompare(c) {
    var box = $('cmp-result'); box.replaceChildren();
    var mine = state.overall, theirs = c.overall;
    var youLead = mine != null && theirs != null && mine > theirs, tie = mine === theirs;

    var versus = el('div', 'cmp-versus');
    versus.appendChild(cmpSide('Your Site', mine, youLead));
    versus.appendChild(el('div', 'cmp-vs', 'vs'));
    versus.appendChild(cmpSide('Competitor', theirs, mine != null && theirs != null && theirs > mine));
    box.appendChild(versus);

    var verdict;
    if (mine == null || theirs == null) verdict = 'We couldn\'t score one of the sites, so a direct comparison isn\'t possible.';
    else if (tie) verdict = 'You\'re neck and neck with ' + c.host + '.';
    else if (youLead) verdict = 'You\'re ' + (mine - theirs) + ' point' + (mine - theirs > 1 ? 's' : '') + ' ahead of ' + c.host + '. Worth protecting that lead.';
    else verdict = c.host + ' is ' + (theirs - mine) + ' point' + (theirs - mine > 1 ? 's' : '') + ' ahead of you. Closing that gap is a good use of the 3 fixes above.';
    box.appendChild(el('p', 'cmp-verdict', verdict));

    var mm = (state.mobile && state.mobile.scores) || {}, cs = c.scores || {};
    var rows = [['Mobile speed', mm.performance, cs.performance], ['SEO basics', mm.seo, cs.seo], ['Accessibility', mm.accessibility, cs.accessibility], ['Best practices', mm.bestPractices, cs.bestPractices]];
    var table = el('table', 'cmp-table');
    var head = el('thead'), hr = el('tr');
    ['', 'You', c.host].forEach(function (t) { hr.appendChild(el('th', '', t)); });
    head.appendChild(hr); table.appendChild(head);
    var body = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      tr.appendChild(el('td', '', r[0]));
      tr.appendChild(el('td', '', r[1] == null ? 'n/a' : String(r[1])));
      tr.appendChild(el('td', '', r[2] == null ? 'n/a' : String(r[2])));
      body.appendChild(tr);
    });
    table.appendChild(body); box.appendChild(table);
    box.hidden = false;
  }

  $('cmp-form').addEventListener('submit', async function (event) {
    event.preventDefault();
    var btn = $('cmp-submit'), st = $('cmp-status'), input = $('cmp-url');
    if (btn.disabled) return;
    var raw = input.value.trim();
    function fail(msg) { st.textContent = msg; st.className = 'form-status cmp-status is-error'; }
    st.className = 'form-status cmp-status'; st.textContent = '';
    if (!raw) { fail('Please enter your competitor\'s website address.'); input.focus(); return; }
    var u; try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (e) { fail('That doesn\'t look like a website address. Try something like competitor.com.'); input.focus(); return; }
    if (u.hostname.indexOf('.') < 0) { fail('That doesn\'t look like a website address. Try something like competitor.com.'); input.focus(); return; }
    if (state.host && u.hostname.replace(/^www\./, '') === String(state.host).replace(/^www\./, '')) { fail('That\'s your own site. Enter a competitor\'s address.'); input.focus(); return; }

    btn.disabled = true; btn.textContent = 'Scanning…';
    st.textContent = 'Scanning ' + u.hostname + '… this takes about 20–30 seconds.';
    $('cmp-result').hidden = true;
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, COMPARE_TIMEOUT_MS);
    try {
      var res = await fetch(API_BASE + '/api/compare', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ url: raw })
      });
      var j = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(j.error || 'Server error (' + res.status + ')');
      st.textContent = '';
      renderCompare(j);
      track('competitor_compared', { you: state.overall, competitor: j.overall, competitor_host: j.host });
    } catch (e) {
      fail(e && e.name === 'AbortError' ? 'The scan took too long. Please try again.' : (e.message || 'Could not reach the comparison service.'));
    } finally {
      clearTimeout(timer); btn.disabled = false; btn.textContent = 'Compare Scores';
    }
  });

  /* ---------- remembered contact + shareable-link auto-run ---------- */
  var LS_KEY = 'mslabs_check_contact';
  function loadContact() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; } }
  function saveContact(email, name) { try { localStorage.setItem(LS_KEY, JSON.stringify({ email: email, name: name })); } catch (e) { /* storage may be blocked */ } }

  function init() {
    var saved = loadContact();
    if (saved) {
      if (saved.email && !$('check-email').value) $('check-email').value = saved.email;
      if (saved.name && !$('check-name').value) $('check-name').value = saved.name;
    }
    var raw = (new URLSearchParams(location.search).get('url') || '').trim().slice(0, 2048);
    if (!raw) return;
    var u;
    try { u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); } catch (e) { return; }
    if (!/^https?:$/.test(u.protocol) || u.hostname.indexOf('.') < 0) return;   // light check; the Worker does the strict SSRF validation
    $('check-url').value = raw;
    track('share_link_opened');
    if (saved && saved.email && $('check-email').validity.valid) {
      setTimeout(runCheck, 0);                                  // auto-run for returning visitors
    } else {
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setStatus('Enter your email to run the check for ' + u.hostname + '.');
      $('check-email').focus({ preventScroll: true });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('[data-cta]');
    if (a) track('cta_clicked', { cta: a.getAttribute('data-cta'), site: state.host || '' });
  });
})();
