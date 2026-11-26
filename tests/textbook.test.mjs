// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocument, createTextbook } from '../lib/textbook.js';
import { cleanTitle, aliasesFor, isGenericTitle } from '../lib/textbookStructure.js';
import { longFormFor, tokenize } from '../lib/textbookSearch.js';

// Minimal Docs API document from [level, text] pairs; level 0 = body text.
function doc(title, rows) {
  const p = (text, style) => ({ paragraph: { elements: [{ textRun: { content: text + '\n' } }], paragraphStyle: { namedStyleType: style } } });
  return { title, body: { content: rows.map(([lvl, text]) => p(text, lvl ? `HEADING_${lvl}` : 'NORMAL_TEXT')) } };
}
const body = (s) => [0, s + ' '.repeat(1) + 'Detail text for this section with enough words to count as content.'];
const parse = (name, rows) => parseDocument(doc(name, rows), { id: name, name, modifiedTime: 't' });
const titles = (d) => d.articles.map(a => `${a.kind}:${a.title}`);

// Layout A: every H2 is a topic (Gastroenterology).
const gi = parse('06 Gastroenterology', [
  [1, 'GASTROENTEROLOGY'], [2, 'Chapter navigation'], body('Links'),
  [2, 'Upper GI Bleeding'], [3, 'Definition/severity'], body('a'), [3, 'Management'], body('b'),
  [2, 'Celiac Disease'], [3, 'Diagnosis while consuming gluten'], body('tTG-IgA'), [3, 'Selected references'], body('refs')
]);
// Layout B: H2 groups, H3 topics, an H3 group holding H4 topics (Hematology).
const heme = parse('08 Hematology', [
  [1, 'HEMATOLOGY'],
  [2, 'Anemia and Red-Cell Disorders'],
  [3, 'Approach to Anemia'], [4, 'Definition'], body('a'), [4, 'Differential'], body('b'),
  [3, 'Hemoglobinopathies'], [4, 'Shared diagnostic and safety framework'], body('c'),
  [4, 'Thalassemia'], [5, 'Diagnosis'], body('d'), [4, 'Sickle Cell Disease'], [5, 'Vaso-occlusive pain'], body('e'), [5, 'Acute chest syndrome'], body('f'),
  [3, 'Autoimmune Hemolytic Anemia (AIHA)'], [4, 'Classification'], body('warm and cold'),
  [2, 'Amyloidosis'], [3, 'Definition, protein types and mechanisms'], body('AL amyloid'), [3, 'Amyloidosis sources'], body('refs')
]);
// Layout C: H2 group of H3 topics plus a generic H3 that has sub-headings (Cardiology valves).
const cards = parse('01 Cardiology', [
  [1, 'CARDIOLOGY'],
  [2, 'Valvular Heart Disease'], [3, 'Clinical approach to valvular heart disease'], [4, 'Murmurs'], body('x'),
  [3, 'Aortic stenosis (AS)'], [4, 'Diagnosis'], body('echo'), [4, 'Treatment'], body('TAVI'),
  [3, 'Chronic primary mitral regurgitation (MR)'], [4, 'Diagnosis'], body('echo'),
  [2, 'Arrhythmias'], [3, 'Atrial fibrillation: definition, mechanisms and evaluation'], body('AF is common'), [3, 'Atrial flutter'], body('typical flutter')
]);

test('topics are found at whatever heading level the document uses', () => {
  assert.deepEqual(titles(gi), ['topic:Upper GI Bleeding', 'topic:Celiac Disease']);
  assert.deepEqual(titles(heme), [
    'overview:Anemia and Red-Cell Disorders', 'topic:Approach to Anemia', 'overview:Hemoglobinopathies', 'topic:Thalassemia',
    'topic:Sickle Cell Disease', 'topic:Autoimmune Hemolytic Anemia (AIHA)', 'topic:Amyloidosis'
  ]);
  assert.deepEqual(titles(cards), [
    'overview:Valvular Heart Disease', 'topic:Aortic stenosis (AS)', 'topic:Chronic primary mitral regurgitation (MR)', 'topic:Arrhythmias'
  ]);
});

