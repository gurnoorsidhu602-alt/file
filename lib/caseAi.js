// lib/caseAi.js
// All model calls used by the Medical Case Simulator. Each call receives only
// the slice of the hidden case it needs (never the whole chart, except the
// final debrief), so per-action cost stays flat as the case gets longer.

import { aiJSON, CASE_MODEL, CASE_FAST_MODEL, envInt } from './ai.js';
import { catalogKeysForPrompt } from './caseCatalog.js';
import { ensureArray, stateSnapshot } from './caseEngine.js';

const MOCK = () => process.env.MOCK_AI === '1';
const CASE_GEN_MAX_OUTPUT_TOKENS = envInt('OPENAI_CASE_GEN_MAX_OUTPUT_TOKENS', 18000);

const NO_TEACHING = `You are the patient/chart/exam environment, not a teacher.
- Never name, hint at, or rank diagnoses. Never interpret findings. Never suggest tests, treatment, or next steps.
- Give only the specific information requested, in objective clinical language.
- Canadian practice and SI units only.`;

// ------------------------------- generation ---------------------------------
const GEN_SCHEMA = `Return JSON with exactly this top-level shape:
{
  "caseTitle": "short NON-diagnostic title, e.g. 'Abdominal pain and vomiting'",
  "lock": {
    "primaryDiagnosis": "the hidden locked diagnosis",
    "secondaryDiagnoses": ["relevant comorbidities/complications"],
    "caseFingerprint": "brief fingerprint for duplicate avoidance",
    "expectedKeyActions": ["diagnostic and management actions a strong trainee would take"],
    "dangerousActions": ["actions that would worsen this patient"],
    "exclusionEntry": "one-line exclusion entry: diagnosis + distinctive features"
  },
  "timeline": { "presentationTime": "YYYY-MM-DD HH:mm", "labsDrawnAt": "YYYY-MM-DD HH:mm" },
  "patient": {
    "displayName": "Last, First", "age": 55, "sex": "F|M", "location": "ED | ward | clinic referral",
    "allergies": ["..."], "codeStatus": "Full Code", "presentingComplaint": "non-diagnostic", "banner": "one-line non-diagnostic banner",
    "investigations": [{"datetime":"YYYY-MM-DD HH:mm","group":"Imaging|ECG|Microbiology|Laboratory|Other","title":"","status":"Final","report":"objective report"}],
    "nursingNotes": [{"datetime":"YYYY-MM-DD HH:mm","author":"RN","text":"objective note <= 280 chars"}],
    "medications": [{"name":"","dose":"","route":"","frequency":"","status":"active|discontinued|completed","start":"YYYY-MM-DD HH:mm","stop":"","comments":""}],
    "notes": [{"datetime":"YYYY-MM-DD HH:mm","service":"","providerName":"","noteType":"Triage|ED note|Consult request|Progress note","title":"","text":"terse EMR text <= 700 chars"}]
  },
  "physiology": {
    "vitals": {"hr":0,"sbp":0,"dbp":0,"rr":0,"spo2":0,"temp":0,"pain":0,"o2":"room air"},
    "vitalsTrendPerHourUntreated": {"hr":0,"sbp":0,"dbp":0,"rr":0,"spo2":0,"temp":0},
    "labs": {"<catalog key>": 0},
    "labTrendPerHourUntreated": {"<catalog key>": 0},
    "customTests": [{"key":"snake_case","name":"","unit":"SI unit","lo":0,"hi":0,"dp":1,"category":"Chemistry|Hematology|Serology|Urine|Misc","value":0}],
    "initialPanels": ["cbc","lytes","renal","glucose","lfts","coags","vbg"]
  },
  "world": {
    "persona": "how the patient speaks and how reliable a historian they are",
    "history": [{"topic":"short topic","answer":"fact as the patient/collateral would give it"}],
    "exam": {"general":"","heent":"","cardiovascular":"","respiratory":"","abdominal":"","neurological":"","musculoskeletal":"","skin":"","extremities":"","genitourinary":""},
    "studies": {"<catalog study key>": {"report": "objective report as it would read if ordered now"}},
    "course": {"untreated": "how the illness evolves without appropriate care (hidden)", "withAppropriateCare": "expected response and time course", "harmfulActions": "what specific wrong actions would cause"}
  }
}
Rules for the hidden world:
- physiology.labs: initial values (at labsDrawnAt) for EVERY catalog test that is abnormal now or would become abnormal for this patient. Unlisted routine tests are treated as normal.
- Use catalog keys exactly. Use customTests only for tests not in the catalog (e.g. urine porphobilinogen).
- Trends are per hour WITHOUT treatment; keep them physiologically plausible.
- history: 18-30 items covering HPI details, PMH, PSH, medications, allergies, social, family, travel/exposures, ROS by system, and anything a good history would uncover. Include pertinent negatives.
- exam: objective findings for every system, specific enough to answer focused questions (include pertinent negatives and named signs where relevant).
- studies: reports for the 6-12 investigations a learner is most likely to order for this presentation, using catalog study keys.
- Opening chart: compact. 1-4 investigations, 2-5 nursing notes, 0-6 medications, 1-4 notes. Do not include lab tables or vitals in patient; the engine renders them from physiology.
- Public chart text must not reveal the hidden diagnosis unless it is a genuinely pre-existing known diagnosis.`;

