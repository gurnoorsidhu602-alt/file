/* ਸਿਹਤ ਦੀ ਸਮਝ — Punjabi patient-education site.
   Pure static: data/*.js push articles into window.SEHAT; this file renders
   the home list, search and article pages with hash routing (#/article-id). */
(function () {
  'use strict';
  const S = window.SEHAT;
  const app = document.getElementById('app');
  const DIGITS = '੦੧੨੩੪੫੬੭੮੯';
  const paNum = (n) => String(n).replace(/\d/g, (d) => DIGITS[d]);

  const SECTIONS = [
    ['what', 'ਇਹ ਰੋਗ ਕੀ ਹੈ?'],
    ['why', 'ਇਹ ਕਿਉਂ ਹੁੰਦਾ ਹੈ?'],
    ['symptoms', 'ਲੱਛਣ — ਕੀ ਮਹਿਸੂਸ ਹੁੰਦਾ ਹੈ?'],
    ['diagnosis', 'ਪਛਾਣ ਕਿਵੇਂ ਹੁੰਦੀ ਹੈ?'],
    ['treatment', 'ਇਲਾਜ — ਅਤੇ ਹਰ ਇਲਾਜ ਕਿਵੇਂ ਮਦਦ ਕਰਦਾ ਹੈ'],
    ['help', 'ਮਦਦ ਕਦੋਂ ਲਵੋ?'],
  ];

  if (S.draft) document.getElementById('draftBanner').hidden = false;

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Normalise for search: lower-case; drop nukta, addak, tippi, bindi, virama
  // and the bindi-like marks so ਸ਼ੂਗਰ / ਸੂਗਰ and ਖ਼ੂਨ / ਖੂਨ match; drop spaces & punctuation.
  const norm = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFC')
    .replace(/[਼ੱੰਂਁਃ੍]/g, '')
    .replace(/[\s.,;:!?'"()\-–—/]+/g, '');

  function blockText(b) {
    if (typeof b === 'string') return b;
    if (b.ul) return b.ul.join(' ');
    if (b.meds) return b.meds.map((m) => [m.name, m.ex, m.why, m.tip].join(' ')).join(' ');
    if (b.call911) return b.call911.join(' ');
    if (b.callDoc) return b.callDoc.join(' ');
    return b.note || b.h || '';
  }
  const specOf = (id) => S.specialties.find((s) => s.id === id) || { pa: id, en: id };

  S.articles.forEach((a) => {
    a._key = norm([a.title, a.en, ...(a.aka || []), ...(a.keywords || [])].join(' '));
    const body = [a.summary, ...(a.key || [])];
    SECTIONS.forEach(([k]) => (a.sections[k] || []).forEach((b) => body.push(blockText(b))));
    a._body = norm(body.join(' '));
  });

  function search(q) {
    const nq = norm(q);
    if (!nq) return null;
    return S.articles
      .map((a) => {
        let score = 0;
        if (norm(a.title).startsWith(nq) || norm(a.en).startsWith(nq)) score += 30;
        if (a._key.includes(nq)) score += 20;
        if (a._body.includes(nq)) score += 3;
        // multi-word query: every word somewhere
        const words = String(q).trim().split(/\s+/).map(norm).filter(Boolean);
        if (!score && words.length > 1 && words.every((w) => a._key.includes(w) || a._body.includes(w))) score += 2;
        return { a, score };
      })
      .filter((r) => r.score > 0)
      .sort((x, y) => y.score - x.score)
      .map((r) => r.a);
  }

  // ---------- state ----------
  let query = '';
  let spec = '';

  // ---------- views ----------
  function card(a) {
    return `<a class="card" href="#/${a.id}">
      <span class="en">${esc(a.en)}</span>
      <h3>${esc(a.title)}</h3>
      <p>${esc(a.summary)}</p>
      <span class="tag">${esc(specOf(a.specialty).pa)}</span>
    </a>`;
  }

  function renderHome() {
    document.title = 'ਸਿਹਤ ਦੀ ਸਮਝ — ਪੰਜਾਬੀ ਵਿੱਚ ਮਰੀਜ਼ਾਂ ਲਈ ਜਾਣਕਾਰੀ';
    app.innerHTML = `
      <section class="hero">
        <h1>ਆਪਣੇ ਰੋਗ ਬਾਰੇ ਪੜ੍ਹੋ</h1>
        <p>ਹਰ ਲੇਖ ਦੱਸਦਾ ਹੈ ਕਿ ਰੋਗ ਕੀ ਹੈ, ਕਿਉਂ ਹੁੰਦਾ ਹੈ, ਇਸ ਦੇ ਲੱਛਣ, ਪਛਾਣ ਕਿਵੇਂ ਹੁੰਦੀ ਹੈ, ਅਤੇ ਹਰ ਦਵਾਈ ਜਾਂ ਇਲਾਜ ਤੁਹਾਡੀ ਮਦਦ ਕਿਵੇਂ ਕਰਦਾ ਹੈ।</p>
        <label class="search">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input id="q" type="search" autocomplete="off" placeholder="ਰੋਗ ਲੱਭੋ — ਜਿਵੇਂ: ਸ਼ੂਗਰ, ਦਿਲ, ਬੀ.ਪੀ., heart failure" aria-label="ਰੋਗ ਲੱਭੋ" value="${esc(query)}" />
        </label>
        <p class="hint">ਪੰਜਾਬੀ ਜਾਂ ਅੰਗਰੇਜ਼ੀ ਵਿੱਚ ਲਿਖ ਸਕਦੇ ਹੋ। You can search in Punjabi or English.</p>
      </section>
      <div class="chips" role="group" aria-label="ਵਿਭਾਗ">
        <button class="chip" data-spec="" aria-pressed="${!spec}">ਸਾਰੇ</button>
        ${S.specialties.filter((s) => S.articles.some((a) => a.specialty === s.id))
          .map((s) => `<button class="chip" data-spec="${s.id}" aria-pressed="${spec === s.id}">${esc(s.pa)}</button>`).join('')}
      </div>
      <div id="results"></div>`;
    const input = document.getElementById('q');
    input.addEventListener('input', () => { query = input.value; renderResults(); });
    app.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
      spec = b.dataset.spec;
      app.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.spec === spec)));
      renderResults();
    }));
    renderResults();
  }

  function renderResults() {
    const box = document.getElementById('results');
    const hits = search(query);
    let list = hits || S.articles;
    if (spec) list = list.filter((a) => a.specialty === spec);
    if (!list.length) {
      box.innerHTML = `<p class="empty">ਕੋਈ ਲੇਖ ਨਹੀਂ ਲੱਭਿਆ। ਕੋਈ ਹੋਰ ਸ਼ਬਦ ਲਿਖ ਕੇ ਵੇਖੋ।<br><span class="en">No article found — try another word.</span></p>`;
      return;
    }
    if (hits) {
      box.innerHTML = `<section class="group"><h2>ਲੱਭੇ ਲੇਖ <span class="en">${paNum(list.length)}</span></h2><div class="cards">${list.map(card).join('')}</div></section>`;
      return;
    }
    box.innerHTML = S.specialties
      .map((s) => {
        const items = list.filter((a) => a.specialty === s.id);
        if (!items.length) return '';
        return `<section class="group"><h2>${esc(s.pa)} <span class="en">${esc(s.en)}</span></h2><div class="cards">${items.map(card).join('')}</div></section>`;
      })
      .join('');
  }

  function renderBlock(b) {
    if (typeof b === 'string') return `<p>${fmt(b)}</p>`;
    if (b.h) return `<h3>${fmt(b.h)}</h3>`;
    if (b.ul) return `<ul>${b.ul.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>`;
    if (b.note) return `<div class="note">${fmt(b.note)}</div>`;
    if (b.meds) {
      return b.meds.map((m) => `<div class="med">
        <h4>${fmt(m.name)}${m.ex ? `<span class="ex">${esc(m.ex)}</span>` : ''}</h4>
        <p>${fmt(m.why)}</p>
        ${m.tip ? `<p class="tip">${fmt(m.tip)}</p>` : ''}
      </div>`).join('');
    }
    if (b.call911) return `<div class="alert red"><h3>ਤੁਰੰਤ 911 ਉੱਤੇ ਫ਼ੋਨ ਕਰੋ ਜੇ:</h3><ul>${b.call911.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul></div>`;
    if (b.callDoc) return `<div class="alert amber"><h3>ਛੇਤੀ ਆਪਣੇ ਡਾਕਟਰ ਜਾਂ ਨਰਸ ਨਾਲ ਗੱਲ ਕਰੋ ਜੇ:</h3><ul>${b.callDoc.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul></div>`;
    return '';
  }

  function renderArticle(a) {
    document.title = `${a.title} — ਸਿਹਤ ਦੀ ਸਮਝ`;
    const sp = specOf(a.specialty);
    const present = SECTIONS.filter(([k]) => a.sections[k] && a.sections[k].length);
    app.innerHTML = `
      <a class="back" href="#/">← ਸਾਰੇ ਲੇਖ</a>
      <article>
        <header class="art-head">
          <div class="sp">${esc(sp.pa)}</div>
          <h1>${esc(a.title)}</h1>
          <div class="en">${esc(a.en)}</div>
          <p class="lead">${fmt(a.summary)}</p>
          <div class="art-actions">
            <button type="button" id="printBtn">🖨 ਛਾਪੋ</button>
            <button type="button" id="shareBtn">🔗 ਲਿੰਕ ਕਾਪੀ ਕਰੋ</button>
          </div>
        </header>
        ${a.key && a.key.length ? `<section class="key"><h2>ਮੁੱਖ ਗੱਲਾਂ</h2><ul>${a.key.map((k) => `<li>${fmt(k)}</li>`).join('')}</ul></section>` : ''}
        <nav class="toc" aria-label="ਲੇਖ ਦੇ ਹਿੱਸੇ">${present.map(([k, t]) => `<a href="#/${a.id}/${k}">${esc(t)}</a>`).join('')}</nav>
        ${present.map(([k, t], i) => `<section class="sec" id="sec-${k}">
            <h2><span class="n">${paNum(i + 1)}</span>${esc(t)}</h2>
            ${a.sections[k].map(renderBlock).join('')}
          </section>`).join('')}
        <p class="reviewed">${a.reviewed ? `ਪੜਤਾਲ: ${esc(a.reviewed)}` : 'ਡਾਕਟਰੀ ਪੜਤਾਲ ਬਾਕੀ ਹੈ (pending clinical review)'} · ${esc(a.en)}</p>
      </article>`;
    document.getElementById('printBtn').onclick = () => window.print();
    document.getElementById('shareBtn').onclick = (e) => {
      const url = location.href.split('#')[0] + '#/' + a.id;
      const done = () => { e.target.textContent = '✓ ਕਾਪੀ ਹੋ ਗਿਆ'; };
      if (navigator.clipboard) navigator.clipboard.writeText(url).then(done, () => prompt('', url));
      else prompt('', url);
    };
  }

  function route() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const a = parts[0] && S.articles.find((x) => x.id === parts[0]);
    if (a) {
      renderArticle(a);
      const target = parts[1] && document.getElementById('sec-' + parts[1]);
      if (target) target.scrollIntoView();
      else window.scrollTo(0, 0);
      app.focus({ preventScroll: true });
    } else {
      renderHome();
      window.scrollTo(0, 0);
    }
  }

  // ---------- toolbar ----------
  const root = document.documentElement;
  const setFont = (px) => {
    px = Math.max(15, Math.min(28, px));
    root.style.setProperty('--fs', px + 'px');
    try { localStorage.setItem('sehatFont', String(px)); } catch (e) { /* ignore */ }
  };
  const curFont = () => parseFloat(getComputedStyle(root).fontSize) || 19;
  document.getElementById('fontUp').onclick = () => setFont(curFont() + 2);
  document.getElementById('fontDown').onclick = () => setFont(curFont() - 2);
  document.getElementById('themeBtn').onclick = () => {
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    root.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* ignore */ }
  };

  window.addEventListener('hashchange', route);
  route();
})();
