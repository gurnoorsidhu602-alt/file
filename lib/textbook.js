// lib/textbook.js
// Internal Medicine textbook built from the Google Docs in the
// "IM Textbook Project" Drive folder.
//
//   Drive doc ("01 Cardiology")  -> subspecialty
//   highest heading below H1     -> article (topic)
//   next heading levels          -> sections / subsections inside the article
//
// Documents are fetched with the Docs API (structured JSON), rendered to safe
// HTML (all text escaped, only http(s) links), split into articles, and indexed
// for search at section level. Parsed docs are cached in Postgres when
// available (else on local disk) and refreshed on a schedule, re-fetching only
// documents whose modifiedTime changed.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { hasPg, q } from './db.js';
import { listDocs, getDocument, downloadImage, serviceAccount } from './googleDrive.js';
import { buildOutline, splitTopics, aliasesFor } from './textbookStructure.js';
import { buildSearchIndex, searchIndex } from './textbookSearch.js';
export { tokenize } from './textbookSearch.js';

const FOLDER_ID = process.env.TEXTBOOK_FOLDER_ID || '1t0bYnZYZXOb8NsqZ8Eo2i4XLUf0UrCjc';
const CACHE_DIR = process.env.TEXTBOOK_CACHE_DIR || path.join(process.cwd(), '.textbook-cache');
const SYNC_MINUTES = Number(process.env.TEXTBOOK_SYNC_MINUTES || 360);
export const PARSER_VERSION = 4; // bump to force re-parse of cached docs

// ------------------------------- rendering ----------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'section';
const HEADING = { TITLE: 1, HEADING_1: 1, HEADING_2: 2, HEADING_3: 3, HEADING_4: 4, HEADING_5: 5, HEADING_6: 6 };
const ORDERED_GLYPHS = /DECIMAL|ALPHA|ROMAN|ZERO_DECIMAL/;

