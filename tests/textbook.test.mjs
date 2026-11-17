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
