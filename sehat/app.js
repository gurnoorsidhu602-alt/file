/* ਸਿਹਤ ਦੀ ਸਮਝ — Punjabi patient-education site.
   Pure static: data/*.js push articles into window.SEHAT; this file renders a
   layout modelled on the IM textbook: chapter tree, search results, articles
   with an "on this page" list and previous/next links.
   Routes: #/  ·  #/a/<id>[?s=<section>]  ·  #/search?q=<text>  (old #/<id> links still work) */
(function () {
  'use strict';
  const S = window.SEHAT;
  const $ = (id) => document.getElementById(id);
  const DIGITS = '੦੧੨੩੪੫੬੭੮੯';
  const paNum = (n) => String(n).replace(/\d/g, (d) => DIGITS[d]);
  const pad = (n) => String(n).padStart(2, '0');

  const SECTIONS = [
    ['what', 'ਇਹ ਰੋਗ ਕੀ ਹੈ?'],
    ['why', 'ਇਹ ਕਿਉਂ ਹੁੰਦਾ ਹੈ?'],
    ['symptoms', 'ਲੱਛਣ'],
    ['diagnosis', 'ਪਛਾਣ ਕਿਵੇਂ ਹੁੰਦੀ ਹੈ?'],
    ['treatment', 'ਇਲਾਜ ਅਤੇ ਇਹ ਕਿਵੇਂ ਕੰਮ ਕਰਦਾ ਹੈ'],
    ['help', 'ਮਦਦ ਕਦੋਂ ਲਵੋ?'],
  ];
  const SECTION_TITLE = Object.fromEntries(SECTIONS);

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const plain = (s) => String(s ?? '').replace(/\*\*/g, '');
  // Search normalisation: lower-case, drop nukta/addak/tippi/bindi/virama so
  // ਸ਼ੂਗਰ/ਸੂਗਰ and ਖ਼ੂਨ/ਖੂਨ match, and drop spaces and punctuation.
  const norm = (s) => String(s || '').toLowerCase().normalize('NFC')
    .replace(/[਼ੱੰਂਁਃ੍]/g, '')
    .replace(/[\s.,;:!?'"()\-–—/*]+/g, '');

  function blockText(b) {
    if (typeof b === 'string') return b;
    if (b.ul) return b.ul.join(' ');
    if (b.meds) return b.meds.map((m) => [m.name, m.ex, m.why, m.tip].filter(Boolean).join(' ')).join(' ');
    if (b.call911) return b.call911.join(' ');
    if (b.callDoc) return b.callDoc.join(' ');
    return b.like || b.note || b.h || '';
  }

  // ---------- data ----------
  const specs = S.specialties
    .map((s) => ({ ...s, articles: S.articles.filter((a) => a.specialty === s.id) }))
    .filter((s) => s.articles.length);
  const all = specs.flatMap((s) => s.articles);
  const specOf = (id) => specs.find((s) => s.id === id) || { pa: id, en: id, n: 0 };
  const byId = new Map(all.map((a) => [a.id, a]));

  all.forEach((a) => {
    a._terms = [a.title, a.short, a.en, ...(a.aka || []), ...(a.keywords || [])].filter(Boolean).map(norm);
    a._key = a._terms.join('|');
    a._units = [];
    const intro = [a.summary, ...(a.key || [])].join(' ');
    a._units.push({ sec: '', title: a.title, raw: plain(intro), n: norm(intro) });
    SECTIONS.forEach(([k, t]) => {
      const raw = plain((a.sections[k] || []).map(blockText).join(' '));
      if (raw) a._units.push({ sec: k, title: t, raw, n: norm(raw) });
    });
    a._chars = a._units.reduce((n, u) => n + u.raw.length, 0);
  });

  // ---------- read marks (this browser only) ----------
  let read = new Set();
  try { read = new Set(JSON.parse(localStorage.getItem('sehatRead') || '[]')); } catch (e) { /* ignore */ }
  const saveRead = () => { try { localStorage.setItem('sehatRead', JSON.stringify([...read])); } catch (e) { /* ignore */ } };

  // ---------- search ----------
  function search(q) {
    const nq = norm(q);
    if (!nq) return [];
    const words = String(q).trim().split(/\s+/).map(norm).filter(Boolean);
    const out = [];
    all.forEach((a) => {
      let best = null;
      let score = 0;
      if (a._terms.includes(nq)) score += 60;
      if (norm(a.title).startsWith(nq) || norm(a.en).startsWith(nq)) score += 40;
      if (a._key.includes(nq)) score += 25;
      // very short queries (e.g. "tb", "bp") only match names and keywords, not body text
      if (nq.length >= 3) a._units.forEach((u) => {
        let s = 0;
        if (u.n.includes(nq)) s = 6 + Math.min(4, u.n.split(nq).length - 2);
        else if (words.length > 1 && words.every((w) => u.n.includes(w))) s = 3;
        if (s && (!best || s > best.s)) best = { ...u, s };
      });
      if (best) score += best.s;
      if (score) out.push({ a, score, unit: best || a._units[0] });
    });
    return out.sort((x, y) => y.score - x.score);
  }
  function snippet(raw, q) {
    const terms = [String(q).trim(), ...String(q).trim().split(/\s+/)].filter((t) => t.length > 1);
    const low = raw.toLowerCase();
    let at = -1, term = '';
    for (const t of terms) { at = low.indexOf(t.toLowerCase()); if (at >= 0) { term = t; break; } }
    const start = Math.max(0, at - 70);
    let s = (start ? '…' : '') + raw.slice(start, start + 220) + (raw.length > start + 220 ? '…' : '');
    s = esc(s);
    if (term) s = s.replace(new RegExp(esc(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => `<mark>${m}</mark>`);
    return s;
  }

  // ---------- sidebar ----------
  let current = null;
  let openSpec = null;
  const artHref = (id, sec) => `#/a/${id}${sec ? '?s=' + sec : ''}`;

  function renderTree() {
    const done = all.filter((a) => read.has(a.id)).length;
    $('progress').textContent = done ? `${paNum(done)} ਪੜ੍ਹੇ` : '';
    $('count').textContent = `${paNum(all.length)} ਲੇਖ`;
    $('tree').innerHTML = specs.map((s) => {
      const r = s.articles.filter((a) => read.has(a.id)).length;
      const open = openSpec === s.id || s.articles.some((a) => a.id === current);
      return `<details ${open ? 'open' : ''} data-spec="${s.id}"><summary><span class="num">${pad(s.n)}</span><span class="name">${esc(s.pa)}</span><span class="count">${r}/${s.articles.length}</span></summary>
        ${s.articles.map((a) => `<a class="art-link ${read.has(a.id) ? 'read' : ''}" href="${artHref(a.id)}" ${a.id === current ? 'aria-current="page"' : ''}><span class="dot" aria-hidden="true"></span><span>${esc(a.short || a.title)}</span></a>`).join('')}</details>`;
    }).join('');
    $('tree').querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => { if (d.open) openSpec = d.dataset.spec; }));
    const cur = $('tree').querySelector('[aria-current="page"]');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }

  const FOOT = `<footer class="foot">
    <p><strong>ਜ਼ਰੂਰੀ:</strong> ਇਹ ਜਾਣਕਾਰੀ ਸਿਰਫ਼ ਸਮਝਣ ਲਈ ਹੈ। ਇਹ ਤੁਹਾਡੇ ਡਾਕਟਰ, ਨਰਸ ਜਾਂ ਫਾਰਮਾਸਿਸਟ ਦੀ ਸਲਾਹ ਦੀ ਥਾਂ ਨਹੀਂ ਲੈਂਦੀ। ਕੋਈ ਵੀ ਦਵਾਈ ਆਪਣੇ ਆਪ ਬੰਦ, ਸ਼ੁਰੂ ਜਾਂ ਘੱਟ-ਵੱਧ ਨਾ ਕਰੋ। ਦੇਸੀ ਦਵਾਈਆਂ, ਜੜੀ-ਬੂਟੀਆਂ ਅਤੇ ਤਾਕਤ ਦੀਆਂ ਗੋਲੀਆਂ ਬਾਰੇ ਵੀ ਆਪਣੇ ਡਾਕਟਰ ਨੂੰ ਦੱਸੋ।</p>
    <p><strong>ਐਮਰਜੈਂਸੀ ਵਿੱਚ 911 ਉੱਤੇ ਫ਼ੋਨ ਕਰੋ।</strong> ਬਹੁਤੇ ਸੂਬਿਆਂ ਵਿੱਚ 811 ਉੱਤੇ ਨਰਸ ਨਾਲ ਗੱਲ ਹੋ ਸਕਦੀ ਹੈ — ਤੁਸੀਂ ਪੰਜਾਬੀ ਦੁਭਾਸ਼ੀਏ ਦੀ ਮੰਗ ਕਰ ਸਕਦੇ ਹੋ।</p>
  </footer>`;

  // ---------- views ----------
  function renderHome() {
    current = null;
    document.title = 'ਸਿਹਤ ਦੀ ਸਮਝ — ਪੰਜਾਬੀ ਵਿੱਚ ਮਰੀਜ਼ਾਂ ਲਈ ਜਾਣਕਾਰੀ';
    $('page').innerHTML = `<div class="home">
      <h1>ਆਪਣੇ ਰੋਗ ਨੂੰ ਸਮਝੋ</h1>
      <p class="lede">ਹਰ ਲੇਖ ਸੌਖੀ ਪੰਜਾਬੀ ਵਿੱਚ ਦੱਸਦਾ ਹੈ ਕਿ ਰੋਗ ਕੀ ਹੈ, ਕਿਉਂ ਹੁੰਦਾ ਹੈ, ਇਸ ਦੇ ਲੱਛਣ ਅਤੇ ਪਛਾਣ, ਅਤੇ ਹਰ ਦਵਾਈ ਜਾਂ ਇਲਾਜ ਤੁਹਾਡੇ ਸਰੀਰ ਵਿੱਚ ਕੀ ਕੰਮ ਕਰਦਾ ਹੈ। ਖੱਬੇ ਪਾਸਿਓਂ ਵਿਭਾਗ ਖੋਲ੍ਹੋ, ਜਾਂ ਉੱਪਰ ਪੰਜਾਬੀ ਜਾਂ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ ਲੱਭੋ।</p>
      <div class="spec-list">${specs.map((s) => {
        const r = s.articles.filter((a) => read.has(a.id)).length;
        return `<a class="spec" href="${artHref(s.articles[0].id)}" data-open="${s.id}"><span class="n">${pad(s.n)}</span><span class="t">${esc(s.pa)}</span><span class="c">${paNum(s.articles.length)} ਲੇਖ</span><span class="s">${esc(s.en)}</span><span class="bar"><span style="width:${(r / s.articles.length) * 100}%"></span></span></a>`;
      }).join('')}</div>
      <div class="how">
        <div><b>ਮਿਸਾਲ ਨਾਲ ਸਮਝੋ</b>ਜਾਮਨੀ ਡੱਬਿਆਂ ਵਿੱਚ ਰੋਜ਼ ਦੀ ਜ਼ਿੰਦਗੀ ਦੀਆਂ ਮਿਸਾਲਾਂ ਹਨ — ਖਾਲ਼, ਪਾਈਪ, ਚਾਬੀ-ਜਿੰਦਾ।</div>
        <div><b>ਦਵਾਈ ਕਿਵੇਂ ਕੰਮ ਕਰਦੀ ਹੈ</b>ਹਰੀ ਲਕੀਰ ਵਾਲੇ ਡੱਬੇ ਦੱਸਦੇ ਹਨ ਕਿ ਹਰ ਦਵਾਈ ਕਿਉਂ ਦਿੱਤੀ ਜਾਂਦੀ ਹੈ ਅਤੇ ਕਿਵੇਂ ਲੈਣੀ ਹੈ।</div>
        <div><b>ਮਦਦ ਕਦੋਂ ਲਵੋ</b>ਲਾਲ ਡੱਬਾ: ਤੁਰੰਤ 911। ਪੀਲਾ ਡੱਬਾ: ਛੇਤੀ ਡਾਕਟਰ ਨਾਲ ਗੱਲ ਕਰੋ।</div>
      </div>
      ${FOOT}</div>`;
    $('page').querySelectorAll('[data-open]').forEach((l) => (l.onclick = () => { openSpec = l.dataset.open; }));
    renderTree();
  }

  function renderBlock(b) {
    if (typeof b === 'string') return `<p>${fmt(b)}</p>`;
    if (b.h) return `<h3>${fmt(b.h)}</h3>`;
    if (b.ul) return `<ul>${b.ul.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>`;
    if (b.like) return `<div class="like"><span class="lbl">ਮਿਸਾਲ ਨਾਲ ਸਮਝੋ</span>${fmt(b.like)}</div>`;
    if (b.note) return `<div class="note">${fmt(b.note)}</div>`;
    if (b.meds) {
      return b.meds.map((m) => `<div class="med"><h4>${fmt(m.name)}${m.ex ? `<span class="ex">${esc(m.ex)}</span>` : ''}</h4><p>${fmt(m.why)}</p>${m.tip ? `<p class="tip">${fmt(m.tip)}</p>` : ''}</div>`).join('');
    }
    if (b.call911) return `<div class="alert red"><h3>ਤੁਰੰਤ 911 ਉੱਤੇ ਫ਼ੋਨ ਕਰੋ ਜੇ:</h3><ul>${b.call911.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul></div>`;
    if (b.callDoc) return `<div class="alert amber"><h3>ਛੇਤੀ ਆਪਣੇ ਡਾਕਟਰ ਜਾਂ ਨਰਸ ਨਾਲ ਗੱਲ ਕਰੋ ਜੇ:</h3><ul>${b.callDoc.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul></div>`;
    return '';
  }

  let tocObserver = null;
  function renderArticle(a, sec) {
    current = a.id;
    openSpec = a.specialty;
    renderTree();
    const sp = specOf(a.specialty);
    const i = all.indexOf(a);
    const prev = all[i - 1], next = all[i + 1];
    const present = SECTIONS.filter(([k]) => a.sections[k] && a.sections[k].length);
    const minutes = Math.max(2, Math.round(a._chars / 900));
    const isRead = read.has(a.id);
    document.title = `${a.title} — ਸਿਹਤ ਦੀ ਸਮਝ`;
    $('page').innerHTML = `<div class="article-grid"><article>
        <div class="art-head"><div class="crumbs"><a href="#/">ਸਾਰੇ ਲੇਖ</a> / <a href="${artHref(sp.articles[0].id)}">${pad(sp.n)} ${esc(sp.pa)}</a></div>
          <h1>${esc(a.title)}</h1><div class="en">${esc(a.en)}</div></div>
        <div class="art-meta"><span>ਲਗਭਗ ${paNum(minutes)} ਮਿੰਟ ਪੜ੍ਹਨ ਲਈ</span><span class="spacer"></span>
          <button class="btn" id="btnPrint" type="button">ਛਾਪੋ</button>
          <button class="btn" id="btnLink" type="button">ਲਿੰਕ ਕਾਪੀ ਕਰੋ</button>
          <button class="btn ${isRead ? '' : 'primary'}" id="btnRead" type="button" aria-pressed="${isRead}">${isRead ? '✓ ਪੜ੍ਹ ਲਿਆ' : 'ਪੜ੍ਹ ਲਿਆ'}</button></div>
        <div class="prose" id="prose">
          <p class="lead">${fmt(a.summary)}</p>
          ${a.key && a.key.length ? `<section class="key"><h2>ਮੁੱਖ ਗੱਲਾਂ</h2><ul>${a.key.map((k) => `<li>${fmt(k)}</li>`).join('')}</ul></section>` : ''}
          ${present.map(([k, t], j) => `<h2 id="sec-${k}"><span class="n">${paNum(j + 1)}</span>${esc(t)}</h2>${a.sections[k].map(renderBlock).join('')}`).join('')}
          <p class="reviewed">${a.reviewed ? 'ਪੜਤਾਲ: ' + esc(a.reviewed) : 'ਡਾਕਟਰੀ ਪੜਤਾਲ ਬਾਕੀ ਹੈ · pending clinical review'}</p>
        </div>
        <nav class="pager" aria-label="ਪਿਛਲਾ ਅਤੇ ਅਗਲਾ ਲੇਖ">${prev ? `<a href="${artHref(prev.id)}"><span class="lbl">← ਪਿਛਲਾ</span>${esc(prev.short || prev.title)}</a>` : '<span></span>'}${next ? `<a class="next" href="${artHref(next.id)}"><span class="lbl">ਅਗਲਾ${next.specialty !== a.specialty ? ', ' + esc(specOf(next.specialty).pa) : ''} →</span>${esc(next.short || next.title)}</a>` : '<span></span>'}</nav>
        ${FOOT}
      </article>
      <nav class="toc" aria-label="ਇਸ ਪੰਨੇ ਉੱਤੇ"><h2>ਇਸ ਪੰਨੇ ਉੱਤੇ</h2>${present.map(([k, t]) => `<a href="${artHref(a.id, k)}" data-anchor="sec-${k}">${esc(t)}</a>`).join('')}</nav></div>`;

    $('btnPrint').onclick = () => window.print();
    $('btnLink').onclick = (e) => {
      const url = location.href.split('#')[0] + artHref(a.id);
      const done = () => { e.target.textContent = '✓ ਕਾਪੀ ਹੋ ਗਿਆ'; };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('', url));
      else prompt('', url);
    };
    $('btnRead').onclick = () => {
      read.has(a.id) ? read.delete(a.id) : read.add(a.id);
      saveRead();
      const on = read.has(a.id);
      const b = $('btnRead'); b.textContent = on ? '✓ ਪੜ੍ਹ ਲਿਆ' : 'ਪੜ੍ਹ ਲਿਆ'; b.className = 'btn ' + (on ? '' : 'primary'); b.setAttribute('aria-pressed', String(on));
      renderTree();
    };
    $('page').querySelectorAll('.toc a').forEach((l) => (l.onclick = (e) => { e.preventDefault(); history.replaceState(null, '', l.getAttribute('href')); jumpTo(l.dataset.anchor); }));

    if (sec) jumpTo('sec-' + sec, true); else { $('main').scrollTop = 0; window.scrollTo(0, 0); }

    if (tocObserver) tocObserver.disconnect();
    const links = new Map([...$('page').querySelectorAll('.toc a')].map((l) => [l.dataset.anchor, l]));
    if (links.size && 'IntersectionObserver' in window) {
      const mobile = getComputedStyle($('main')).overflow === 'visible';
      tocObserver = new IntersectionObserver((entries) => {
        const vis = entries.filter((e) => e.isIntersecting).sort((x, y) => x.boundingClientRect.top - y.boundingClientRect.top)[0];
        if (vis && links.has(vis.target.id)) { links.forEach((l) => l.classList.remove('active')); links.get(vis.target.id).classList.add('active'); }
      }, { root: mobile ? null : $('main'), rootMargin: '0px 0px -70% 0px' });
      $('prose').querySelectorAll('h2[id]').forEach((h) => tocObserver.observe(h));
    }
  }
  function jumpTo(anchor, flash) {
    const el = document.getElementById(anchor);
    if (!el) return;
    el.scrollIntoView({ behavior: flash ? 'auto' : 'smooth', block: 'start' });
    if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  }

  function renderSearch(q) {
    current = null;
    renderTree();
    $('q').value = q;
    if (!q.trim()) return renderHome();
    const res = search(q);
    document.title = `“${q}” — ਸਿਹਤ ਦੀ ਸਮਝ`;
    $('page').innerHTML = `<div class="results"><h1>“${esc(q)}” ਲਈ ਨਤੀਜੇ</h1><p class="muted" style="margin-bottom:10px">${res.length ? `${paNum(res.length)} ਲੇਖ ਲੱਭੇ` : ''}</p>
      ${res.length ? res.slice(0, 40).map((r) => `<a class="result" href="${artHref(r.a.id, r.unit.sec)}"><div class="rp">${pad(specOf(r.a.specialty).n)} ${esc(specOf(r.a.specialty).pa)} · <span class="en">${esc(r.a.en)}</span></div><div class="rt">${esc(r.a.title)}${r.unit.sec ? ` <span class="muted">— ${esc(SECTION_TITLE[r.unit.sec])}</span>` : ''}</div><div class="snip">${snippet(r.unit.raw, q)}</div></a>`).join('')
        : '<p class="empty">ਕੁਝ ਨਹੀਂ ਲੱਭਿਆ। ਕੋਈ ਹੋਰ ਸ਼ਬਦ ਵਰਤ ਕੇ ਵੇਖੋ — ਪੰਜਾਬੀ ਜਾਂ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ।<br><span class="en">Nothing matched. Try another word in Punjabi or English.</span></p>'}
      ${FOOT}</div>`;
    $('main').scrollTop = 0;
  }

  // ---------- routing ----------
  function route() {
    document.body.classList.remove('menu-open');
    $('menuBtn').setAttribute('aria-expanded', 'false');
    const h = decodeURIComponent(location.hash || '#/');
    let m = h.match(/^#\/a\/([^?/]+)(?:\?s=(\w+))?$/);
    if (!m) { const old = h.match(/^#\/([a-z0-9-]+)(?:\/(\w+))?$/); if (old && byId.has(old[1])) m = [null, old[1], old[2]]; }
    if (m && byId.has(m[1])) return renderArticle(byId.get(m[1]), m[2]);
    m = h.match(/^#\/search\?q=(.*)$/);
    if (m) return renderSearch(m[1]);
    renderHome();
    $('main').scrollTop = 0;
  }
  window.addEventListener('hashchange', route);
  $('searchForm').addEventListener('submit', (e) => { e.preventDefault(); location.hash = '#/search?q=' + encodeURIComponent($('q').value.trim()); });
  let typing;
  $('q').addEventListener('input', () => {
    clearTimeout(typing);
    const v = $('q').value.trim();
    typing = setTimeout(() => {
      if (v.length >= 2) { history.replaceState(null, '', '#/search?q=' + encodeURIComponent(v)); renderSearch(v); }
      else if (!v && /^#\/search/.test(location.hash)) { history.replaceState(null, '', '#/'); renderHome(); }
    }, 250);
  });
  document.addEventListener('keydown', (e) => { if (e.key === '/' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('q').focus(); } });

  // ---------- app bar ----------
  const root = document.documentElement;
  const setFont = (px) => { px = Math.max(14, Math.min(26, px)); root.style.setProperty('--fs', px + 'px'); try { localStorage.setItem('sehatFont2', String(px)); } catch (e) { /* ignore */ } };
  const curFont = () => parseFloat(getComputedStyle(root).getPropertyValue('--fs')) || 17;
  $('fontUp').onclick = () => setFont(curFont() + 2);
  $('fontDown').onclick = () => setFont(curFont() - 2);
  const themeLabel = () => { $('themeBtn').querySelector('.label').textContent = root.dataset.theme === 'dark' ? 'ਹਨੇਰਾ' : 'ਰੌਸ਼ਨੀ'; };
  $('themeBtn').onclick = () => { root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark'; try { localStorage.setItem('theme', root.dataset.theme); } catch (e) { /* ignore */ } themeLabel(); };
  themeLabel();
  $('menuBtn').onclick = () => { const open = document.body.classList.toggle('menu-open'); $('menuBtn').setAttribute('aria-expanded', String(open)); };
  document.addEventListener('click', (e) => { if (document.body.classList.contains('menu-open') && !e.target.closest('#side, #menuBtn')) document.body.classList.remove('menu-open'); });

  if (S.draft) {
    $('draftBanner').hidden = false;
    const setH = () => root.style.setProperty('--draft-h', $('draftBanner').offsetHeight + 'px');
    setH(); window.addEventListener('resize', setH);
  }
  route();
})();
