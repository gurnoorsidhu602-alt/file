// lib/caseEngine.js
// Deterministic core of the Medical Case Simulator.
//
// The hidden case ("world") is generated once. After that the engine owns:
//   - the simulated clock (only moves forward),
//   - physiological state (vitals + lab values with per-hour trends),
//   - structured orders, the MAR, and a queue of scheduled events,
//   - answers to repeated history/exam questions (stored, so they never drift).
// AI is called only through the injected `ai` adapter, and only when the
// stored case cannot answer: novel questions, unrecognised orders, results the
// case did not pre-specify, and re-estimating trends after therapy changes.

import crypto from 'crypto';
import {
  LAB_TESTS, LAB_CATEGORY_ORDER, STUDIES, parseOrder, refRangeText, flagFor, formatValue, matchMedication, parseMedDetails
} from './caseCatalog.js';

export const ENGINE_VERSION = 2;

// ------------------------------- small utils --------------------------------
export const ensureArray = (x) => (Array.isArray(x) ? x : []);
const uid = () => crypto.randomUUID();
export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9%./+-]+/g, ' ').replace(/\s+/g, ' ').trim();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Simulated time is stored as "YYYY-MM-DD HH:mm" and handled as UTC minutes so
// server time zone never shifts the clock.
export function toMin(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000;
}
export function fromMin(n) {
  const d = new Date(Math.round(n) * 60000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
export function dayLabel(s) {
  const n = toMin(s);
  if (n == null) return '';
  return new Date(n * 60000).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function seeded(seed) {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
  h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909);
  return ((h ^= h >>> 16) >>> 0) / 4294967296;
}

// ---------------------------- physiology state ------------------------------
const VITAL_BOUNDS = { hr: [20, 220], sbp: [40, 260], dbp: [20, 160], rr: [4, 60], spo2: [50, 100], temp: [32, 42.5], pain: [0, 10] };
const LAB_BOUNDS = {
  na: [100, 185], k: [1.5, 9.5], cl: [70, 140], hco3: [2, 50], glucose: [0.8, 80], hgb: [25, 230], plt: [1, 2000], wbc: [0.1, 300],
  vph: [6.7, 7.8], aph: [6.7, 7.8], vpco2: [10, 140], apco2: [10, 140], apo2: [25, 600], inr: [0.8, 15], lactate: [0.3, 30], ca: [1.0, 4.5]
};

export function getTest(session, key) {
  return LAB_TESTS[key] || session.world?.customTests?.[key] || null;
}
export function getStudy(session, key) {
  return STUDIES[key] || session.world?.customStudies?.[key] || null;
}

function sexOf(session) { const s = String(session.patient?.sex || '').toUpperCase(); return s.startsWith('F') ? 'F' : s.startsWith('M') ? 'M' : 'U'; }

function integrateTo(sim, t) {
  const st = sim.state;
  const from = toMin(st.at);
  if (from == null || t <= from) { if (from == null) st.at = fromMin(t); return; }
  const h = (t - from) / 60;
  for (const [k, x] of Object.entries(st.vitals)) {
    if (!x || typeof x.v !== 'number') continue;
    const b = VITAL_BOUNDS[k] || [-Infinity, Infinity];
    x.v = clamp(x.v + (x.r || 0) * h, b[0], b[1]);
  }
  for (const [k, x] of Object.entries(st.labs)) {
    if (!x || typeof x.v !== 'number') continue;
    const b = LAB_BOUNDS[k] || [0, Infinity];
    x.v = clamp(x.v + (x.r || 0) * h, b[0], b[1]);
  }
  st.at = fromMin(t);
}

function normalValue(session, key) {
  const test = getTest(session, key);
  if (!test) return null;
  const sex = sexOf(session);
  const pick = (x) => (x && typeof x === 'object') ? (x[sex] ?? x.F) : x;
  const lo = Number(pick(test.lo) ?? 0), hi = Number(pick(test.hi) ?? lo);
  const u = seeded(`${session.id}:${key}:normal`);
  return lo + (hi - lo) * (0.3 + 0.4 * u);
}

// Current value for a test, creating a normal value for routine tests the
// case never specified. Returns undefined if the AI must decide.
function labValueNow(session, key) {
  const st = session.sim.state;
  if (key === 'ag') {
    const na = labValueNow(session, 'na'), cl = labValueNow(session, 'cl'), hco3 = labValueNow(session, 'hco3');
    if ([na, cl, hco3].some(x => x === undefined)) return undefined;
    return na - cl - hco3;
  }
  if (st.labs[key]) return st.labs[key].v;
  const test = getTest(session, key);
  if (test?.routine) {
    st.labs[key] = { v: normalValue(session, key), r: 0 };
    return st.labs[key].v;
  }
  return undefined;
}

function reportedValue(session, key, value, atMin) {
  const test = getTest(session, key) || {};
  // Small, reproducible analytic variation.
  const u = seeded(`${session.id}:${key}:${atMin}`) - 0.5;
  const v = Number(value) * (1 + u * 0.02);
  return formatValue(test, key === 'ag' ? value : v);
}

function addLabResult(session, key, value, datetime, { exact = false } = {}) {
  const test = getTest(session, key);
  if (!test) return null;
  const sex = sexOf(session);
  const shown = exact ? formatValue(test, value) : reportedValue(session, key, value, toMin(datetime));
  const flag = flagFor(test, Number(shown), sex);
  const cat = test.cat || 'Misc';
  const p = session.patient;
  p.labCategories = ensureArray(p.labCategories);
  let category = p.labCategories.find(c => norm(c.name) === norm(cat));
  if (!category) { category = { name: cat, rows: [] }; p.labCategories.push(category); }
  category.rows = ensureArray(category.rows);
  let row = category.rows.find(r => r.key === key) || category.rows.find(r => norm(r.test) === norm(test.name));
  if (!row) { row = { key, test: test.name, unit: test.unit, referenceRange: refRangeText(test, sex), values: [] }; category.rows.push(row); }
  row.key = key;
  row.values = ensureArray(row.values).filter(v => v.datetime !== datetime);
  row.values.push({ datetime, value: shown, flag });
  row.values.sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)));
  return { key, name: test.name, unit: test.unit, value: shown, flag };
}