function runsToHtml(elements, ctx) {
  let html = '', text = '';
  for (const el of elements || []) {
    if (el.textRun) {
      const raw = String(el.textRun.content || '').replace(/\n$/, '').replace(/\u000b/g, '\n');
      if (!raw) continue;
      text += raw;
      const st = el.textRun.textStyle || {};
      let h = esc(raw).replace(/\n/g, '<br>');
      if (st.baselineOffset === 'SUPERSCRIPT') h = `<sup>${h}</sup>`;
      else if (st.baselineOffset === 'SUBSCRIPT') h = `<sub>${h}</sub>`;
      if (st.bold) h = `<strong>${h}</strong>`;
      if (st.italic) h = `<em>${h}</em>`;
      const url = st.link?.url;
      if (url && /^https?:\/\//i.test(url)) h = `<a href="${esc(url)}" target="_blank" rel="noopener">${h}</a>`;
      html += h;
    } else if (el.inlineObjectElement) {
      const img = ctx.image(el.inlineObjectElement.inlineObjectId);
      if (img) html += `<img src="${esc(img.src)}" alt="${esc(img.alt)}" loading="lazy">`;
    } else if (el.footnoteReference) {
      html += `<sup>${esc(el.footnoteReference.footnoteNumber || '')}</sup>`;
    }
  }
  return { html: html.replace(/(<br>)+$/, ''), text: text.trim() };
}

// Flattens a document body into blocks: headings and HTML chunks (paragraphs,
// lists grouped with nesting, tables).
function bodyToBlocks(content, ctx, out = []) {
  let list = null; // { listId, html stack }
  const closeList = () => {
    if (!list) return;
    while (list.stack.length) { list.html += `</li></${list.stack.pop()}>`; }
    out.push({ type: 'html', html: list.html, text: list.text });
    list = null;
  };
  for (const item of content || []) {
    if (item.paragraph) {
      const p = item.paragraph;
      const { html, text } = runsToHtml(p.elements, ctx);
      const style = p.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
      if (p.bullet) {
        const level = Number(p.bullet.nestingLevel || 0);
        const listDef = ctx.lists?.[p.bullet.listId]?.listProperties?.nestingLevels?.[level] || {};
        const tag = ORDERED_GLYPHS.test(listDef.glyphType || '') ? 'ol' : 'ul';
        if (!list || list.listId !== p.bullet.listId && level === 0) { closeList(); list = { listId: p.bullet.listId, html: '', text: '', stack: [] }; }
        while (list.stack.length > level + 1) list.html += `</li></${list.stack.pop()}>`;
        if (list.stack.length === level + 1) list.html += '</li>';
        while (list.stack.length < level + 1) { list.html += `<${tag}>`; list.stack.push(tag); }
        list.html += `<li>${html}`;
        list.text += ' ' + text;
        continue;
      }
      closeList();
      if (!text && !html) continue;
      const level = HEADING[style];
      if (level) out.push({ type: 'heading', level, text: text || '' });
      else if (style === 'SUBTITLE') out.push({ type: 'html', html: `<p class="subtitle">${html}</p>`, text });
      else out.push({ type: 'html', html: `<p>${html}</p>`, text });
    } else if (item.table) {
      closeList();
      let html = '<div class="table-wrap"><table>', text = '';
      (item.table.tableRows || []).forEach((row, ri) => {
        html += '<tr>';
        for (const cell of row.tableCells || []) {
          const inner = bodyToBlocks(cell.content, ctx, []);
          const cellHtml = inner.map(b => b.type === 'heading' ? `<p><strong>${esc(b.text)}</strong></p>` : b.html).join('');
          text += ' ' + inner.map(b => b.text).join(' ');
          const tag = ri === 0 && item.table.rows > 1 && looksLikeHeaderRow(row) ? 'th' : 'td';
          html += `<${tag}>${cellHtml}</${tag}>`;
        }
        html += '</tr>';
      });
      html += '</table></div>';
      out.push({ type: 'html', html, text });
    }
    // sectionBreak and tableOfContents are skipped.
  }
  closeList();
  return out;
}

function looksLikeHeaderRow(row) {
  return (row.tableCells || []).every(c => (c.content || []).every(p => (p.paragraph?.elements || []).every(e => !e.textRun || e.textRun.textStyle?.bold || !String(e.textRun.content || '').trim())));
}

function flattenTabs(doc) {
  if (doc.body) return [{ body: doc.body, lists: doc.lists, inlineObjects: doc.inlineObjects }];
  const out = [];
  const walk = (tabs) => {
    for (const t of tabs || []) {
      const d = t.documentTab;
      if (d?.body) out.push({ body: d.body, lists: d.lists, inlineObjects: d.inlineObjects, title: t.tabProperties?.title });
      walk(t.childTabs);
    }
  };
  walk(doc.tabs);
  return out;
}

// "01 Cardiology" -> { order: 1, title: "Cardiology" }
export function specialtyFromName(name) {
  const m = String(name || '').match(/^\s*(\d+)\s*[-._)]?\s*(.+)$/);
  return m ? { order: Number(m[1]), title: m[2].trim() } : { order: 999, title: String(name || '').trim() };
}