export async function generateCase({ mode, specialty, difficulty, exclusionText, userId, meta }) {
  if (MOCK()) return mockGeneration();
  const system = `You are the hidden case-authoring engine for an EMR-style Medical Case Simulator for Canadian medical trainees.
Generate one realistic patient. Lock one primary diagnosis now; it must never change.
- Regular mode: reflect real-world clinical probabilities and common presentations.
- Zebra mode: rare, atypical, confusing or complicated, but medically coherent.
- Difficulty (Easy..Brutal) controls subtlety, confounders and comorbidity, not incoherence.
- Do not repeat or closely mimic anything in the exclusion list.
- EMR text: terse, objective, chronological, realistically incomplete. No teaching, hints or interpretation.
- If the setting is a pending CTU/GIM/Internal Medicine consult (including ED consult to Medicine), the Medicine assessment is still pending: do NOT include any Internal Medicine/CTU consult note, admission note, assessment/plan or recommendations. ED triage, ED physician notes, consult request, nursing notes and existing results are fine.
- Canadian/SI units only.
${GEN_SCHEMA}`;
  const payload = {
    requestedMode: mode,
    requestedSetting: specialty || 'undifferentiated adult ED/inpatient medicine',
    requestedDifficulty: difficulty,
    exclusionList: String(exclusionText || '').slice(-30000),
    catalog: catalogKeysForPrompt(),
    referenceDate: new Date().toISOString().slice(0, 10)
  };
  const validate = (g) => {
    if (!g.lock?.primaryDiagnosis) return 'missing lock.primaryDiagnosis';
    if (!g.patient || typeof g.patient !== 'object') return 'missing patient';
    if (!g.world || !ensureArray(g.world.history).length || !g.world.exam) return 'missing world history/exam';
    if (!g.physiology?.vitals) return 'missing physiology.vitals';
    return '';
  };
  return aiJSON({ tag: 'case.generate', meta, system, payload, model: CASE_MODEL, temperature: mode === 'zebra' ? 0.8 : 0.35, max_output_tokens: CASE_GEN_MAX_OUTPUT_TOKENS, reasoning_effort: 'medium', validate, retries: 1 });
}

// ------------------------------- per-action calls ----------------------------
function hiddenSummary(session) {
  return {
    primaryDiagnosis: session.lock?.primaryDiagnosis,
    secondaryDiagnoses: session.lock?.secondaryDiagnoses,
    course: session.world?.course,
    patient: { age: session.patient?.age, sex: session.patient?.sex, location: session.patient?.location, presentingComplaint: session.patient?.presentingComplaint }
  };
}