function vitalsNow(session) {
  const v = session.sim.state.vitals;
  const g = (k) => v[k]?.v;
  return { hr: g('hr'), sbp: g('sbp'), dbp: g('dbp'), rr: g('rr'), spo2: g('spo2'), temp: g('temp'), pain: g('pain'), o2: session.sim.state.o2 || 'room air' };
}

function recordVitals(session, atMin, note = '') {
  const x = vitalsNow(session);
  const u = (k) => seeded(`${session.id}:vit:${k}:${atMin}`) - 0.5;
  const row = {
    id: uid(),
    datetime: fromMin(atMin),
    temperature_C: x.temp != null ? (x.temp + u('t') * 0.2).toFixed(1) : '',
    hr: x.hr != null ? String(Math.round(x.hr + u('hr') * 4)) : '',
    bp: x.sbp != null ? `${Math.round(x.sbp + u('s') * 6)}/${Math.round(x.dbp + u('d') * 4)}` : '',
    rr: x.rr != null ? String(Math.round(x.rr + u('rr') * 2)) : '',
    spo2: x.spo2 != null ? `${Math.round(clamp(x.spo2 + u('o') * 2, 50, 100))}%` : '',
    oxygen: x.o2,
    pain: x.pain != null ? `${Math.round(x.pain)}/10` : '',
    notes: note
  };
  session.patient.vitals = ensureArray(session.patient.vitals);
  session.patient.vitals.push(row);
  return row;
}

// Objective nursing page when recorded vitals cross common call parameters.
function vitalsPage(row) {
  const sbp = Number(String(row.bp).split('/')[0]);
  const hr = Number(row.hr), rr = Number(row.rr), spo2 = Number(String(row.spo2).replace('%', '')), t = Number(row.temperature_C);
  const hits = [];
  if (sbp && sbp < 90) hits.push(`BP ${row.bp}`);
  if (sbp && sbp > 200) hits.push(`BP ${row.bp}`);
  if (hr && (hr > 130 || hr < 40)) hits.push(`HR ${row.hr}`);
  if (rr && (rr > 28 || rr < 8)) hits.push(`RR ${row.rr}`);
  if (spo2 && spo2 < 90) hits.push(`SpO2 ${row.spo2} on ${row.oxygen}`);
  if (t && t >= 38.5) hits.push(`T ${row.temperature_C}°C`);
  if (!hits.length) return null;
  const urgency = (sbp && sbp < 80) || (spo2 && spo2 < 85) || (hr && hr > 150) ? 'critical' : 'urgent';
  return { text: `RN page: ${hits.join(', ')}.`, urgency };
}

// ------------------------------ initialisation ------------------------------
// Build engine state from the generator output. The public opening labs and
// vitals are rendered from the same state the engine uses later, so the
// opening chart and later results can never disagree.
export function initEngine(session, gen) {
  const phys = gen.physiology || {};
  const presentation = toMin(gen.timeline?.presentationTime) ?? toMin(session.createdSimTime) ?? Math.floor(Date.now() / 60000);
  const drawn = toMin(gen.timeline?.labsDrawnAt) ?? presentation;

  session.engineVersion = ENGINE_VERSION;
  session.world = {
    persona: String(gen.world?.persona || ''),
    history: ensureArray(gen.world?.history).map(h => ({ topic: String(h.topic || ''), answer: String(h.answer || '') })).filter(h => h.answer),
    exam: Object.fromEntries(Object.entries(gen.world?.exam || {}).map(([k, v]) => [norm(k).replace(/ /g, '_'), String(v || '')])),
    studies: {},
    course: gen.world?.course || {},
    customTests: {},
    customStudies: {},
    addedFacts: []
  };
  for (const [k, s] of Object.entries(gen.world?.studies || {})) {
    if (s && (s.report || typeof s === 'string')) session.world.studies[k] = { report: String(s.report || s), title: s.title || STUDIES[k]?.title || k };
  }
  for (const t of ensureArray(phys.customTests)) {
    const key = norm(t.key || t.name).replace(/ /g, '_');
    if (!key) continue;
    session.world.customTests[key] = { name: String(t.name || key), unit: String(t.unit || ''), lo: t.lo ?? null, hi: t.hi ?? null, dp: Number.isFinite(+t.dp) ? +t.dp : 1, cat: t.category || 'Misc', routine: false };
    if (Number.isFinite(+t.value)) (phys.labs ||= {})[key] = +t.value;
  }

  const v = phys.vitals || {};
  const vr = phys.vitalsTrendPerHourUntreated || {};
  const vitals = {};
  for (const k of ['hr', 'sbp', 'dbp', 'rr', 'spo2', 'temp', 'pain']) {
    const val = Number(v[k]);
    if (Number.isFinite(val)) vitals[k] = { v: val, r: Number(vr[k]) || 0 };
  }
  const labs = {};
  const lr = phys.labTrendPerHourUntreated || {};
  for (const [k, val] of Object.entries(phys.labs || {})) {
    if (Number.isFinite(+val) && getTest(session, k)) labs[k] = { v: +val, r: Number(lr[k]) || 0 };
  }

  session.sim = {
    now: fromMin(presentation),
    state: { at: fromMin(drawn), vitals, labs, o2: String(v.o2 || 'room air') },
    events: [],
    vitalsFreqMin: 240,
    nextVitalsAt: null,
    therapyVersion: 0,
    progressedTherapyVersion: 0,
    lastProgressionAt: fromMin(presentation),
    progressionSummary: ''
  };
  session.orders = [];
  session.answerCache = {};
  session.transcript = [];

  // Opening labs drawn at labsDrawnAt.
  const initialKeys = new Set();
  for (const p of ensureArray(phys.initialPanels)) {
    const fromRules = matchLabsForPanel(p);
    fromRules.forEach(k => initialKeys.add(k));
  }
  Object.keys(labs).forEach(k => initialKeys.add(k));
  session.patient.labCategories = ensureArray(session.patient.labCategories);
  for (const k of initialKeys) {
    const val = labValueNow(session, k);
    if (val !== undefined) addLabResult(session, k, val, fromMin(drawn), { exact: true });
  }
  if (initialKeys.has('na') && initialKeys.has('cl') && initialKeys.has('hco3')) addLabResult(session, 'ag', labValueNow(session, 'ag'), fromMin(drawn), { exact: true });

  integrateTo(session.sim, presentation);
  if (Object.keys(vitals).length) recordVitals(session, presentation, 'Triage');

  // The chart's latest timestamp (ED notes etc.) may be after presentation.
  const latest = latestChartMin(session.patient);
  const start = Math.max(presentation, latest ?? presentation);
  integrateTo(session.sim, start);
  session.sim.now = fromMin(start);
  session.sim.nextVitalsAt = fromMin(start + session.sim.vitalsFreqMin);
  return session;
}