// Turns a fetched document into { specialty, order, outline, articles[] }.
// Articles are topics and group overview pages (see textbookStructure.js);
// `outline` is the nested group/topic tree used for navigation.
export function parseDocument(doc, meta, imageFor = () => null) {
  const { order, title: specialty } = specialtyFromName(meta.name || doc.title);
  const blocks = [];
  for (const tab of flattenTabs(doc)) {
    const ctx = {
      lists: tab.lists,
      image: (objId) => {
        const emb = tab.inlineObjects?.[objId]?.inlineObjectProperties?.embeddedObject;
        const uri = emb?.imageProperties?.contentUri;
        return uri ? imageFor(objId, uri, emb.title || emb.description || '') : null;
      }
    };
    bodyToBlocks(tab.body?.content, ctx, blocks);
  }
  const entries = splitTopics(buildOutline(blocks), specialty);
  const usedIds = new Set();
  const articles = [];
  const outline = [];
  const groups = []; // open groups: { depth (of their members), item, article }
  for (const e of entries) {
    let id = `${slug(specialty)}/${slug(e.title)}`;
    for (let n = 2; usedIds.has(id); n++) id = `${slug(specialty)}/${slug(e.title)}-${n}`;
    usedIds.add(id);
    while (groups.length && groups[groups.length - 1].depth > e.depth) groups.pop();
    const parent = groups.length && groups[groups.length - 1].depth === e.depth ? groups[groups.length - 1] : null;
    const a = { id, specialty, order, kind: e.kind, title: e.title, aliases: aliasesFor(e.rawTitle), path: e.path, parentId: parent?.article.id || null, blocks: e.blocks };
    finalizeArticle(a);
    a.hub = e.kind === 'overview' && a.words < 60;
    articles.push(a);
    const isGroup = e.kind === 'overview' && !e.isRoot;
    const item = isGroup ? { type: 'group', id, title: e.title, hub: a.hub, items: [] } : { type: 'article', id, title: e.title, kind: e.kind };
    (parent ? parent.item.items : outline).push(item);
    if (isGroup) groups.push({ depth: e.depth + 1, item, article: a });
  }
  for (const a of articles) a.childIds = articles.filter(x => x.parentId === a.id).map(x => x.id);
  return { docId: meta.id, name: meta.name, modifiedTime: meta.modifiedTime, specialty, order, group: (meta.path || []).join(' / '), parser: PARSER_VERSION, outline, articles };
}

function finalizeArticle(a) {
  const anchors = new Set();
  const toc = [];
  const sections = [];
  let html = '';
  let section = { anchor: '', title: '', level: 0, text: '' };
  for (const b of a.blocks) {
    if (b.type === 'heading') {
      if (section.text.trim() || section.title) sections.push(section);
      let anchor = slug(b.text);
      for (let n = 2; anchors.has(anchor); n++) anchor = `${slug(b.text)}-${n}`;
      anchors.add(anchor);
      const depth = b.depth || 2;
      html += `<h${depth} id="${anchor}">${esc(b.text)}</h${depth}>`;
      toc.push({ anchor, text: b.text, depth: depth - 1 });
      section = { anchor, title: b.text, level: depth - 1, text: '' };
    } else {
      html += b.html;
      section.text += ' ' + b.text;
    }
  }
  if (section.text.trim() || section.title) sections.push(section);
  a.html = html;
  a.toc = toc;
  a.sections = sections.map(s => ({ ...s, text: s.text.replace(/\s+/g, ' ').trim(), aliases: s.title ? aliasesFor(s.title) : [] }));
  a.words = a.sections.reduce((n, s) => n + (s.text ? s.text.split(' ').length : 0), 0);
  delete a.blocks;
}

// Docs parsed by an older parser have no outline; list their articles flat
// until the next sync re-parses them.
const outlineOf = (d) => d.outline || d.articles.map(a => ({ type: 'article', id: a.id, title: a.title, kind: a.kind || 'topic' }));

