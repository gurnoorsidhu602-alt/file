// lib/textbookSearch.js
// Topic-first search for the textbook.
//
// Results come back in three tiers:
//   1. topics   - a topic (or group page) whose title or alias matches the query
//   2. sections - a heading inside a topic that matches ("Hepatic encephalopathy"
//                 inside "Cirrhosis and Decompensated Liver Disease")
//   3. results  - passages that mention the words (BM25 over section text)
// so searching "myelodysplastic syndrome" or "MDS" opens the MDS topic first if
// one exists, and otherwise says plainly that there is no dedicated topic.
//
// Queries are expanded with abbreviations learned from the text itself
// ("... myelodysplastic syndrome (MDS) ...") plus a short curated list of
// clinical shorthand, normalized for British/American spelling, and
// corrected for small typos against the textbook's own vocabulary.

const STOP = new Set('the a an and or of to in on for with by is are be as at from that this it its into vs versus not no if than then'.split(' '));

// British -> North American spelling, applied to normalized text.
const SPELLING = [
  [/haem/g, 'hem'], [/anaem/g, 'anem'], [/aemia/g, 'emia'], [/oesoph/g, 'esoph'], [/oedem/g, 'edem'],
  [/paedi/g, 'pedi'], [/gynaec/g, 'gynec'], [/tumour/g, 'tumor'], [/ischaem/g, 'ischem'], [/aetiol/g, 'etiol'],
  [/coeliac/g, 'celiac'], [/diarrhoe/g, 'diarrhe'], [/leukaem/g, 'leukem'], [/oestr/g, 'estr'], [/foet/g, 'fet'],
  [/faec/g, 'fec'], [/orthopaed/g, 'orthoped'], [/sulph/g, 'sulf'], [/fibre\b/g, 'fiber'], [/centre\b/g, 'center'],
  [/litre\b/g, 'liter'], [/behaviour/g, 'behavior'], [/colour/g, 'color'], [/phaeo/g, 'pheo'], [/hyperaem/g, 'hyperem'],
  [/glycaem/g, 'glycem'], [/kalaem/g, 'kalem'], [/natraem/g, 'natrem'], [/calcaem/g, 'calcem'], [/uraem/g, 'urem'],
  [/septicaem/g, 'septicem'], [/bacteraem/g, 'bacterem'], [/viraem/g, 'virem'], [/oxaem/g, 'oxem'], [/lipaem/g, 'lipem'],
  [/ae(?=mia\b)/g, 'e'], [/haemo/g, 'hemo'], [/anaesth/g, 'anesth'], [/oesin/g, 'eosin']
];

export function normalize(s) {
  let t = String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’'`]/g, '');
  for (const [re, rep] of SPELLING) t = t.replace(re, rep);
  return t;
}
const stem = (t) => (t.length > 4 && t.endsWith('ies') ? t.slice(0, -3) + 'y'
  : t.length > 4 && t.endsWith('s') && !t.endsWith('ss') && !t.endsWith('us') && !t.endsWith('is') ? t.slice(0, -1) : t);
export function tokenize(s) {
  return (normalize(s).match(/[a-z0-9]+/g) || []).filter(t => (t.length > 1 || /\d/.test(t)) && !STOP.has(t)).map(stem);
}