function matchLabsForPanel(p) {
  const key = norm(p);
  if (LAB_TESTS[key]) return [key];
  const map = {
    cbc: ['wbc', 'hgb', 'plt', 'mcv', 'neut', 'lymph', 'eos'], lytes: ['na', 'k', 'cl', 'hco3'], electrolytes: ['na', 'k', 'cl', 'hco3'],
    extended_lytes: ['ca', 'mg', 'po4'], renal: ['urea', 'cr'], lfts: ['alt', 'ast', 'alp', 'ggt', 'tbili', 'alb'], coags: ['inr', 'ptt'],
    vbg: ['vph', 'vpco2', 'hco3'], abg: ['aph', 'apco2', 'apo2', 'hco3'], glucose: ['glucose']
  };
  return map[key.replace(/ /g, '_')] || [];
}

export function latestChartMin(p) {
  const out = [];
  const push = (x) => { const n = toMin(x); if (n != null) out.push(n); };
  ensureArray(p?.vitals).forEach(x => push(x.datetime));
  ensureArray(p?.labCategories).forEach(c => ensureArray(c.rows).forEach(r => ensureArray(r.values).forEach(v => push(v.datetime))));
  ensureArray(p?.investigations).forEach(x => push(x.datetime));
  ensureArray(p?.nursingNotes).forEach(x => push(x.datetime));
  ensureArray(p?.notes).forEach(x => push(x.datetime));
  return out.length ? Math.max(...out) : null;
}

// --------------------------------- events -----------------------------------
function schedule(session, dueMin, type, payload = {}) {
  const ev = { id: uid(), due: fromMin(dueMin), type, ...payload };
  session.sim.events.push(ev);
  return ev;
}

function log(session, type, text, extra = {}) {
  session.activity = ensureArray(session.activity);
  session.activity.push({ at: session.sim?.now || '', type, text, ...extra });
}

function nursing(session, atMin, text) {
  session.patient.nursingNotes = ensureArray(session.patient.nursingNotes);
  session.patient.nursingNotes.push({ id: uid(), datetime: fromMin(atMin), author: 'RN', text });
}

// --------------------------------- orders -----------------------------------
const ALLERGY_CLASSES = {
  penicillin: ['penicillin', 'amoxicillin', 'ampicillin', 'piperacillin', 'cloxacillin', 'amoxicillin-clavulanate'],
  sulfa: ['tmp-smx', 'sulfamethoxazole'],
  cephalosporin: ['ceftriaxone', 'cefazolin', 'ceftazidime', 'cefepime'],
  nsaid: ['ibuprofen', 'ketorolac', 'naproxen'],
  opioid: ['morphine', 'hydromorphone', 'fentanyl', 'oxycodone'],
  'contrast': []
};

function allergyConflict(session, medName) {
  const allergies = ensureArray(session.patient?.allergies).map(a => norm(a));
  const m = norm(medName);
  for (const a of allergies) {
    if (!a || /nkda|no known/.test(a)) continue;
    if (m.includes(a) || a.includes(m.split(' ')[0])) return a;
    for (const [cls, members] of Object.entries(ALLERGY_CLASSES)) {
      if (a.includes(cls) && members.some(x => m.includes(x))) return a;
    }
  }
  return null;
}

function labTurnaround(keys, stat) {
  if (keys.some(k => ['vph', 'vpco2', 'aph', 'apco2', 'apo2', 'lactate'].includes(k))) return 15;
  return stat ? 45 : 60;
}

function nextMorning(nowMin) {
  const d = new Date(nowMin * 60000);
  const sixToday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 6, 0) / 60000;
  return sixToday > nowMin + 60 ? sixToday : sixToday + 1440;
}

function publicOrderComment(o) {
  return o.comment || '';
}