test('group pages hold their generic sections and link to their topics', () => {
  const hb = heme.articles.find(a => a.title === 'Hemoglobinopathies');
  assert.deepEqual(hb.toc.map(t => t.text), ['Shared diagnostic and safety framework']);
  assert.deepEqual(hb.childIds, ['hematology/thalassemia', 'hematology/sickle-cell-disease']);
  const scd = heme.articles.find(a => a.title === 'Sickle Cell Disease');
  assert.deepEqual(scd.path, ['Anemia and Red-Cell Disorders', 'Hemoglobinopathies']);
  assert.equal(scd.parentId, 'hematology/hemoglobinopathies');
  assert.match(scd.html, /<h2 id="vaso-occlusive-pain">/);
  // Navigation: groups nest, and chapter navigation lists are dropped.
  assert.equal(heme.outline[0].type, 'group');
  assert.equal(heme.outline[0].items[1].title, 'Hemoglobinopathies');
  assert.ok(!gi.articles.some(a => /navigation/i.test(a.title)));
});

test('titles, aliases and generic headings', () => {
  assert.equal(cleanTitle('1. Febrile neutropenia'), 'Febrile neutropenia');
  assert.equal(cleanTitle('2B-2C. Single-stranded DNA viruses'), 'Single-stranded DNA viruses');
  assert.equal(cleanTitle('A. Pathogen-based infectious diseases'), 'Pathogen-based infectious diseases');
  assert.equal(cleanTitle('C. difficile — treatment'), 'C. difficile — treatment');
  assert.deepEqual(aliasesFor('Autoimmune Hemolytic Anemia (AIHA)'), ['AIHA', 'Autoimmune Hemolytic Anemia']);
  assert.ok(aliasesFor('Oncocytic thyroid carcinoma (OTC; formerly Hürthle-cell carcinoma)').includes('Hürthle-cell carcinoma'));
  assert.ok(aliasesFor('Anemia of Chronic Disease / Anemia of Inflammation').includes('Anemia of Inflammation'));
  assert.ok(isGenericTitle('Selected references') && isGenericTitle('Definition/severity') && !isGenericTitle('Approach to Anemia') && !isGenericTitle('Sickle Cell Disease'));
  assert.equal(longFormFor('MDS', 'patients with myelodysplastic syndrome'), 'myelodysplastic syndrome');
  assert.deepEqual(tokenize('Haemolytic anaemia'), tokenize('hemolytic anemia'));
});

test('search puts the topic first, then sections, then passages', () => {
  const tb = createTextbook({ log: { log() {}, error() {}, warn() {} } });
  const mds = parse('09 Oncology', [[1, 'ONCOLOGY'], [2, 'Leukemia'], [3, 'Diagnosis'], [0, 'Clonal myelodysplastic syndrome (MDS) can progress to AML.']]);
  tb._load([cards, gi, heme, mds]);

  let r = tb.search('sickle cell');
  assert.equal(r.topics[0].title, 'Sickle Cell Disease');
  r = tb.search('AIHA');
  assert.equal(r.topics[0].title, 'Autoimmune Hemolytic Anemia (AIHA)');
  r = tb.search('afib'); // curated shorthand -> section inside the Arrhythmias topic
  assert.equal(r.topics.length, 0);
  assert.equal(r.sections[0].sectionTitle, 'Atrial fibrillation: definition, mechanisms and evaluation');
  r = tb.search('sickel cell'); // typo
  assert.equal(r.corrected, 'sickle cell');
  assert.equal(r.topics[0].title, 'Sickle Cell Disease');
  r = tb.search('MDS'); // no dedicated topic: no topic hit, passage still found
  assert.equal(r.topics.length, 0);
  assert.equal(r.results[0].articleTitle, 'Leukemia');
  r = tb.search('anaemia');
  assert.equal(r.topics[0].title, 'Approach to Anemia');
  r = tb.search('aortic stenosis');
  assert.equal(r.topics[0].title, 'Aortic stenosis (AS)');
});

test('documents cached by the previous parser still load', () => {
  const tb = createTextbook({ log: { log() {}, error() {}, warn() {} } });
  const old = { docId: 'x', specialty: 'Old', order: 1, parser: 3, articles: [{ id: 'old/a', specialty: 'Old', title: 'A', html: '<p>x</p>', toc: [], words: 3, sections: [{ anchor: '', title: '', text: 'alpha beta gamma' }] }] };
  tb._load([old]);
  assert.equal(tb.tree()[0].outline[0].id, 'old/a');
  assert.equal(tb.article('old/a').title, 'A');
  assert.equal(tb.search('gamma').results.length, 1);
});