// Clinical shorthand that the text often uses without defining. Keys are
// lowercase tokens; values are what they stand for.
export const CURATED = {
  af: ['atrial fibrillation'], afib: ['atrial fibrillation'], aflutter: ['atrial flutter'],
  mi: ['myocardial infarction'], acs: ['acute coronary syndrome'], stemi: ['st elevation myocardial infarction'],
  nstemi: ['non st elevation myocardial infarction'], chf: ['heart failure'], hf: ['heart failure'],
  hfref: ['heart failure reduced ejection fraction'], hfpef: ['heart failure preserved ejection fraction'],
  cad: ['coronary artery disease'], htn: ['hypertension'], svt: ['supraventricular tachycardia'], vt: ['ventricular tachycardia'],
  copd: ['chronic obstructive pulmonary disease'], aecopd: ['copd exacerbation'], cap: ['community acquired pneumonia'],
  hap: ['hospital acquired pneumonia'], pe: ['pulmonary embolism'], dvt: ['deep vein thrombosis'], vte: ['venous thromboembolism'],
  ild: ['interstitial lung disease'], ipf: ['idiopathic pulmonary fibrosis'], osa: ['obstructive sleep apnea'], ards: ['acute respiratory distress syndrome'],
  aki: ['acute kidney injury'], ckd: ['chronic kidney disease'], esrd: ['kidney failure dialysis'], eskd: ['kidney failure dialysis'],
  rta: ['renal tubular acidosis'], siadh: ['siad', 'syndrome inappropriate antidiuresis'], siad: ['syndrome inappropriate antidiuresis'],
  dka: ['diabetic ketoacidosis', 'hyperglycemic emergency'], hhs: ['hyperosmolar hyperglycemic state', 'hyperglycemic emergency'], di: ['diabetes insipidus', 'arginine vasopressin deficiency'],
  dm: ['diabetes mellitus'], t1dm: ['type 1 diabetes'], t2dm: ['type 2 diabetes'],
  gib: ['gi bleeding'], ugib: ['upper gi bleeding'], lgib: ['lower gi bleeding'], sbp: ['spontaneous bacterial peritonitis'],
  he: ['hepatic encephalopathy'], hrs: ['hepatorenal syndrome'], ibd: ['inflammatory bowel disease'], uc: ['ulcerative colitis'],
  ibs: ['irritable bowel syndrome'], gerd: ['gastroesophageal reflux'], pud: ['peptic ulcer disease'], cdi: ['clostridioides difficile'],
  cdiff: ['clostridioides difficile'], nafld: ['fatty liver'], masld: ['steatotic liver disease'], pbc: ['primary biliary cholangitis'],
  psc: ['primary sclerosing cholangitis'], aih: ['autoimmune hepatitis'], alf: ['acute liver failure'],
  ttp: ['thrombotic thrombocytopenic purpura'], itp: ['immune thrombocytopenia'], hit: ['heparin induced thrombocytopenia'],
  dic: ['disseminated intravascular coagulation'], tma: ['thrombotic microangiopathy'], hus: ['hemolytic uremic syndrome'],
  mds: ['myelodysplastic syndrome', 'myelodysplastic neoplasm'], aml: ['acute myeloid leukemia'], cml: ['chronic myeloid leukemia'],
  cll: ['chronic lymphocytic leukemia'], mgus: ['monoclonal gammopathy undetermined significance'], mm: ['multiple myeloma'],
  pv: ['polycythemia vera'], et: ['essential thrombocythemia'], pmf: ['primary myelofibrosis'], mpn: ['myeloproliferative neoplasm'],
  hlh: ['hemophagocytic lymphohistiocytosis'], ida: ['iron deficiency anemia'], aiha: ['autoimmune hemolytic anemia'],
  sah: ['subarachnoid hemorrhage'], ich: ['intracerebral hemorrhage'], tia: ['transient ischemic attack'], cva: ['stroke'],
  gbs: ['guillain barre syndrome'], mg: ['myasthenia gravis'], ms: ['multiple sclerosis'], als: ['amyotrophic lateral sclerosis'],
  nms: ['neuroleptic malignant syndrome'], sjs: ['stevens johnson syndrome'], ten: ['toxic epidermal necrolysis'],
  gca: ['giant cell arteritis'], pmr: ['polymyalgia rheumatica'], sle: ['systemic lupus erythematosus'], ra: ['rheumatoid arthritis'],
  oa: ['osteoarthritis'], aaa: ['abdominal aortic aneurysm'], pad: ['peripheral arterial disease'], svc: ['superior vena cava'],
  tls: ['tumor lysis syndrome'], fn: ['febrile neutropenia'], tb: ['tuberculosis'], uti: ['urinary tract infection'],
  ssti: ['skin soft tissue infection'], ie: ['infective endocarditis'], fuo: ['fever unknown origin'], aws: ['alcohol withdrawal'],
  oud: ['opioid use disorder'], cpr: ['cardiac arrest'], acls: ['cardiac arrest'], tpn: ['parenteral nutrition'],
  lupus: ['systemic lupus erythematosus'], irae: ['immune related adverse event'], crs: ['cytokine release syndrome'], ptx: ['pneumothorax'], loc: ['level consciousness']
};
// Whole-phrase equivalents (renamed entities, lay terms).
const PHRASES = [
  ['myelodysplastic syndrome', 'myelodysplastic neoplasm'], ['heart attack', 'myocardial infarction'], ['blood clot', 'venous thromboembolism'],
  ['diabetes insipidus', 'arginine vasopressin deficiency'], ['nephrogenic diabetes insipidus', 'arginine vasopressin resistance'],
  ['siadh', 'syndrome inappropriate antidiuresis'], ['pseudogout', 'calcium pyrophosphate deposition'], ['scleroderma', 'systemic sclerosis'],
  ['wegener', 'granulomatosis polyangiitis'], ['churg strauss', 'eosinophilic granulomatosis polyangiitis'], ['hurthle', 'oncocytic'],
  ['temporal arteritis', 'giant cell arteritis'], ['ankylosing spondylitis', 'radiographic axial spondyloarthritis'],
  ['pseudotumor cerebri', 'idiopathic intracranial hypertension'], ['c diff', 'clostridioides difficile'], ['c difficile', 'clostridioides difficile'],
  ['nafld', 'steatotic liver'], ['fatty liver', 'steatotic liver'], ['diabetic ketoacidosis', 'hyperglycemic emergency'],
  ['hyperosmolar hyperglycemic state', 'hyperglycemic emergency'], ['afib', 'atrial fibrillation']
].map(([a, b]) => [tokenize(a), tokenize(b)]);