// Place a batch of free-text orders. Unrecognised lines are classified by AI
// in a single small call (adapter: ai.classifyOrders).
export async function placeOrders(session, lines, ai) {
  const nowMin = toMin(session.sim.now);
  const parsed = lines.map(text => ({ text, p: parseOrder(text) }));
  const unknown = parsed.filter(x => !x.p).map(x => x.text);
  if (unknown.length && ai?.classifyOrders) {
    try {
      const classified = await ai.classifyOrders(session, unknown);
      for (const x of parsed) if (!x.p) x.p = fromClassification(session, x.text, classified?.[x.text]);
    } catch (err) {
      console.warn('[orders] classification failed:', err?.message || err);
    }
  }

  const results = [];
  for (const { text, p } of parsed) {
    const order = { id: uid(), text, kind: p?.kind || 'unknown', status: 'entered', placedAt: fromMin(nowMin), comment: '' };
    if (!p) {
      order.status = 'unclear';
      order.comment = 'Unable to process order as written. Please clarify.';
    } else if (p.kind === 'stop') {
      applyStop(session, order, p, nowMin);
    } else if (p.kind === 'diagnostic') {
      order.parts = [];
      const collect = p.deferAM ? nextMorning(nowMin) : nowMin + (p.stat ? 5 : 15);
      if (p.labs.length) {
        const due = collect + labTurnaround(p.labs, p.stat) - (p.stat ? 5 : 15);
        const part = { id: uid(), type: 'labs', keys: p.labs, collectAt: fromMin(collect), dueAt: fromMin(Math.max(due, collect + 10)), done: false };
        order.parts.push(part);
        schedule(session, toMin(part.dueAt), 'result', { orderId: order.id, partId: part.id });
      }
      for (const key of p.studies) {
        const s = getStudy(session, key);
        // Imaging/ECG start from the order time; only specimens wait for collection.
        const start = p.deferAM ? collect : (s?.group === 'Microbiology' || s?.group === 'Laboratory' || s?.group === 'Serology') ? collect : nowMin;
        const due = start + (s?.tat || 120);
        const part = { id: uid(), type: 'study', key, collectAt: fromMin(collect), dueAt: fromMin(due), done: false };
        order.parts.push(part);
        schedule(session, due, 'result', { orderId: order.id, partId: part.id });
      }
      order.status = 'pending';
      order.comment = p.deferAM ? `Scheduled for collection ${fromMin(collect)}.` : 'Result pending.';
    } else if (p.kind === 'med' || p.kind === 'fluid') {
      const conflict = allergyConflict(session, p.name);
      const med = { id: uid(), name: p.name, dose: p.dose || '', route: p.route || '', frequency: p.frequency || (p.oneTime ? 'once' : ''), status: 'active', start: fromMin(nowMin), stop: '', comments: `Order: ${text}` };
      if (conflict) {
        order.status = 'on hold';
        order.comment = `Pharmacy: held for review. Documented allergy: ${conflict}.`;
        med.status = 'on hold';
        med.comments += ` | Held: allergy (${conflict})`;
      } else {
        order.status = 'active';
        order.comment = 'Order verified.';
        const adminAt = nowMin + (/\bstat\b/i.test(text) ? 10 : 30);
        schedule(session, adminAt, 'med_admin', { orderId: order.id, medId: med.id, oneTime: !!p.oneTime });
        session.sim.therapyVersion += 1;
      }
      order.medId = med.id;
      session.patient.medications = ensureArray(session.patient.medications);
      session.patient.medications.push(med);
    } else if (p.kind === 'nursing') {
      order.status = 'active';
      order.comment = 'Acknowledged by nursing.';
      if (p.key === 'vitals' && p.freqMin) {
        session.sim.vitalsFreqMin = clamp(p.freqMin, 15, 720);
        session.sim.nextVitalsAt = fromMin(nowMin + session.sim.vitalsFreqMin);
      }
      if (p.key === 'oxygen') {
        session.sim.state.o2 = describeOxygen(text);
        schedule(session, nowMin + 10, 'nursing', { text: `Oxygen applied: ${session.sim.state.o2}.` });
      }
      if (p.therapeutic) session.sim.therapyVersion += 1;
    } else if (p.kind === 'procedure') {
      order.status = 'pending';
      order.comment = 'Request received.';
      schedule(session, nowMin + 120, 'procedure', { orderId: order.id, text });
      session.sim.therapyVersion += 1;
    } else if (p.kind === 'consult') {
      order.status = 'acknowledged';
      order.comment = 'Consult request sent.';
      schedule(session, nowMin + 60, 'nursing', { text: `${p.service || 'Consult service'} notified of consult request; will assess.` });
    } else if (p.kind === 'disposition') {
      order.status = 'acknowledged';
      order.comment = 'Bed request entered.';
      if (p.therapeutic) {
        const to = /ccu/i.test(text) ? 'CCU' : /step-?down/i.test(text) ? 'Step-down unit' : 'ICU';
        schedule(session, nowMin + 90, 'transfer', { orderId: order.id, to });
        session.sim.therapyVersion += 1;
      }
    } else {
      order.status = 'acknowledged';
      order.comment = 'Acknowledged.';
    }
    session.orders = ensureArray(session.orders);
    session.orders.push(order);
    session.orderHistory = ensureArray(session.orderHistory);
    session.orderHistory.push({ at: order.placedAt, order: text, status: order.status, comment: publicOrderComment(order) });
    results.push({ order: text, status: order.status, comment: publicOrderComment(order) });
  }
  nursing(session, nowMin, `Orders received and acknowledged: ${lines.join('; ')}`);
  log(session, 'orders', lines.join('\n'));
  return results;
}

function describeOxygen(text) {
  const t = String(text);
  const flow = (t.match(/(\d+(?:\.\d+)?)\s*(l|lpm|l\/min)\b/i) || [])[1];
  const fio2 = (t.match(/(\d{2,3})\s*%/) || [])[1];
  if (/bipap|niv/i.test(t)) return 'BiPAP';
  if (/cpap/i.test(t)) return 'CPAP';
  if (/intubat|mechanical ventilation/i.test(t)) return 'Mechanical ventilation';
  if (/high[- ]flow|hfnc|optiflow/i.test(t)) return `High-flow nasal cannula${flow ? ` ${flow} L/min` : ''}${fio2 ? ` FiO2 ${fio2}%` : ''}`;
  if (/non-?rebreather|nrb/i.test(t)) return 'Non-rebreather 15 L/min';
  if (/venturi/i.test(t)) return `Venturi mask${fio2 ? ` ${fio2}%` : ''}`;
  if (/room air|wean (off|to ra)|stop o2|d\/c o2/i.test(t)) return 'room air';
  return `Nasal prongs${flow ? ` ${flow} L/min` : ' 2 L/min'}`;
}

