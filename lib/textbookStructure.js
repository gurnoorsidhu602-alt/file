// lib/textbookStructure.js
// Works out which headings in a textbook document are *topics* (things a
// learner would look up: "Sickle Cell Disease", "Myasthenia gravis") and which
// are *sections* inside a topic ("Diagnosis", "Sources") or *groups* of topics
// ("Anemia and Red-Cell Disorders").
//
// The documents don't use one heading level for topics: in Gastroenterology
// every H2 is a topic, in Hematology H2s are groups and H3s are topics, and
// some H3s (Hemoglobinopathies) hold H4 topics (Thalassemia, Sickle Cell).
// So topics are found from the shape of the heading tree plus the wording of
// the headings:
//
//   * A heading is "topic-like" if it has sub-headings and its title isn't a
//     generic section name (Definition..., Management..., Sources...).
//   * A heading is a GROUP if at least two of its children are topic-like and
//     they make up at least a third of its children. Otherwise it's a TOPIC
//     and everything under it is its sections.
//   * Inside a group: topic-like children are classified recursively; a
//     childless heading with a specific title ("Vestibular paroxysmia") is a
//     short topic; generic children ("Bedside orientation", "Sources") form
//     the group's overview page.

export const GROUP_MIN_TOPICS = 2;
export const GROUP_MIN_SHARE = 0.34;

// Heading titles that describe a part of a topic rather than a topic.
const GENERIC_START = new RegExp('^(?:' + [
  'definitions?', 'classification', 'scope', 'overview', 'introduction', 'orientation', 'approach\\b(?!\\s+to\\b)',
  'clinical approach', 'general approach', 'bedside', 'immediate', 'initial', 'first[-\\s]',
  'pathophysiology', 'physiology', 'background', 'mechanisms?', 'etiology', 'aetiology', 'causes', 'risk',
  'presentation', 'recognition', 'clinical (?:definition|features|presentation|assessment|orientation|sources|pearls)',
  'history', 'examination', 'differential', 'systematic', 'exhaustive', 'organi[sz]ed', 'broad', 'diagnos',
  'investigation', 'work-?up', 'testing', 'laboratory', 'imaging', 'severity', 'management', 'treatment',
  'therapy', 'therapeutic', 'monitoring', 'follow', 'disposition', 'discharge', 'pitfalls', 'common',
  'complications', 'prognosis', 'prevention', 'sources?', 'references?', 'selected', 'evidence', 'guidance',
  'guidelines?', 'landmark', 'key', 'summary', 'chapter', 'navigation', 'shared', 'ward', 'special',
  'other', 'practical', 'general', 'long-term', 'surveillance', 'screening', 'counsel', 'when to', 'what',
  'how', 'stabili[sz]ation', 'resuscitation', 'escalation', 'red flags', 'source', 'interpretation',
  'subtypes?', 'epidemiology', 'natural history', 'supportive', 'perioperative', 'pregnancy'
].join('|') + ')\\b', 'i');
const GENERIC_ANYWHERE = /\b(sources|references|source key|further reading|navigation)\b/i;
const NAVIGATION = /\b(chapter navigation|table of contents|contents)\b/i;

// "1. Febrile neutropenia" -> "Febrile neutropenia"; "2B-2C. DNA viruses" -> "DNA viruses";
// "A. Pathogen-based infectious diseases" -> "Pathogen-based infectious diseases".
export function cleanTitle(t) {
  return String(t || '')
    .replace(/^\s*\d+[A-Z]?(?:\s*[-–]\s*\d*[A-Z])?\.\s+/, '')
    .replace(/^\s*[A-Z]\.\s+(?=[A-Z])/, '') // "A. Pathogen-based ..." but not "C. difficile"
    .replace(/\s+\[[A-Z]\d[^\]]*\]\s*$/, '') // trailing citation keys like "[A1–A8]"
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGenericTitle(t) {
  const c = cleanTitle(t);
  return GENERIC_START.test(c) || GENERIC_ANYWHERE.test(c);
}
export const isNavigation = (t) => NAVIGATION.test(String(t || ''));