// Shorthand whose single-letter part would otherwise be dropped.
const REWRITES = [
  [/\bc\.?\s*diff(icile)?\b/g, 'clostridioides difficile'], [/\bh\.?\s*pylori\b/g, 'helicobacter pylori'],
  [/\be\.?\s*coli\b/g, 'escherichia coli'], [/\bs\.?\s*aureus\b/g, 'staphylococcus aureus'], [/\bs\.?\s*pneumo(niae)?\b/g, 'streptococcus pneumoniae'],
  [/\bp\.?\s*jirovecii\b/g, 'pneumocystis jirovecii'], [/\bvitamin\s+b\s*12\b/g, 'vitamin b12'], [/\btype\s+(1|2|i|ii)\s+(dm|diabetes)\b/g, 'type $1 diabetes']
];
export function rewriteQuery(q) { let t = normalize(q); for (const [re, rep] of REWRITES) t = t.replace(re, rep); return t; }

// Words that say little about which topic a heading is (for title precision).
const WEAK = new Set(tokenizeRaw('approach overview disease disorder syndrome management clinical related other including general shared practical key'));
function tokenizeRaw(s) { return (String(s).toLowerCase().match(/[a-z0-9]+/g) || []).map(t => (t.length > 4 && t.endsWith('s') ? t.slice(0, -1) : t)); }

// Schwartz & Hearst (2003): finds the long form that an abbreviation in
// parentheses stands for, matching its letters right-to-left.
export function longFormFor(short, before) {
  const s = short.toLowerCase(), words = before.trim().split(/\s+/);
  const maxWords = Math.min(s.length + 5, s.length * 2);
  const cand = words.slice(-maxWords).join(' ');
  const l = cand.toLowerCase();
  let si = s.length - 1, li = l.length - 1;
  while (si >= 0) {
    const c = s[si];
    if (!/[a-z0-9]/.test(c)) { si--; continue; }
    while (li >= 0 && (l[li] !== c || (si === 0 && li > 0 && /[a-z0-9]/.test(l[li - 1])))) li--;
    if (li < 0) return null;
    li--; si--;
  }
  const start = l.lastIndexOf(' ', li) + 1;
  const long = cand.slice(start).replace(/^[^A-Za-z0-9]+/, '').trim();
  return long.length > s.length && long.split(/\s+/).length <= maxWords ? long : null;
}