function fromClassification(session, text, c) {
  if (!c || typeof c !== 'object') return null;
  const kind = String(c.kind || '').toLowerCase();
  if (kind === 'lab' && c.test) {
    const key = norm(c.test.key || c.test.name).replace(/ /g, '_');
    if (!getTest(session, key)) {
      session.world.customTests[key] = { name: String(c.test.name || key), unit: String(c.test.unit || ''), lo: c.test.lo ?? null, hi: c.test.hi ?? null, dp: Number.isFinite(+c.test.dp) ? +c.test.dp : 1, cat: c.test.category || 'Misc', routine: false };
    }
    return { kind: 'diagnostic', labs: [key], studies: [], stat: /\bstat\b/i.test(text), deferAM: false, text };
  }
  if (kind === 'study' && c.study) {
    const key = norm(c.study.key || c.study.title).replace(/ /g, '_');
    if (!getStudy(session, key)) {
      session.world.customStudies[key] = { title: String(c.study.title || text), group: String(c.study.group || 'Other'), tat: clamp(Number(c.study.turnaroundMinutes) || 240, 10, 10080) };
    }
    return { kind: 'diagnostic', labs: [], studies: [key], stat: false, deferAM: false, text };
  }
  if (kind === 'med' || kind === 'fluid') {
    const d = parseMedDetails(text);
    return { kind, name: String(c.name || matchMedication(text) || text).slice(0, 80), dose: c.dose || d.dose, route: c.route || d.route, frequency: c.frequency || d.frequency, oneTime: !!c.oneTime, therapeutic: true, text };
  }
  if (kind === 'nursing') return { kind: 'nursing', key: 'other', therapeutic: !!c.therapeutic, text };
  if (kind === 'procedure') return { kind: 'procedure', key: 'procedure', therapeutic: true, text };
  if (kind === 'consult') return { kind: 'consult', service: c.service || 'Consult service', text };
  if (kind === 'disposition') return { kind: 'disposition', therapeutic: /icu|ccu|step/i.test(text), text };
  if (kind === 'stop') return { kind: 'stop', action: c.action || 'discontinue', target: c.target || text, text };
  return null;
}

function applyStop(session, order, p, nowMin) {
  const target = norm(p.target);
  const meds = ensureArray(session.patient.medications);
  const medName = matchMedication(p.target);
  const activeMed = meds.filter(m => ['active', 'on hold', 'held'].includes(String(m.status).toLowerCase()))
    .find(m => (medName && norm(m.name) === norm(medName)) || (target && (norm(m.name).includes(target) || target.includes(norm(m.name)))));
  if (activeMed && p.action !== 'cancel') {
    activeMed.status = p.action === 'hold' ? 'held' : 'discontinued';
    if (p.action !== 'hold') activeMed.stop = fromMin(nowMin);
    activeMed.comments = `${activeMed.comments || ''} | ${p.action === 'hold' ? 'Held' : 'Discontinued'} ${fromMin(nowMin)}`.replace(/^ \| /, '');
    // Remove any not-yet-given doses.
    session.sim.events = session.sim.events.filter(e => !(e.type === 'med_admin' && e.medId === activeMed.id));
    const src = ensureArray(session.orders).find(o => o.medId === activeMed.id);
    if (src) src.status = activeMed.status;
    session.sim.therapyVersion += 1;
    order.status = 'completed';
    order.comment = `${activeMed.name} ${activeMed.status}.`;
    return;
  }
  const pendingOrder = ensureArray(session.orders).filter(o => ['pending', 'active', 'acknowledged'].includes(o.status))
    .reverse().find(o => target && (norm(o.text).includes(target) || target.includes(norm(o.text))));
  if (pendingOrder) {
    pendingOrder.status = 'cancelled';
    pendingOrder.comment = `Cancelled ${fromMin(nowMin)}.`;
    session.sim.events = session.sim.events.filter(e => e.orderId !== pendingOrder.id);
    if (pendingOrder.medId) {
      const m = meds.find(x => x.id === pendingOrder.medId);
      if (m) { m.status = 'discontinued'; m.stop = fromMin(nowMin); }
      session.sim.therapyVersion += 1;
    }
    order.status = 'completed';
    order.comment = `Cancelled: ${pendingOrder.text}.`;
    return;
  }
  order.status = 'unclear';
  order.comment = 'No matching active order or medication found.';
}

// --------------------------------- advance ----------------------------------
function activeTherapies(session) {
  const meds = ensureArray(session.patient.medications)
    .filter(m => ['active', 'completed', 'given'].includes(String(m.status).toLowerCase()) && m.start)
    .map(m => `${m.name} ${m.dose} ${m.route} ${m.frequency} (${m.status}, from ${m.start}${m.stop ? ` to ${m.stop}` : ''})`.replace(/\s+/g, ' '));
  const other = ensureArray(session.orders).filter(o => ['procedure', 'nursing', 'disposition'].includes(o.kind) && !['cancelled', 'unclear'].includes(o.status)).map(o => `${o.text} (${o.status}, ${o.placedAt})`);
  return { medications: meds, otherOrders: other.slice(-20), oxygen: session.sim.state.o2 };
}

export function stateSnapshot(session) {
  const st = session.sim.state;
  const labs = {};
  for (const [k, x] of Object.entries(st.labs)) labs[k] = { value: Math.round(x.v * 100) / 100, perHour: x.r };
  const vitals = {};
  for (const [k, x] of Object.entries(st.vitals)) vitals[k] = { value: Math.round(x.v * 10) / 10, perHour: x.r };
  return { time: session.sim.now, vitals, labs, oxygen: st.o2 };
}