// ------------------------------- the library --------------------------------
export function createTextbook({ log = console } = {}) {
  let docs = [];          // parsed docs, sorted
  let byId = new Map();   // articleId -> article
  let index = buildSearchIndex([]);
  const status = { configured: !!serviceAccount(), folderId: FOLDER_ID, lastSync: null, lastError: null, syncing: false, docs: 0, articles: 0 };

  function rebuild() {
    docs.sort((a, b) => a.order - b.order || a.specialty.localeCompare(b.specialty));
    byId = new Map();
    for (const d of docs) for (const a of d.articles) byId.set(a.id, a);
    index = buildSearchIndex([...byId.values()]);
    status.docs = docs.length;
    status.articles = byId.size;
  }

  // ---- persistence ----
  async function ensureTables() {
    if (!hasPg()) { fs.mkdirSync(path.join(CACHE_DIR, 'img'), { recursive: true }); return; }
    await q(`CREATE TABLE IF NOT EXISTS textbook_docs (doc_id text PRIMARY KEY, modified_time text, parser int, data jsonb NOT NULL, updated_at timestamptz DEFAULT now());
             CREATE TABLE IF NOT EXISTS textbook_images (key text PRIMARY KEY, mime text, data bytea NOT NULL);`);
  }
  async function loadCached() {
    try {
      await ensureTables();
      if (hasPg()) {
        const r = await q('SELECT data, parser FROM textbook_docs');
        // Older-parser docs stay readable until the next sync re-parses them.
        docs = r.rows.map(x => ({ ...x.data, parser: x.parser }));
      } else {
        const f = path.join(CACHE_DIR, 'docs.json');
        const saved = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
        docs = (saved?.docs || []).map(d => ({ ...d, parser: d.parser ?? saved.parser }));
      }
      rebuild();
    } catch (e) { log.error('[textbook] cache load failed:', e.message); }
  }
  async function saveDoc(d) {
    if (hasPg()) await q(`INSERT INTO textbook_docs (doc_id, modified_time, parser, data) VALUES ($1,$2,$3,$4)
                          ON CONFLICT (doc_id) DO UPDATE SET modified_time = EXCLUDED.modified_time, parser = EXCLUDED.parser, data = EXCLUDED.data, updated_at = now()`, [d.docId, d.modifiedTime, PARSER_VERSION, d]);
  }
  async function saveAllLocal() {
    if (hasPg()) return;
    fs.writeFileSync(path.join(CACHE_DIR, 'docs.json'), JSON.stringify({ parser: PARSER_VERSION, docs }));
  }
  async function putImage(key, mime, data) {
    if (hasPg()) await q('INSERT INTO textbook_images (key, mime, data) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING', [key, mime, data]);
    else { fs.writeFileSync(path.join(CACHE_DIR, 'img', key), data); fs.writeFileSync(path.join(CACHE_DIR, 'img', key + '.type'), mime); }
  }
  async function hasImage(key) {
    if (hasPg()) return (await q('SELECT 1 FROM textbook_images WHERE key = $1', [key])).rowCount > 0;
    return fs.existsSync(path.join(CACHE_DIR, 'img', key));
  }
  async function getImage(key) {
    if (!/^[a-f0-9]{40}$/.test(key)) return null;
    if (hasPg()) { const r = await q('SELECT mime, data FROM textbook_images WHERE key = $1', [key]); return r.rows[0] ? { type: r.rows[0].mime, data: r.rows[0].data } : null; }
    const f = path.join(CACHE_DIR, 'img', key);
    return fs.existsSync(f) ? { type: fs.readFileSync(f + '.type', 'utf8'), data: fs.readFileSync(f) } : null;
  }

  // ---- sync ----
  async function sync({ force = false } = {}) {
    if (status.syncing) return { ok: false, message: 'A sync is already running.' };
    if (!serviceAccount()) { status.lastError = 'GOOGLE_SERVICE_ACCOUNT_JSON is not set.'; return { ok: false, message: status.lastError }; }
    status.syncing = true;
    const started = Date.now();
    const report = { fetched: 0, unchanged: 0, removed: 0, images: 0, errors: [] };
    try {
      await ensureTables();
      const files = await listDocs(FOLDER_ID);
      const known = new Map(docs.map(d => [d.docId, d]));
      const next = [];
      for (const f of files) {
        const old = known.get(f.id);
        if (!force && old && old.modifiedTime === f.modifiedTime && old.parser === PARSER_VERSION) { next.push(old); report.unchanged++; continue; }
        try {
          const raw = await getDocument(f.id);
          const pending = [];
          const imageFor = (objId, uri, alt) => {
            const key = crypto.createHash('sha1').update(`${f.id}:${objId}`).digest('hex');
            pending.push({ key, uri });
            return { src: `/textbook/img/${key}`, alt };
          };
          const parsed = parseDocument(raw, f, imageFor);
          // Image URLs from the Docs API expire, so copy images now.
          for (const p of pending) {
            try { if (!(await hasImage(p.key))) { const img = await downloadImage(p.uri); await putImage(p.key, img.type, img.data); report.images++; } }
            catch (e) { report.errors.push(`image in ${f.name}: ${e.message}`); }
          }
          await saveDoc(parsed);
          next.push(parsed);
          report.fetched++;
        } catch (e) {
          report.errors.push(`${f.name}: ${e.message}`);
          if (old) next.push(old);
        }
      }
      const ids = new Set(files.map(f => f.id));
      report.removed = docs.filter(d => !ids.has(d.docId)).length;
      if (hasPg() && report.removed) for (const d of docs) if (!ids.has(d.docId)) await q('DELETE FROM textbook_docs WHERE doc_id = $1', [d.docId]);
      docs = next;
      rebuild();
      await saveAllLocal();
      status.lastSync = new Date().toISOString();
      status.lastError = report.errors.length ? report.errors.slice(0, 5).join(' | ') : null;
      log.log(`[textbook] sync done in ${Date.now() - started} ms: ${report.fetched} fetched, ${report.unchanged} unchanged, ${report.images} images, ${report.errors.length} errors`);
      if (report.errors.length) log.error('[textbook] sync errors:', report.errors.slice(0, 10).join(' | '));
      return { ok: true, ms: Date.now() - started, ...report, docs: status.docs, articles: status.articles };
    } catch (e) {
      status.lastError = e.message;
      log.error('[textbook] sync failed:', e.message);
      return { ok: false, message: e.message };
    } finally {
      status.syncing = false;
    }
  }

  async function start() {
    await loadCached();
    if (!serviceAccount()) { log.warn('[textbook] GOOGLE_SERVICE_ACCOUNT_JSON not set; textbook sync disabled.'); return; }
    sync().catch(() => {});
    if (SYNC_MINUTES > 0) setInterval(() => sync().catch(() => {}), SYNC_MINUTES * 60_000).unref();
  }

  // ---- queries ----
  const isReadable = (a) => !a.hub;
  function tree() {
    return docs.map(d => ({
      specialty: d.specialty, order: d.order, group: d.group, docId: d.docId, updated: d.modifiedTime,
      outline: outlineOf(d),
      // Flat list for progress counts; empty group hub pages aren't counted.
      articles: d.articles.filter(isReadable).map(a => ({ id: a.id, title: a.title, kind: a.kind || 'topic', path: a.path || [] }))
    }));
  }

  function article(id) {
    const a = byId.get(id);
    if (!a) return null;
    const all = docs.flatMap(d => d.articles).filter(isReadable);
    const i = all.findIndex(x => x.id === id);
    const nav = (x) => (x ? { id: x.id, title: x.title, specialty: x.specialty } : null);
    const doc = docs.find(d => d.articles.includes(a));
    const ref = (x) => (x ? { id: x.id, title: x.title, kind: x.kind || 'topic', hub: !!x.hub } : null);
    const crumbs = [];
    for (let p = byId.get(a.parentId); p && crumbs.length < 6; p = byId.get(p.parentId)) crumbs.unshift(ref(p));
    return {
      crumbs,
      id: a.id, title: a.title, kind: a.kind || 'topic', hub: !!a.hub, specialty: a.specialty, path: a.path || [], aliases: a.aliases || [],
      parent: ref(byId.get(a.parentId)), children: (a.childIds || []).map(c => ref(byId.get(c))).filter(Boolean),
      group: doc?.group || '', html: a.html, toc: a.toc, words: a.words, updated: doc?.modifiedTime,
      sourceUrl: doc ? `https://docs.google.com/document/d/${doc.docId}/edit` : '',
      prev: i >= 0 ? nav(all[i - 1]) : null, next: i >= 0 ? nav(all[i + 1]) : null
    };
  }

  function search(query, opts = {}) {
    return searchIndex(index, query, { ...opts, esc });
  }

  return { start, sync, tree, article, search, getImage, status: () => ({ ...status, configured: !!serviceAccount() }), _load: (d) => { docs = d; rebuild(); } };
}