// Other names a topic is known by, taken from its heading:
//   "Autoimmune Hemolytic Anemia (AIHA)"              -> ["AIHA"]
//   "Oncocytic thyroid carcinoma (OTC; formerly Hürthle-cell carcinoma)" -> ["OTC", "Hürthle-cell carcinoma"]
//   "Anemia of Chronic Disease / Anemia of Inflammation" -> both halves
//   "Cerebral venous sinus thrombosis (CVST/CVT)"      -> ["CVST", "CVT"]
export function aliasesFor(title) {
  const t = cleanTitle(title);
  const out = new Set();
  for (const m of t.matchAll(/\(([^()]{1,80})\)/g)) {
    for (let part of m[1].split(/[;,]|\/(?=\s*[A-Z])/)) {
      part = part.replace(/^\s*(formerly|previously|also called|aka|including|incl\.?)\s+/i, '').trim();
      if (part.length >= 2 && !/^(ICHD|WHO|appendix)/i.test(part)) out.add(part);
    }
  }
  const bare = t.replace(/\s*\([^()]*\)\s*/g, ' ').trim();
  if (/\s\/\s/.test(bare)) for (const half of bare.split(/\s\/\s/)) if (half.trim().length > 3) out.add(half.trim());
  if (bare !== t && bare.length > 3) out.add(bare);
  return [...out].filter(a => a.toLowerCase() !== t.toLowerCase());
}

// blocks: [{ type: 'heading', level, text } | { type: 'html', html, text }]
// Returns the heading tree. Level-1 headings (the document title) are folded
// into the root.
export function buildOutline(blocks) {
  const root = { level: 1, text: '', blocks: [], children: [] };
  const stack = [root];
  for (const b of blocks) {
    if (b.type === 'heading') {
      if (b.level <= 1) continue;
      const node = { level: b.level, text: b.text, blocks: [], children: [] };
      while (stack[stack.length - 1].level >= node.level) stack.pop();
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    } else {
      stack[stack.length - 1].blocks.push(b);
    }
  }
  return root;
}

const isLeaf = (n) => !n.children.length;
const topicLike = (n) => !isLeaf(n) && !isGenericTitle(n.text);
export function isGroup(n) {
  const kids = n.children.filter(c => !isNavigation(c.text));
  const tl = kids.filter(topicLike).length;
  return tl >= GROUP_MIN_TOPICS && tl / kids.length >= GROUP_MIN_SHARE;
}
const textLen = (n) => n.blocks.reduce((s, b) => s + (b.text || '').length, 0) + n.children.reduce((s, c) => s + textLen(c), 0);

// Flattens nodes into article blocks: headings re-levelled so the article's
// first sub-level renders as <h2>.
function flatten(nodes, baseLevel, out = []) {
  for (const n of nodes) {
    out.push({ type: 'heading', depth: Math.min(4, Math.max(2, n.level - baseLevel + 2)), text: cleanTitle(n.text) });
    out.push(...n.blocks);
    flatten(n.children, baseLevel, out);
  }
  return out;
}

// Splits the outline into an ordered list of entries:
//   { kind: 'topic' | 'overview', title, rawTitle, path: [group titles], depth, blocks, childTitles }
// 'overview' entries are group hub pages (and a specialty overview when the
// document has introductory text). Document order is preserved.
export function splitTopics(root, specialty) {
  const out = [];
  const topicEntry = (node, path) => ({
    kind: 'topic', title: cleanTitle(node.text), rawTitle: node.text, path, depth: path.length,
    blocks: [...node.blocks, ...flatten(node.children, node.level + 1)]
  });

  function walkGroup(node, path, isRoot) {
    const kids = node.children.filter(c => !isNavigation(c.text));
    const overviewNodes = kids.filter(c => !topicLike(c) && isGenericTitle(c.text));
    const overviewBlocks = [...node.blocks, ...flatten(overviewNodes, node.level + 1)];
    const here = isRoot ? path : [...path, cleanTitle(node.text)];
    let entry = null;
    if (!isRoot || (overviewBlocks.some(b => b.type !== 'heading') && overviewBlocks.reduce((s, b) => s + (b.text || '').length, 0) >= 200)) {
      entry = { kind: 'overview', title: isRoot ? specialty : cleanTitle(node.text), rawTitle: isRoot ? specialty : node.text, path, depth: path.length, blocks: overviewBlocks, childTitles: [], isRoot };
      out.push(entry);
    }
    for (const c of kids) {
      if (overviewNodes.includes(c)) continue;
      if (topicLike(c) && isGroup(c)) { if (entry) entry.childTitles.push(cleanTitle(c.text)); walkGroup(c, here, false); }
      else if (topicLike(c) || !isGenericTitle(c.text)) { if (entry) entry.childTitles.push(cleanTitle(c.text)); out.push(topicEntry(c, here)); }
    }
  }

  // A document whose top level is itself one topic (no groups, no topics) is a single article.
  const kids = root.children.filter(c => !isNavigation(c.text));
  if (!kids.length) {
    if (textLen(root) > 0) out.push({ kind: 'topic', title: specialty, rawTitle: specialty, path: [], depth: 0, blocks: root.blocks });
    return out;
  }
  // At the top of a document every non-generic heading is either a group or a topic.
  walkGroup(root, [], true);
  return out;
}