function applyProgression(session, out, nowMin) {
  const st = session.sim.state;
  const num = (x) => (Number.isFinite(+x) ? +x : null);
  for (const [k, r] of Object.entries(out?.vitalsRates || {})) if (st.vitals[k] && num(r) != null) st.vitals[k].r = clamp(+r, -50, 50);
  for (const [k, val] of Object.entries(out?.setVitals || {})) if (num(val) != null && VITAL_BOUNDS[k]) (st.vitals[k] ||= { v: 0, r: 0 }).v = clamp(+val, ...VITAL_BOUNDS[k]);
  for (const [k, r] of Object.entries(out?.labRates || {})) {
    if (num(r) == null || !getTest(session, k)) continue;
    if (!st.labs[k]) { const cur = labValueNow(session, k); if (cur === undefined) continue; }
    st.labs[k].r = +r;
  }
  for (const [k, val] of Object.entries(out?.setLabs || {})) if (num(val) != null && getTest(session, k)) (st.labs[k] ||= { v: 0, r: 0 }).v = Math.max(0, +val);
  if (typeof out?.oxygen === 'string' && out.oxygen.trim()) st.o2 = out.oxygen.trim().slice(0, 80);
  for (const ev of ensureArray(out?.events).slice(0, 4)) {
    const off = clamp(Number(ev.offsetMin) || 30, 5, 720);
    const text = String(ev.text || '').trim().slice(0, 400);
    if (text) schedule(session, nowMin + off, 'nursing', { text, urgency: ['routine', 'urgent', 'critical'].includes(ev.urgency) ? ev.urgency : 'routine', fromProgression: true });
  }
  if (out?.summary) session.sim.progressionSummary = String(out.summary).slice(0, 600);
  if (out?.deceased === true) session.sim.deceased = true;
}

// Resolve results the hidden case did not pre-specify (one AI call per advance).
async function resolveUnknown(session, dueEvents, ai) {
  const needTests = new Set();
  const needStudies = new Set();
  for (const ev of dueEvents) {
    if (ev.type !== 'result') continue;
    const order = session.orders.find(o => o.id === ev.orderId);
    const part = order?.parts?.find(p => p.id === ev.partId);
    if (!part) continue;
    if (part.type === 'labs') part.keys.forEach(k => { if (k !== 'ag' && labValueNow(session, k) === undefined) needTests.add(k); });
    if (part.type === 'study' && !session.world.studies[part.key]) needStudies.add(part.key);
  }
  if (!needTests.size && !needStudies.size) return;
  let out = null;
  if (ai?.resolveResults) {
    try {
      out = await ai.resolveResults(session, {
        tests: [...needTests].map(k => { const t = getTest(session, k); return { key: k, name: t.name, unit: t.unit, referenceRange: refRangeText(t, sexOf(session)) }; }),
        studies: [...needStudies].map(k => ({ key: k, title: getStudy(session, k)?.title || k }))
      });
    } catch (err) { console.warn('[advance] resolveResults failed:', err?.message || err); }
  }
  for (const k of needTests) {
    const r = out?.labs?.[k];
    const v = Number(r?.value);
    session.sim.state.labs[k] = Number.isFinite(v) ? { v, r: Number(r?.perHour) || 0 } : { v: normalValue(session, k) ?? 0, r: 0 };
  }
  for (const k of needStudies) {
    const rep = out?.studies?.[k]?.report;
    session.world.studies[k] = { title: getStudy(session, k)?.title || k, report: rep ? String(rep) : 'Report unavailable. Please contact the department.' };
  }
}

function needsProgression(session, targetMin) {
  const sim = session.sim;
  if (sim.therapyVersion !== sim.progressedTherapyVersion) return true;
  const last = toMin(sim.lastProgressionAt) ?? toMin(sim.now);
  return targetMin - last >= 360;
}