export function caseAiAdapter(meta) {
  return {
    async answer(session, request, opts = {}) {
      if (MOCK()) return mockAnswer(session, request);
      const system = `${NO_TEACHING}
Answer the learner's request using the stored case facts. History questions: answer in the patient's voice (or collateral if the patient cannot answer), consistent with the persona, including uncertainty where realistic. Examination: objective findings only, consistent with the stored exam. Chart review: only information plausibly already documented.
Stay consistent with storedFacts and recentExchanges. If you must invent a new detail, keep it consistent with the hidden diagnosis and list it in newFacts so it stays fixed.
${opts.strict ? 'STRICT: your previous answer disclosed or implied the hidden diagnosis. Do not mention it.' : ''}
Return {"response":"text shown to the learner","newFacts":["short facts you introduced"]}.`;
      const payload = {
        hidden: hiddenSummary(session),
        persona: session.world?.persona,
        history: session.world?.history,
        exam: session.world?.exam,
        storedFacts: ensureArray(session.world?.addedFacts).slice(-40),
        current: { time: session.sim?.now, vitals: stateSnapshot(session).vitals, oxygen: session.sim?.state?.o2, location: session.patient?.location, activeMedications: ensureArray(session.patient?.medications).filter(m => m.status === 'active').map(m => m.name) },
        recentExchanges: ensureArray(session.transcript).slice(-6).map(t => ({ q: t.q, a: t.a })),
        request
      };
      return aiJSON({ tag: 'case.interact', meta, system, payload, model: CASE_FAST_MODEL, max_output_tokens: 900, reasoning_effort: 'low', validate: (o) => (typeof o.response === 'string' ? '' : 'missing response') });
    },

    async classifyOrders(session, orders) {
      if (MOCK()) return Object.fromEntries(orders.map(o => [o, { kind: 'nursing' }]));
      const system = `Classify free-text hospital orders for an EMR. Do not judge appropriateness.
Return {"orders":[{"text":"exact input","kind":"lab|study|med|fluid|nursing|procedure|consult|disposition|stop|unclear",
"test":{"key":"snake_case","name":"","unit":"SI","lo":0,"hi":0,"dp":1,"category":"Chemistry|Hematology|Serology|Urine|Misc"},
"study":{"key":"snake_case","title":"","group":"Imaging|ECG|Microbiology|Laboratory|Serology|Other","turnaroundMinutes":0},
"name":"medication name","dose":"","route":"","frequency":"","oneTime":false,"service":"","action":"discontinue|hold|cancel","target":"","therapeutic":false}]}
Include only the fields relevant to each kind. Prefer these catalog keys when one matches: ${JSON.stringify(catalogKeysForPrompt())}`;
      const out = await aiJSON({ tag: 'case.classifyOrders', meta, system, payload: { orders }, model: CASE_FAST_MODEL, max_output_tokens: 1200, reasoning_effort: 'low' });
      const map = {};
      for (const o of ensureArray(out.orders)) if (o?.text) map[o.text] = o;
      return map;
    },

    async resolveResults(session, { tests, studies }) {
      if (MOCK()) return { labs: Object.fromEntries(tests.map(t => [t.key, { value: 1, perHour: 0 }])), studies: Object.fromEntries(studies.map(s => [s.key, { report: `${s.title}: no acute abnormality.` }])) };
      const system = `${NO_TEACHING}
Produce results for tests the learner ordered that the case did not pre-specify. Results must be consistent with the hidden diagnosis, the current physiological state, and time course. Reports read like real reports (findings + impression as a radiologist would write), with no teaching or management advice.
Return {"labs":{"<key>":{"value":0,"perHour":0}},"studies":{"<key>":{"report":""}}}.`;
      const payload = { hidden: hiddenSummary(session), state: stateSnapshot(session), tests, studies };
      return aiJSON({ tag: 'case.resolveResults', meta, system, payload, model: CASE_FAST_MODEL, max_output_tokens: 1500, reasoning_effort: 'low' });
    },

    async progress(session, { fromTime, toTime, therapies, state }) {
      if (MOCK()) return mockProgress(session, therapies);
      const system = `You update the hidden physiology of a simulated patient. Nothing you write about rates is shown to the learner.
Given the hidden diagnosis and expected course, the current state, and the therapies actually given (with times), set the per-hour trends that apply from ${fromTime} toward ${toTime}.
- Appropriate therapy should improve the relevant values at a realistic pace; omission or delay should let the untreated course continue; harmful actions (see dangerousActions) should cause realistic harm.
- Use setVitals/setLabs only for abrupt changes (e.g. after a bolus, arrhythmia, desaturation).
- events: 0-3 objective nursing observations or pages that would occur in this window (offsetMin from now). Objective language only, no interpretation, no suggestions.
- Do not change the diagnosis.
Return {"vitalsRates":{"hr":0,"sbp":0,"dbp":0,"rr":0,"spo2":0,"temp":0,"pain":0},"labRates":{"<key>":0},"setVitals":{},"setLabs":{},"oxygen":"optional new oxygen description","events":[{"offsetMin":30,"text":"","urgency":"routine|urgent|critical"}],"summary":"hidden one-line state summary"}`;
      const payload = {
        hidden: { ...hiddenSummary(session), expectedKeyActions: session.lock?.expectedKeyActions, dangerousActions: session.lock?.dangerousActions },
        previousSummary: session.sim?.progressionSummary || '',
        state,
        therapies,
        ordersSoFar: ensureArray(session.orders).slice(-30).map(o => `${o.placedAt} ${o.text} [${o.status}]`)
      };
      return aiJSON({ tag: 'case.progress', meta, system, payload, model: CASE_FAST_MODEL, max_output_tokens: 1200, reasoning_effort: 'low' });
    }
  };
}