export function learnAbbreviations(texts) {
  const counts = new Map(); // abbr -> Map(longTokensKey -> count)
  const re = /([A-Za-z0-9][A-Za-z0-9\-’' ]{2,120}?)\s\(([A-Z][A-Za-z0-9\-]{1,9})(?:[;,][^)]*)?\)/g;
  for (const text of texts) {
    for (const m of String(text || '').matchAll(re)) {
      const abbr = m[2];
      if (!/[A-Z].*[A-Z]|^[A-Z][a-z]?[A-Z0-9]/.test(abbr) && abbr.length < 3) continue;
      const long = longFormFor(abbr, m[1]);
      if (!long) continue;
      const toks = tokenize(long);
      if (!toks.length || toks.length > 8) continue;
      const k = abbr.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!k || STOP.has(k)) continue;
      if (!counts.has(k)) counts.set(k, new Map());
      const key = toks.join(' ');
      counts.get(k).set(key, (counts.get(k).get(key) || 0) + 1);
    }
  }
  const out = {};
  for (const [k, forms] of counts) out[k] = [...forms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f]) => f);
  return out;
}

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      // Adjacent transposition ("sickel" -> "sickle") counts as one edit.
      if (prev2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], prev2[j - 2] + 1);
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

function snippet(text, terms, esc) {
  const lower = normalize(text);
  let pos = -1;
  for (const t of terms) { const i = lower.indexOf(t); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  const start = Math.max(0, pos - 90);
  let s = (start > 0 ? '…' : '') + text.slice(start, start + 260) + (start + 260 < text.length ? '…' : '');
  s = esc(s);
  for (const t of terms) if (t.length > 2) s = s.replace(new RegExp(`\\b(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\w*)`, 'gi'), '<mark>$1</mark>');
  return s;
}

// articles: [{ id, title, specialty, path, kind, aliases, sections: [{ anchor, title, text, aliases }] }]
export function buildSearchIndex(articles, { extraAbbreviations = {} } = {}) {
  // Heading entries (topic titles, aliases, section titles).
  const heads = [];
  const headDf = new Map();
  const addHead = (h) => {
    h.toks = [...new Set(tokenize(h.text))];
    if (!h.toks.length) return;
    h.norm = h.toks.join(' ');
    heads.push(h);
    for (const t of h.toks) headDf.set(t, (headDf.get(t) || 0) + 1);
  };
  for (const a of articles) {
    addHead({ type: 'topic', via: 'title', text: a.title, article: a });
    for (const al of a.aliases || []) addHead({ type: 'topic', via: 'alias', text: al, article: a });
    for (const s of a.sections || []) {
      if (!s.title) continue;
      addHead({ type: 'section', via: 'title', text: s.title, article: a, section: s });
      for (const al of s.aliases || []) addHead({ type: 'section', via: 'alias', text: al, article: a, section: s });
    }
  }
  // Body units (one per section) for BM25.
  const units = [], postings = new Map();
  let totalLen = 0;
  for (const a of articles) for (const s of a.sections || []) {
    const titleToks = tokenize(`${a.title} ${s.title || ''}`);
    const bodyToks = tokenize(s.text);
    const tf = new Map();
    for (const t of bodyToks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of titleToks) tf.set(t, (tf.get(t) || 0) + 3);
    const u = { article: a, section: s, len: bodyToks.length + titleToks.length };
    const idx = units.push(u) - 1;
    totalLen += u.len;
    for (const [t, n] of tf) { if (!postings.has(t)) postings.set(t, []); postings.get(t).push([idx, n]); }
  }
  // Abbreviations: learned from the text, curated list, and heading aliases.
  const learned = learnAbbreviations(articles.flatMap(a => [a.title, ...(a.sections || []).flatMap(s => [s.title, s.text])]));
  const abbr = {};
  const addAbbr = (k, forms) => { k = k.toLowerCase(); abbr[k] = [...new Set([...(abbr[k] || []), ...forms.map(f => tokenize(f).join(' ')).filter(Boolean)])].slice(0, 4); };
  for (const [k, v] of Object.entries(learned)) addAbbr(k, v);
  for (const [k, v] of Object.entries({ ...CURATED, ...extraAbbreviations })) addAbbr(k, v);
  const vocab = new Map(); // token -> df across body + headings, for typo correction
  for (const [t, p] of postings) vocab.set(t, p.length);
  for (const [t, n] of headDf) vocab.set(t, (vocab.get(t) || 0) + n * 5);
  return { heads, headDf, nHeads: heads.length || 1, units, postings, avgLen: units.length ? totalLen / units.length : 1, abbr, vocab };
}

// Query variants: the query itself, with abbreviations expanded, with long
// forms contracted to their abbreviation, and with phrase equivalents.
function variants(toks, index) {
  const out = [{ toks, w: 1 }];
  const seen = new Set([toks.join(' ')]);
  const add = (v, w) => { const k = v.join(' '); if (v.length && !seen.has(k)) { seen.add(k); out.push({ toks: v, w }); } };
  toks.forEach((t, i) => {
    for (const f of index.abbr[t] || []) add([...toks.slice(0, i), ...f.split(' '), ...toks.slice(i + 1)], 0.97);
  });
  const joined = ` ${toks.join(' ')} `;
  for (const [k, forms] of Object.entries(index.abbr)) for (const f of forms) {
    // Contracting to an abbreviation is ambiguous (MDS is also the Movement Disorder Society), so weigh it less.
    if (f.split(' ').length >= 2 && joined.includes(` ${f} `)) add(joined.replace(` ${f} `, ` ${k} `).trim().split(' '), 0.7);
  }
  for (const [a, b] of PHRASES) for (const [x, y] of [[a, b], [b, a]]) {
    const xs = ` ${x.join(' ')} `;
    for (const v of [...out]) { const j = ` ${v.toks.join(' ')} `; if (j.includes(xs)) add(j.replace(xs, ` ${y.join(' ')} `).trim().split(' '), 0.95); }
  }
  return out.slice(0, 12);
}

function headScore(h, q, index, prefixLast) {
  prefixLast = prefixLast && !index.vocab.has(q[q.length - 1]);
  const idf = (t) => Math.log(1 + index.nHeads / (index.headDf.get(t) || 0.5));
  let want = 0, got = 0, matchedHead = new Set();
  q.forEach((t, i) => {
    const w = idf(t);
    want += w;
    if (h.toks.includes(t)) { got += w; matchedHead.add(t); }
    else if (prefixLast && i === q.length - 1 && t.length >= 3) {
      const hit = h.toks.find(x => x.startsWith(t));
      if (hit) { got += w * 0.85; matchedHead.add(hit); }
    }
  });
  if (!want) return 0;
  const coverage = got / want;
  if (coverage < 0.5) return 0;
  const strong = h.toks.filter(t => !WEAK.has(t));
  const precision = strong.length ? strong.filter(t => matchedHead.has(t)).length / strong.length : matchedHead.size / h.toks.length;
  const qn = q.join(' ');
  if (h.norm === qn) return 100;
  const phrase = (` ${h.norm} `).includes(` ${qn} `) ? 1 : 0;
  const starts = h.norm.startsWith(qn) ? 1 : 0;
  return 100 * (0.5 * coverage + 0.3 * precision * coverage + 0.1 * phrase + 0.05 * starts);
}

const REFERENCE_SECTION = /\b(sources?|references?|reading|evidence notes|source links|source key|guidance and)\b/i;

export function searchIndex(index, query, { limit = 30, specialty = '', esc = (s) => s } = {}) {
  let toks = tokenize(rewriteQuery(query));
  if (!toks.length) return { query, corrected: null, topics: [], sections: [], results: [], total: 0 };
  // Typo correction against the textbook's own vocabulary.
  let corrected = null;
  toks = toks.map((t, i) => {
    if (index.vocab.has(t) || index.abbr[t] || t.length < 5 || /\d/.test(t)) return t;
    if (i === toks.length - 1 && [...index.vocab.keys()].some(k => k.startsWith(t))) return t; // still typing
    const max = t.length >= 8 ? 2 : 1;
    let best = null, bestD = max + 1, bestDf = 0;
    for (const [k, df] of index.vocab) {
      if (Math.abs(k.length - t.length) > max || k[0] !== t[0]) continue;
      const d = editDistance(t, k, max);
      if (d < bestD || (d === bestD && df > bestDf)) { best = k; bestD = d; bestDf = df; }
    }
    if (best) { corrected = true; return best; }
    return t;
  });
  if (corrected) corrected = toks.join(' ');
  const vs = variants(toks, index);
  const inSpec = (a) => !specialty || a.specialty === specialty;

  // Tiers 1 and 2: headings.
  const topicBest = new Map(), sectionBest = new Map();
  for (const h of index.heads) {
    if (!inSpec(h.article)) continue;
    let s = 0;
    for (const v of vs) s = Math.max(s, headScore(h, v.toks, index, v.w === 1) * v.w);
    if (!s) continue;
    if (h.type === 'topic') {
      s *= h.article.kind === 'overview' ? 0.97 : 1;
      s *= h.via === 'alias' ? 0.99 : 1;
      const cur = topicBest.get(h.article.id);
      if (!cur || s > cur.score) topicBest.set(h.article.id, { h, score: s });
    } else {
      s *= 0.8;
      const key = h.article.id + '#' + h.section.anchor;
      const cur = sectionBest.get(key);
      if (!cur || s > cur.score) sectionBest.set(key, { h, score: s });
    }
  }
  const pathOf = (a) => a.path || [];
  const topics = [...topicBest.values()].filter(x => x.score >= 50).sort((a, b) => b.score - a.score).slice(0, 8)
    .map(({ h, score }) => ({ articleId: h.article.id, title: h.article.title, specialty: h.article.specialty, path: pathOf(h.article), kind: h.article.kind, via: h.via, matched: h.text, score: Math.round(score) }));
  const perArticle = new Map();
  const sections = [...sectionBest.values()].filter(x => x.score >= 40).sort((a, b) => b.score - a.score)
    .filter(({ h }) => { const n = perArticle.get(h.article.id) || 0; perArticle.set(h.article.id, n + 1); return n < 2; })
    .slice(0, 10)
    .map(({ h, score }) => ({ articleId: h.article.id, articleTitle: h.article.title, specialty: h.article.specialty, path: pathOf(h.article), anchor: h.section.anchor, sectionTitle: h.section.title, score: Math.round(score) }));

  // Tier 3: body text (BM25), best variant per section.
  const N = index.units.length || 1;
  const scores = new Map(), hits = new Map();
  for (const v of vs) {
    const vt = [...new Set(v.toks)];
    const local = new Map(), localHits = new Map();
    for (const t of vt) {
      const keys = v.w === 1 && t === vt[vt.length - 1] && t.length >= 3 && !index.vocab.has(t) ? [...index.postings.keys()].filter(k => k.startsWith(t)).slice(0, 40) : [t];
      for (const k of keys) {
        const post = index.postings.get(k) || [];
        const idf = Math.log(1 + (N - post.length + 0.5) / (post.length + 0.5));
        for (const [u, tf] of post) {
          const s = idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * index.units[u].len / index.avgLen));
          local.set(u, (local.get(u) || 0) + s * (k === t ? 1 : 0.6));
          if (!localHits.has(u)) localHits.set(u, new Set());
          localHits.get(u).add(t);
        }
      }
    }
    // A passage must contain the query's most distinctive word, so "myelodysplastic
    // syndrome" doesn't list every passage that says "syndrome".
    const anchor = vt.reduce((best, t) => ((index.postings.get(t)?.length ?? Infinity) < (index.postings.get(best)?.length ?? Infinity) ? t : best), vt[0]);
    for (const [u, s0] of local) {
      if (vt.length > 1 && index.postings.has(anchor) && !localHits.get(u).has(anchor)) continue;
      const refs = REFERENCE_SECTION.test(index.units[u].section.title || '') ? 0.35 : 1; // reference lists mention everything
      const s = s0 * (1 + localHits.get(u).size / vt.length) * (localHits.get(u).size === vt.length ? 1.5 : 1) * v.w * refs;
      if (s > (scores.get(u) || 0)) { scores.set(u, s); hits.set(u, [...localHits.get(u)]); }
    }
  }
  const shown = new Set(sections.map(s => s.articleId + '#' + s.anchor));
  let ranked = [...scores.entries()].filter(([u]) => inSpec(index.units[u].article)).sort((a, b) => b[1] - a[1]);
  const total = ranked.length;
  const per = new Map();
  ranked = ranked.filter(([u]) => {
    const x = index.units[u];
    if (shown.has(x.article.id + '#' + x.section.anchor)) return false;
    const n = per.get(x.article.id) || 0; per.set(x.article.id, n + 1); return n < 3;
  }).slice(0, limit);
  const results = ranked.map(([u, score]) => {
    const x = index.units[u];
    return { articleId: x.article.id, articleTitle: x.article.title, specialty: x.article.specialty, path: pathOf(x.article), anchor: x.section.anchor, sectionTitle: x.section.title, snippet: snippet(x.section.text, hits.get(u), esc), score: Math.round(score * 100) / 100 };
  });
  return { query, corrected, topics, sections, results, total };
}