export async function advance(session, { mode = 'next', minutes = 60 } = {}, ai) {
  const sim = session.sim;
  const nowMin = toMin(sim.now);
  let target;
  if (mode === 'next') {
    const dues = sim.events.map(e => toMin(e.due)).filter(n => n != null && n > nowMin);
    const nv = toMin(sim.nextVitalsAt);
    if (nv != null && nv > nowMin) dues.push(nv);
    target = dues.length ? Math.min(...dues) : nowMin + 60;
    target = Math.min(target, nowMin + 720);
  } else {
    target = nowMin + clamp(Math.round(Number(minutes) || 60), 5, 1440);
  }

  let progressed = false;
  if (needsProgression(session, target) && ai?.progress) {
    try {
      const out = await ai.progress(session, { fromTime: sim.now, toTime: fromMin(target), therapies: activeTherapies(session), state: stateSnapshot(session) });
      applyProgression(session, out, nowMin);
      progressed = true;
    } catch (err) {
      console.warn('[advance] progression failed; continuing deterministically:', err?.message || err);
    }
    sim.progressedTherapyVersion = sim.therapyVersion;
    sim.lastProgressionAt = sim.now;
  }

  // Add routine vitals up to target.
  let nv = toMin(sim.nextVitalsAt);
  while (nv != null && nv <= target) {
    schedule(session, nv, 'vitals');
    nv += sim.vitalsFreqMin;
  }
  sim.nextVitalsAt = fromMin(nv ?? target + sim.vitalsFreqMin);

  const due = sim.events.filter(e => toMin(e.due) <= target).sort((a, b) => toMin(a.due) - toMin(b.due));
  sim.events = sim.events.filter(e => toMin(e.due) > target);
  await resolveUnknown(session, due, ai);

  const notices = [];
  let urgency = 'none';
  const bump = (u) => { const r = { none: 0, routine: 1, urgent: 2, critical: 3 }; if (r[u] > r[urgency]) urgency = u; };

  for (const ev of due) {
    const t = toMin(ev.due);
    integrateTo(sim, t);
    sim.now = fromMin(t);
    if (ev.type === 'result') {
      const order = session.orders.find(o => o.id === ev.orderId);
      const part = order?.parts?.find(p => p.id === ev.partId);
      if (!order || !part || part.done || order.status === 'cancelled') continue;
      if (part.type === 'labs') {
        const shown = [];
        const collect = part.collectAt;
        for (const k of part.keys) {
          const v = labValueNow(session, k);
          if (v === undefined) continue;
          // Value at collection time, back-projected along the current trend.
          const back = (t - toMin(collect)) / 60;
          const atCollect = k === 'ag' ? v : v - (session.sim.state.labs[k]?.r || 0) * back;
          const r = addLabResult(session, k, atCollect, collect);
          if (r) shown.push(r);
        }
        const keys = new Set(part.keys);
        if (keys.has('na') && keys.has('cl') && keys.has('hco3') && !keys.has('ag')) addLabResult(session, 'ag', labValueNow(session, 'ag'), collect);
        const crit = shown.filter(r => r.flag === 'critical');
        if (crit.length) {
          notices.push({ at: sim.now, text: `Lab calling critical value: ${crit.map(r => `${r.name} ${r.value} ${r.unit}`.trim()).join('; ')}.`, urgency: 'urgent' });
          bump('urgent');
        } else {
          notices.push({ at: sim.now, text: `Lab results available: ${shown.map(r => r.name).join(', ')}.`, urgency: 'routine' });
          bump('routine');
        }
      } else {
        const st = getStudy(session, part.key);
        const rep = session.world.studies[part.key];
        session.patient.investigations = ensureArray(session.patient.investigations);
        session.patient.investigations.push({ id: uid(), datetime: sim.now, group: st?.group || 'Other', title: st?.title || rep?.title || part.key, status: 'Final', report: rep?.report || 'Report unavailable.' });
        notices.push({ at: sim.now, text: `${st?.group === 'Imaging' ? 'Radiology' : st?.group === 'ECG' ? 'ECG' : st?.group || 'Result'}: ${st?.title || part.key} report available.`, urgency: 'routine' });
        bump('routine');
      }
      part.done = true;
      if (order.parts.every(p => p.done)) { order.status = 'resulted'; order.comment = `Resulted ${sim.now}.`; }
      else order.status = 'partially resulted';
    } else if (ev.type === 'med_admin') {
      const med = ensureArray(session.patient.medications).find(m => m.id === ev.medId);
      if (!med || !['active'].includes(String(med.status).toLowerCase())) continue;
      nursing(session, t, `${[med.name, med.dose, med.route].filter(Boolean).join(' ')} administered.`);
      if (ev.oneTime) {
        med.status = 'completed';
        med.stop = sim.now;
        const o = session.orders.find(x => x.id === ev.orderId);
        if (o) o.status = 'completed';
      }
    } else if (ev.type === 'vitals') {
      const row = recordVitals(session, t);
      const page = vitalsPage(row);
      if (page) { notices.push({ at: sim.now, ...page }); bump(page.urgency); nursing(session, t, page.text.replace('RN page: ', 'Physician paged: ')); }
    } else if (ev.type === 'nursing') {
      nursing(session, t, ev.text);
      if (ev.urgency && ev.urgency !== 'routine') { notices.push({ at: sim.now, text: `RN: ${ev.text}`, urgency: ev.urgency }); bump(ev.urgency); }
      else if (ev.fromProgression) { notices.push({ at: sim.now, text: `RN: ${ev.text}`, urgency: 'routine' }); bump('routine'); }
    } else if (ev.type === 'procedure') {
      const o = session.orders.find(x => x.id === ev.orderId);
      if (!o || o.status === 'cancelled') continue;
      o.status = 'completed';
      o.comment = `Completed ${sim.now}.`;
      nursing(session, t, `Procedure completed: ${ev.text}.`);
      notices.push({ at: sim.now, text: `Procedure completed: ${ev.text}.`, urgency: 'routine' });
      bump('routine');
    } else if (ev.type === 'transfer') {
      const o = session.orders.find(x => x.id === ev.orderId);
      if (!o || o.status === 'cancelled') continue;
      session.patient.location = ev.to;
      o.status = 'completed';
      nursing(session, t, `Patient transferred to ${ev.to}.`);
      notices.push({ at: sim.now, text: `Patient transferred to ${ev.to}.`, urgency: 'routine' });
      bump('routine');
    }
  }
  integrateTo(sim, target);
  sim.now = fromMin(target);

  const summary = notices.length ? notices.map(n => n.text).join('\n') : 'No new events.';
  log(session, 'advance', summary, { urgency });
  return { notices, urgency, progressed, event: summary };
}