// --------------------------------- debrief ----------------------------------
export async function concludeCase(session, { finalNoteText, finalOrdersText }, meta) {
  if (MOCK()) {
    return {
      diagnosis: session.lock?.primaryDiagnosis, secondaryDiagnoses: session.lock?.secondaryDiagnoses || [],
      caseSummary: 'Mock debrief.', diagnosticFeedback: ['Mock feedback.'], managementFeedback: [], documentationFeedback: [], safetyIssues: [], whatGoodLookedLike: ['Mock.'],
      overallRating: 'Hard', exclusionEntry: session.lock?.exclusionEntry || session.lock?.primaryDiagnosis
    };
  }
  const system = `You are a strict attending physician debriefing a Canadian medical trainee after an EMR case simulation. You may now reveal the diagnosis.
Be detailed and critical. Assess diagnostic reasoning, investigations (including unnecessary or missed tests), management (timing, dosing, safety), documentation, and missed opportunities. A correct final diagnosis does not excuse unsafe or delayed management. Reference what the learner actually did, with sim times.
Return {"diagnosis":"","secondaryDiagnoses":[],"caseSummary":"","diagnosticFeedback":[],"managementFeedback":[],"documentationFeedback":[],"safetyIssues":[],"whatGoodLookedLike":[],"overallRating":"Easy|Medium|Hard|Expert|Brutal","exclusionEntry":""}`;
  const learnerNotes = ensureArray(session.patient?.notes).filter(n => /learner|student|clerk|user/i.test(`${n.providerName} ${n.author}`)).map(n => ({ at: n.datetime, title: n.title, text: n.text }));
  const payload = {
    lock: session.lock,
    course: session.world?.course,
    simulatedTime: { start: session.simStartTime, end: session.sim?.now },
    questionsAsked: ensureArray(session.transcript).map(t => `${t.at} Q: ${t.q}`),
    orders: ensureArray(session.orders).map(o => `${o.placedAt} ${o.text} [${o.status}]`),
    medicationsGiven: ensureArray(session.patient?.medications).map(m => `${m.name} ${m.dose} ${m.route} ${m.frequency} ${m.status} ${m.start}${m.stop ? `-${m.stop}` : ''}`),
    events: ensureArray(session.activity).filter(a => a.type === 'advance').map(a => `${a.at} ${a.text}`),
    finalState: stateSnapshot(session),
    learnerNotes,
    finalNoteText: finalNoteText || '',
    finalOrdersText: finalOrdersText || ''
  };
  return aiJSON({ tag: 'case.conclude', meta, system, payload, model: CASE_MODEL, max_output_tokens: 6000, reasoning_effort: 'medium', validate: (o) => (o.diagnosis ? '' : 'missing diagnosis') });
}