// Restructured docs: Title chapter, H1 section, H2 subsection, H3 article + tag line.
test('tagged articles: groups, depth, placeholders and cross-references', () => {
  const p = (text, style) => ({ paragraph: { elements: [{ textRun: { content: text + '\n' } }], paragraphStyle: { namedStyleType: style } } });
  const rows = [
    ['TITLE', '08 Hematology'],
    ['HEADING_1', 'Red Cell Disorders'],
    ['HEADING_2', 'Approach'],
    ['HEADING_3', 'Approach to Hemolysis'], ['NORMAL_TEXT', 'HEM-009 · Diagnostic'],
    ['HEADING_4', 'Key points'], ['NORMAL_TEXT', 'Check LDH, haptoglobin and bilirubin; consider PNH [HEM-027] and unknown [HEM-999].'],
    ['HEADING_5', 'Immune'], ['NORMAL_TEXT', 'Direct antiglobulin test first in every patient with hemolysis.'],
    ['HEADING_2', 'Hemolytic Anemias'],
    ['HEADING_3', 'Paroxysmal Nocturnal Hemoglobinuria (PNH)'], ['NORMAL_TEXT', 'HEM-027 · Pathology'],
    ['HEADING_4', 'Key points'], ['NORMAL_TEXT', 'Complement-mediated intravascular hemolysis with thrombosis; flow cytometry confirms the diagnosis.'],
    ['HEADING_3', 'Paroxysmal Cold Hemoglobinuria'], ['NORMAL_TEXT', 'HEM-025 · Pathology'],
    ['HEADING_4', 'Key points'], ['NORMAL_TEXT', 'To be written.'],
    ['HEADING_1', 'Transfusion Medicine'],
    ['HEADING_3', 'Transfusion Reactions'], ['NORMAL_TEXT', 'HEM-130 · Pathology + Diagnostic'],
    ['HEADING_4', 'Suspected acute reaction'], ['NORMAL_TEXT', 'Stop the transfusion, keep the line open with saline, and check the patient and product identity.']
  ];
  const d = parseDocument({ title: '08 Hematology', body: { content: rows.map(([s, t]) => p(t, s)) } }, { id: 'v2', name: '08 Hematology', modifiedTime: 't' });
  assert.deepEqual(titles(d), [
    'overview:Red Cell Disorders', 'overview:Approach', 'topic:Approach to Hemolysis', 'overview:Hemolytic Anemias',
    'topic:Paroxysmal Nocturnal Hemoglobinuria (PNH)', 'topic:Paroxysmal Cold Hemoglobinuria', 'overview:Transfusion Medicine', 'topic:Transfusion Reactions'
  ]);
  const hem = d.articles.find(a => a.code === 'HEM-009');
  assert.equal(hem.id, 'hem-009');
  assert.equal(hem.type, 'Diagnostic');
  assert.deepEqual(hem.path, ['Red Cell Disorders', 'Approach']);
  assert.equal(hem.parentId, 'hematology/approach');
  assert.match(hem.html, /<h2 id="key-points">Key points<\/h2>/);
  assert.match(hem.html, /<h3 id="immune">Immune<\/h3>/);
  assert.ok(!/HEM-009 · Diagnostic/.test(hem.html), 'tag line is not rendered');
  assert.equal(d.articles.find(a => a.code === 'HEM-025').stub, true);
  assert.equal(d.articles.find(a => a.code === 'HEM-027').stub, false);
  const tr = d.articles.find(a => a.code === 'HEM-130');
  assert.equal(tr.type, 'Pathology + Diagnostic');
  assert.deepEqual(tr.path, ['Transfusion Medicine']);
  // Outline nests articles under their groups.
  assert.equal(d.outline[0].title, 'Red Cell Disorders');
  assert.equal(d.outline[0].items[0].items[0].code, 'HEM-009');

  const tb = createTextbook({ log: { log() {}, error() {}, warn() {} } });
  tb._load([d]);
  const view = tb.article('hem-009');
  assert.match(view.html, /<a class="xref" href="#\/a\/hem-027"[^>]*>\[HEM-027\]<\/a>/);
  assert.match(view.html, /\[HEM-999\]/);
  assert.ok(!/href="#\/a\/hem-999"/.test(view.html));
  assert.equal(tb.search('paroxysmal nocturnal').topics[0].title, 'Paroxysmal Nocturnal Hemoglobinuria (PNH)');
  assert.equal(tb.search('PNH').topics[0].title, 'Paroxysmal Nocturnal Hemoglobinuria (PNH)');
});