// ------------------------------- interaction --------------------------------
const EXAM_RE = /\b(exam|examine|examination|auscultat\w*|palpat\w*|percuss\w*|inspect\w*|listen to|look at|check (his|her|their|the)\b|jvp|murmurs?|reflexes|pupils?|gait|cranial nerves|fundoscop\w*|rectal|dre|pelvic exam|power|tone|sensation|cerebellar|asterixis|edema|oedema|capillary refill|head to toe|physical)\b/;
const SYSTEMS = {
  general: /\b(general|appearance|overall|distress|looks?)\b/,
  heent: /\b(heent|head|eyes?|ears?|nose|throat|mouth|oropharynx|mucous|sclera|conjunctiva|fundus|fundoscop\w*|neck|lymph|thyroid|pupils?)\b/,
  cardiovascular: /\b(heart|cardiac|cardio\w*|cvs|cv|jvp|murmurs?|precordium|heart sounds|pulses?)\b/,
  respiratory: /\b(lungs?|chest|resp\w*|breath sounds|air entry|crackles|wheeze)\b/,
  abdominal: /\b(abdo\w*|abdomen|belly|liver|spleen|murphy\w*|bowel sounds|ascites|rebound|guarding|mcburney)\b/,
  neurological: /\b(neuro\w*|cranial nerves|reflexes|power|tone|sensation|gait|cerebellar|asterixis|gcs|orientation|mental status|confus\w*|babinski|romberg|pronator)\b/,
  musculoskeletal: /\b(msk|joints?|spine|back|musculoskeletal|knee|hip|shoulder)\b/,
  skin: /\b(skin|rash|wounds?|lesions?|derm\w*|jaundice|petechiae|bruising)\b/,
  extremities: /\b(extremit\w*|legs?|calf|calves|feet|ankles?|edema|oedema|capillary refill|clubbing|hands?)\b/,
  genitourinary: /\b(genital\w*|gu|pelvic|rectal|dre|testic\w*|cva|costovertebral)\b/
};
const SPECIFIC_MANEUVERS = /\b(murphy|kernig|brudzinski|babinski|romberg|asterixis|fundoscop\w*|rectal|dre|pelvic|pronator|dix|hallpike|straight leg|mcburney|rovsing|psoas|obturator|tinel|phalen|shifting dullness|fluid wave|orthostatic|postural|tilt|trousseau|chvostek|kussmaul|pulsus|kussmaul|hepatojugular|abdominojugular|clonus|hoffman|nikolsky|lachman|mcmurray|homan)\b/g;

function examSystems(text) {
  const t = norm(text);
  if (/\b(full|complete|head to toe|entire|whole) (physical )?exam|\bfull physical\b/.test(t)) return Object.keys(SYSTEMS);
  return Object.entries(SYSTEMS).filter(([, re]) => re.test(t)).map(([k]) => k);
}

const VITALS_RE = /^(check |get |repeat |take |measure |what are (the |his |her |their )?(current )?)?(set of )?(vitals|vital signs|bp|blood pressure|heart rate|hr|sats|o2 sat\w*|oxygen saturation|temperature|temp|resp(iratory)? rate)\b/;

export function containsHiddenDiagnosis(session, text) {
  const dx = norm(session.lock?.primaryDiagnosis || '');
  if (!dx || dx.length < 4) return false;
  const t = norm(text);
  if (!t.includes(dx)) return false;
  // Already part of the visible chart (e.g. a known chronic condition)?
  const chart = norm(JSON.stringify({ n: session.patient?.notes, i: session.patient?.investigations, b: session.patient?.banner, c: session.patient?.presentingComplaint }));
  return !chart.includes(dx);
}

export async function interact(session, request, ai) {
  const key = norm(request);
  session.answerCache ||= {};
  session.transcript = ensureArray(session.transcript);
  const nowMin = toMin(session.sim.now);
  let response = session.answerCache[key];
  let source = 'cache';

  if (!response && VITALS_RE.test(key) && !EXAM_RE.test(key.replace(/^(check|take|measure)\b/, ''))) {
    const row = recordVitals(session, nowMin, 'Spot check');
    response = `Vitals ${row.datetime}: T ${row.temperature_C}°C, HR ${row.hr}, BP ${row.bp}, RR ${row.rr}, SpO2 ${row.spo2} on ${row.oxygen}${row.pain ? `, pain ${row.pain}` : ''}.`;
    source = 'state';
  }

  if (!response && EXAM_RE.test(key)) {
    const systems = examSystems(request);
    const found = systems.filter(s => session.world?.exam?.[s]);
    const specific = (key.match(SPECIFIC_MANEUVERS) || []).filter(m => !found.some(s => norm(session.world.exam[s]).includes(m.slice(0, 5))));
    if (found.length && found.length === systems.length && !specific.length) {
      response = found.map(s => `${s[0].toUpperCase()}${s.slice(1)}: ${session.world.exam[s]}`).join('\n');
      source = 'world';
    }
  }

  if (!response) {
    const out = ai?.answer ? await ai.answer(session, request) : null;
    response = String(out?.response || 'No further information available.').trim();
    if (containsHiddenDiagnosis(session, response) && ai?.answer) {
      const retry = await ai.answer(session, request, { strict: true });
      response = String(retry?.response || '').trim();
      if (!response || containsHiddenDiagnosis(session, response)) response = 'No further information available.';
    }
    for (const f of ensureArray(out?.newFacts).slice(0, 5)) {
      const fact = String(f || '').trim().slice(0, 300);
      if (fact) session.world.addedFacts.push(fact);
    }
    if (session.world.addedFacts.length > 80) session.world.addedFacts = session.world.addedFacts.slice(-80);
    source = 'ai';
  }

  // Do not cache spot vitals: a later check should reflect the later state.
  if (source !== 'state') {
    session.answerCache[key] = response;
    const keys = Object.keys(session.answerCache);
    if (keys.length > 300) delete session.answerCache[keys[0]];
  }
  session.transcript.push({ at: session.sim.now, q: request, a: response, source });
  if (session.transcript.length > 400) session.transcript = session.transcript.slice(-400);
  log(session, 'learner_request', request);
  log(session, 'case_response', response);
  return { response, source };
}

// ---------------------------- public projection -----------------------------
export function publicOrders(session) {
  return ensureArray(session.orders).map(o => ({
    id: o.id, datetime: o.placedAt, order: o.text, kind: o.kind, status: o.status, comment: o.comment || ''
  }));
}

export function pendingList(session) {
  return ensureArray(session.orders).filter(o => ['pending', 'partially resulted'].includes(o.status)).map(o => ({ id: o.id, order: o.text, placedAt: o.placedAt }));
}

export function sortLabCategories(cats) {
  return ensureArray(cats).sort((a, b) => {
    const ia = LAB_CATEGORY_ORDER.indexOf(a.name), ib = LAB_CATEGORY_ORDER.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
}