// ---------------------------------- mocks -----------------------------------
// Used with MOCK_AI=1 for local development and automated tests.
function mockGeneration() {
  const today = '2026-05-17';
  return {
    caseTitle: 'Abdominal pain and vomiting',
    lock: {
      primaryDiagnosis: 'Acute intermittent porphyria', secondaryDiagnoses: ['Hyponatremia (SIADH)'],
      caseFingerprint: 'young woman abdominal pain neuropathy hyponatremia porphyria',
      expectedKeyActions: ['urine porphobilinogen', 'stop porphyrinogenic drugs', 'IV dextrose', 'hemin'],
      dangerousActions: ['porphyrinogenic medications', 'rapid sodium correction'],
      exclusionEntry: 'Acute intermittent porphyria: abdominal pain, hyponatremia, proximal weakness'
    },
    timeline: { presentationTime: `${today} 18:20`, labsDrawnAt: `${today} 18:35` },
    patient: {
      displayName: 'Dhaliwal, Harleen', age: 29, sex: 'F', location: 'Emergency Department', allergies: ['NKDA'], codeStatus: 'Full Code',
      presentingComplaint: 'Abdominal pain and vomiting', banner: 'ED consult to Internal Medicine: persistent abdominal pain.',
      investigations: [{ datetime: `${today} 19:10`, group: 'Imaging', title: 'CT abdomen/pelvis with contrast', status: 'Final', report: 'No bowel obstruction. Appendix normal. No free air. Small physiologic pelvic free fluid.' }],
      nursingNotes: [{ datetime: `${today} 18:25`, author: 'RN', text: 'Diffuse abdominal pain, nausea. Vomited x2. Ambulating independently.' }],
      medications: [{ name: 'Ondansetron', dose: '4 mg', route: 'IV', frequency: 'once', status: 'completed', start: `${today} 18:30`, stop: `${today} 18:30`, comments: 'Given' }],
      notes: [{ datetime: `${today} 19:20`, service: 'Emergency Medicine', providerName: 'Dr. Tran (ED)', noteType: 'Consult request', title: 'Internal Medicine consult request', text: '29F, 2 d diffuse abdominal pain, vomiting. CT A/P negative. Na 126. Please assess.' }]
    },
    physiology: {
      vitals: { hr: 112, sbp: 148, dbp: 92, rr: 18, spo2: 99, temp: 36.9, pain: 8, o2: 'room air' },
      vitalsTrendPerHourUntreated: { hr: 0.5, sbp: 0.3 },
      labs: { na: 126, k: 3.8, cl: 92, hco3: 24, cr: 64, urea: 3.1, glucose: 5.6, wbc: 9.8, hgb: 129, plt: 286 },
      labTrendPerHourUntreated: { na: -0.15 },
      customTests: [{ key: 'u_pbg', name: 'Urine porphobilinogen', unit: 'µmol/L', lo: 0, hi: 9, dp: 0, category: 'Urine', value: 180 }],
      initialPanels: ['cbc', 'lytes', 'renal', 'glucose']
    },
    world: {
      persona: 'Anxious, answers briefly, reliable historian.',
      history: [
        { topic: 'onset', answer: 'Started two days ago, cramping all over my belly.' },
        { topic: 'medications', answer: 'Started the birth control pill three weeks ago.' },
        { topic: 'weakness', answer: 'My arms have felt weak since yesterday.' },
        { topic: 'urine', answer: 'My pee looked dark this morning.' },
        { topic: 'alcohol', answer: 'A couple of drinks on the weekend.' }
      ],
      exam: {
        general: 'Uncomfortable, restless, diaphoretic.', heent: 'Mucous membranes dry. No scleral icterus.',
        cardiovascular: 'Tachycardic, regular. Normal S1 S2. No murmurs. JVP not elevated.', respiratory: 'Clear bilaterally. Normal work of breathing.',
        abdominal: 'Soft, diffusely tender without guarding or rebound. Bowel sounds reduced. Murphy sign negative.',
        neurological: 'Alert, oriented x3. Power 4/5 proximal upper limbs bilaterally. Reflexes reduced at biceps. Sensation intact.',
        musculoskeletal: 'Normal.', skin: 'No rash. No photosensitive lesions.', extremities: 'No edema. Capillary refill 2 s.', genitourinary: 'Not examined.'
      },
      studies: { ecg: { report: 'Sinus tachycardia 112 bpm. Normal axis. Normal intervals. No ST changes.' }, cxr: { report: 'Lungs clear. No effusion. Normal cardiomediastinal silhouette.' }, ua: { report: 'Colour: dark amber. SG 1.020. Blood negative. Protein negative. Leukocytes negative. Nitrites negative.' } },
      course: { untreated: 'Pain persists, sodium falls, progressive proximal weakness.', withAppropriateCare: 'Pain and weakness improve over 48-72 h with hemin and dextrose.', harmfulActions: 'Porphyrinogenic drugs worsen attack.' }
    }
  };
}

function mockAnswer(session, request) {
  const r = String(request || '').toLowerCase();
  const hit = ensureArray(session.world?.history).find(h => r.includes(h.topic.split(' ')[0]));
  return { response: hit ? hit.answer : 'Patient: "I\'m not sure."', newFacts: [] };
}

function mockProgress(session, therapies) {
  const treated = ensureArray(therapies?.medications).some(m => /hemin|dextrose/i.test(m));
  return {
    vitalsRates: { hr: treated ? -2 : 0.5 }, labRates: { na: treated ? 0.2 : -0.15 },
    events: treated ? [] : [{ offsetMin: 60, text: 'Patient reports ongoing 8/10 abdominal pain.', urgency: 'routine' }],
    summary: treated ? 'Improving' : 'Untreated course'
  };
}

// Exposed for automated tests only.
export const __testMocks = { mockGeneration };
