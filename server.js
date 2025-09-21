// server.js
// Combined backend: One-Line Pimp Simulator + Med Learner
// - Preserves all Pimp Simulator routes
// - Adds hardcoded TOC + high-yield picker that excludes completed topics
// - Adds Learn-mode endpoints: guidelines, trials, objectives
// - Uses a “strict” model for URL picking to reduce 404s

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Redis } from '@upstash/redis';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { v4 as uuid, v4 as uuidv4 } from 'uuid';

// ---------------------------------------------------------------------------
// App & infra
// ---------------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------
// Cheaper default for most tasks
const BASE_MODEL   = process.env.OPENAI_BASE_MODEL   || "gpt-4.1";
// “Strict” model used only for URL selection / validation to reduce 404s
// (set OPENAI_STRICT_MODEL="gpt-5.1" if your account has it;
// otherwise it falls back to BASE_MODEL)
const STRICT_MODEL = process.env.OPENAI_STRICT_MODEL || BASE_MODEL;

// Some models (gpt-5.x, some o-series) don’t accept temperature on Responses API.
function supportsTemperature(model) {
  return !/^gpt-5(\.|-)/i.test(model);
}
async function responsesCall({ model, input, temperature }) {
  const req = { model, input };
  if (temperature !== undefined && supportsTemperature(model)) req.temperature = temperature;
  return openai.responses.create(req);
}

// ---------------------------------------------------------------------------
// Pimp Simulator: helpers you already used (kept intact)
// ---------------------------------------------------------------------------
const DIFF = ["MSI1","MSI2","MSI3","MSI4","R1","R2","R3","R4","R5","Attending"];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const bumpDifficulty = (label, delta) => {
  const i = DIFF.indexOf(label);
  const next = i < 0 ? 2 : clamp(i + delta, 0, DIFF.length - 1);
  return DIFF[next];
};

const kUser       = (u) => `user:${u}`;
const kSess       = (id) => `session:${id}`;
const kSessItems  = (id) => `sessionitem:${id}`;
const kExclusions = (u) => `exclusions:${u}`;
const kHistory    = (u) => `history:${u}`;

async function pushHistory(username, item, keep = 1000) {
  await redis.lpush(kHistory(username), JSON.stringify(item));
  await redis.ltrim(kHistory(username), 0, keep - 1);
}

function tierIndex(label){ const i = DIFF.indexOf(label); return (i>=0?i:0)+1; }
function pointsFor(label){ const t=tierIndex(label); return {correct:10*t, wrong:5*t}; }

async function getUserScore(username){
  const h = await redis.hgetall(kUser(username));
  const score    = Number(h?.score || 0);
  const answered = Number(h?.answered || 0);
  const correct  = Number(h?.correct || 0);
  return { score, answered, correct, accuracy: answered?correct/answered:0 };
}

// Atomically bump score/stats + leaderboard
async function applyScoreDelta(username, delta, answeredDelta, correctDelta){
  const pipeline = redis.multi();
  // user stats
  pipeline.hincrby(kUser(username), "score",    delta);
  pipeline.hincrby(kUser(username), "answered", answeredDelta);
  pipeline.hincrby(kUser(username), "correct",  correctDelta);
  // leaderboard
  pipeline.zincrby("leaderboard:global", delta, username);
  await pipeline.exec();
  const u = await getUserScore(username);
  if (u.score < 0) {
    await redis.hset(kUser(username), { score: 0 });
    await redis.zadd("leaderboard:global", { score: 0, member: username });
  }
  return getUserScore(username);
}

async function exclusionsCount(username){
  const s = await redis.scard(kExclusions(username));
  return Number(s || 0);
}
async function pushExclusions(username, list=[]) {
  if (!list?.length) return;
  await redis.sadd(kExclusions(username), ...list);
}

// ---- Pimp Simulator: AI helpers ----
function parseResponsesJSON(resp){
  try {
    const c = resp?.output_text || resp?.output?.[0]?.content?.[0]?.text?.value || "";
    if (!c) return null;
    return JSON.parse(c);
  } catch { return null; }
}

async function aiGenerateQuestion({ topic, difficulty, avoidList }) {
  if (process.env.MOCK_AI === '1') {
    const pool = (Array.isArray(avoidList) ? avoidList : []);
    const bank = [
      "First-line treatment for status asthmaticus?",
      "Antidote for organophosphate poisoning?",
      "Next step for suspected PE in a hemodynamically stable patient?",
      "Diagnostic test of choice for C. difficile infection?",
      "Target INR for mechanical mitral valve?"
    ];
    const q = bank.find(b => !pool.includes(b)) || "Dose of epinephrine IM for anaphylaxis in adults?";
    return q;
  }

  const avoid = Array.isArray(avoidList) ? avoidList.slice(-200) : [];
  const system = `You are the question engine for "One Line Pimp Simulator".
Return ONLY JSON like: {"question":"..."}.
Question must be answerable in ONE word or ONE short sentence.
The questions should be difficult and clinically relevant. Scale difficulty by MSI1→Attending.
Avoid duplicates of provided examples.`;

  const userPayload = { topic: topic || "random", difficulty: difficulty || "MSI3", avoid_examples: avoid };

  const resp = await openai.responses.create({
    model: BASE_MODEL,
    temperature: 0.7,
    input: [
      { role: "system", content: system },
      { role: "user",   content: JSON.stringify(userPayload) }
    ]
  });

  const parsed = parseResponsesJSON(resp) || {};
  if (!parsed.question || typeof parsed.question !== "string") throw new Error("Bad question JSON");
  return parsed.question.trim();
}

async function aiGradeAnswer({ question, userAnswer, difficulty }) {
  if (process.env.MOCK_AI === "1") {
    const golds = {
      "First-line treatment for status asthmaticus?": "nebulized saba and ipratropium",
      "Antidote for organophosphate poisoning?": "atropine and pralidoxime",
      "Next step for suspected PE in a hemodynamically stable patient?": "ctpa",
      "Diagnostic test of choice for C. difficile infection?": "stool pcr",
      "Target INR for mechanical mitral valve?": "3.0"
    };
    const gold = (golds[question] || "").toLowerCase().trim();
    const ans  = String(userAnswer || "").toLowerCase().trim();
    const is_correct = gold && (ans === gold || gold.includes(ans) || ans.includes(gold));
    return { is_correct, explanation: is_correct ? "" : (gold ? `Correct: ${gold}.` : "Reviewed."), difficulty_delta: is_correct ? 1 : 0 };
  }

  const system = `You grade very concisely. Return ONLY JSON: {"is_correct":bool,"explanation":"...","difficulty_delta":-1|0|1}`;
  const payload = { question, user_answer: userAnswer, difficulty };

  const resp = await openai.responses.create({
    model: BASE_MODEL,
    temperature: 0.3,
    input: [
      { role: "system", content: system },
      { role: "user",   content: JSON.stringify(payload) }
    ]
  });

  const parsed = parseResponsesJSON(resp) || { is_correct:false, explanation:"", difficulty_delta:0 };
  if (typeof parsed.is_correct !== "boolean") parsed.is_correct = false;
  if (![ -1, 0, 1 ].includes(parsed.difficulty_delta)) parsed.difficulty_delta = 0;
  return parsed;
}

async function aiSummarizeSession({ transcript, startDifficulty }) {
  const system = `Summarize a short pimp-session transcript. Return ONLY JSON: {"feedback":"...","rating":0..10}`;
  const inputObj = { startDifficulty, transcript };
  const resp = await openai.responses.create({
    model: BASE_MODEL,
    temperature: 0.2,
    input: [
      { role:"system", content: system },
      { role:"user",   content: JSON.stringify(inputObj) }
    ]
  });
  return parseResponsesJSON(resp) || { feedback:"", rating:7 };
}

// ---------------------------------------------------------------------------
// Pimp Simulator API (preserved)
// ---------------------------------------------------------------------------

// new session
app.post('/api/sessions', async (req, res) => {
  try {
    const { username, topic, start_diff } = req.body || {};
    if (!username) return res.status(400).json({ error: "username required" });
    const sessionId = uuid();
    await redis.hset(kSess(sessionId), {
      id: sessionId, username, topic: topic || "random",
      start_diff: start_diff || "MSI3", created_at: Date.now()
    });
    res.json({ session_id: sessionId });
  } catch (e) { res.status(500).json({ error: "failed to create session", detail: String(e) }); }
});

// next question
app.post('/api/next', async (req, res) => {
  try {
    const { session_id } = req.body || {};
    const meta = await redis.hgetall(kSess(session_id));
    if (!meta?.username) return res.status(404).json({ error: "session not found" });

    const prev = await redis.lrange(kSessItems(session_id), -20, -1);
    const avoid = [];
    for (const r of prev) {
      try { const p = typeof r === "string" ? JSON.parse(r) : r; if (p?.question) avoid.push(p.question); } catch {}
    }

    const q = await aiGenerateQuestion({
      topic: meta.topic,
      difficulty: meta.last_diff || meta.start_diff || "MSI3",
      avoidList: avoid
    });

    const item = {
      id: uuid(), asked_at: Date.now(), question: q,
      starting_difficulty: meta.last_diff || meta.start_diff || "MSI3"
    };
    await redis.rpush(kSessItems(session_id), JSON.stringify(item));
    res.json({ question: q, item_id: item.id, difficulty: item.starting_difficulty });
  } catch (e) { res.status(500).json({ error: "failed to get next question", detail: String(e) }); }
});

// answer
app.post('/api/answer', async (req, res) => {
  try {
    const { session_id, item_id, answer } = req.body || {};
    const meta = await redis.hgetall(kSess(session_id));
    if (!meta?.username) return res.status(404).json({ error: "session not found" });

    const items = await redis.lrange(kSessItems(session_id), 0, -1);
    let last = null; let idx = -1;
    for (let i=items.length-1; i>=0; i--){
      let o = items[i]; try { o = typeof o==="string" ? JSON.parse(o) : o; } catch {}
      if (o?.id === item_id){ last=o; idx=i; break; }
    }
    if (!last) return res.status(404).json({ error:"item not found" });

    const graded = await aiGradeAnswer({
      question: last.question, userAnswer: answer,
      difficulty: last.starting_difficulty
    });

    last.is_correct = !!graded.is_correct;
    last.explanation = graded.explanation || "";
    last.answered_at = Date.now();
    last.final_difficulty = bumpDifficulty(last.starting_difficulty, graded.difficulty_delta);
    last.points_delta = (last.is_correct ? pointsFor(last.starting_difficulty).correct
                                         : -pointsFor(last.starting_difficulty).wrong);

    await redis.lset(kSessItems(session_id), idx, JSON.stringify(last));
    await redis.hset(kSess(session_id), { last_diff: last.final_difficulty });

    const user = meta.username;
    await pushHistory(user, { q:last.question, a:answer, ok:last.is_correct, t:last.answered_at });
    const stats = await applyScoreDelta(user, last.points_delta, 1, last.is_correct ? 1 : 0);

    res.json({ ...graded, next_difficulty: last.final_difficulty, stats });
  } catch (e) { res.status(500).json({ error: "failed to grade", detail: String(e) }); }
});

// conclude session
app.post('/api/conclude', async (req, res) => {
  try {
    const { session_id } = req.body || {};
    const meta = await redis.hgetall(kSess(session_id));
    if (!meta?.username) return res.status(404).json({ error:"session not found" });

    const rows = await redis.lrange(kSessItems(session_id), 0, -1);
    const transcript = rows.map(r => { try { return JSON.parse(r); } catch { return { raw:r }; } });

    // exclusions
    await pushExclusions(meta.username, transcript.map(t => t.question));

    // points recap
    const session_points = transcript.reduce((sum, t) => {
      if (typeof t.points_delta === "number") return sum + t.points_delta;
      const { correct, wrong } = pointsFor(t.starting_difficulty || "MSI3");
      return sum + (t.is_correct ? correct : -wrong);
    }, 0);

    const { feedback, rating } = await aiSummarizeSession({ transcript, startDifficulty: meta.start_diff });
    res.json({ session_points, feedback, rating });
  } catch (e) { res.status(500).json({ error:"failed to conclude", detail: String(e) }); }
});

// user history (latest N)
app.get('/api/history', async (req, res) => {
  try {
    const username = String(req.query.username || "");
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
    const rows = await redis.lrange(kHistory(username), 0, limit - 1);
    const items = (rows || []).map(s => { try { return JSON.parse(s); } catch { return { raw:s }; }});
    res.json({ items });
  } catch (e) { res.status(500).json({ error: "history failed", detail: String(e) }); }
});

// ---------------------------------------------------------------------------
// Med Learner: SQLite init + PDF helpers
// ---------------------------------------------------------------------------
const medDb = new Database('medlearner.db');
medDb.pragma('journal_mode = WAL');
medDb.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS completed_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    topic   TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, topic)
  );

  CREATE TABLE IF NOT EXISTS pdf_docs (
    id TEXT PRIMARY KEY,
    label TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pdf_chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    ord INTEGER NOT NULL,
    text TEXT NOT NULL,
    FOREIGN KEY(doc_id) REFERENCES pdf_docs(id) ON DELETE CASCADE
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS pdf_chunks_fts
  USING fts5(text, content='pdf_chunks', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS pdf_chunks_ai AFTER INSERT ON pdf_chunks BEGIN
    INSERT INTO pdf_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
  END;

  CREATE TRIGGER IF NOT EXISTS pdf_chunks_ad AFTER DELETE ON pdf_chunks BEGIN
    INSERT INTO pdf_chunks_fts(pdf_chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  END;

  CREATE TRIGGER IF NOT EXISTS pdf_chunks_au AFTER UPDATE ON pdf_chunks BEGIN
    INSERT INTO pdf_chunks_fts(pdf_chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
    INSERT INTO pdf_chunks_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
`);

const upload = multer({ storage: multer.memoryStorage() });

const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 150;
function chunkText(raw){
  const text = (raw||'').replace(/\s+\n/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  const chunks=[]; let i=0;
  while(i<text.length){
    let end=Math.min(i+CHUNK_SIZE,text.length);
    let slice=text.slice(i,end);
    const lastPara=slice.lastIndexOf('\n\n');
    const lastSent=slice.lastIndexOf('. ');
    const lastStop=Math.max(lastPara,lastSent);
    if(lastStop>400 && end<text.length) slice=slice.slice(0,lastStop+1);
    chunks.push(slice.trim());
    i+=Math.max(slice.length-CHUNK_OVERLAP,1);
  }
  return chunks.filter(Boolean);
}

async function indexPdfBuffer(buffer, label){
  const data = await pdfParse(buffer);
  const docId = uuidv4();
  medDb.prepare(`INSERT INTO pdf_docs (id,label) VALUES (?,?)`).run(docId, label||null);
  const chunks = chunkText(data.text || '');
  const ins = medDb.prepare(`INSERT INTO pdf_chunks (id,doc_id,ord,text) VALUES (?,?,?,?)`);
  const tx = medDb.transaction(()=>{ chunks.forEach((c,i)=>ins.run(uuidv4(), docId, i, c)); }); tx();
  return { docId, nChunks: chunks.length };
}

// PDF endpoints (kept)
app.post('/med/pdfs', upload.single('file'), async (req,res)=>{
  try {
    if (!req.file) return res.status(400).json({ error:'file required' });
    const label = req.body?.label || req.file.originalname;
    const { docId, nChunks } = await indexPdfBuffer(req.file.buffer, label);
    res.json({ ok:true, doc_id:docId, chunks:nChunks, label });
  } catch(e){ res.status(500).json({ error:String(e) }); }
});
app.post('/med/pdfs/by-url', async (req,res)=>{
  try {
    const { url, label } = req.body||{};
    if (!url) return res.status(400).json({ error:'url required' });
    const r = await fetch(url);
    if (!r.ok) return res.status(400).json({ error:`fetch failed: ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    const { docId, nChunks } = await indexPdfBuffer(buf, label||url);
    res.json({ ok:true, doc_id:docId, chunks:nChunks, label:label||url });
  } catch(e){ res.status(500).json({ error:String(e) }); }
});
app.get('/med/pdfs/search', (req,res)=>{
  const q = String(req.query.q||"").trim();
  const k = Number(req.query.k||8);
  if(!q) return res.status(400).json({ error:'q required' });
  try{
    const rows = medDb.prepare(`
      SELECT pc.rowid as rowid, pc.id as chunk_id, pc.doc_id as doc_id,
             pd.label as label, pc.text as text, bm25(pdf_chunks_fts) as score
      FROM pdf_chunks_fts
      JOIN pdf_chunks pc ON pc.rowid = pdf_chunks_fts.rowid
      JOIN pdf_docs   pd ON pd.id = pc.doc_id
      WHERE pdf_chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(q,k);
    res.json({ hits: rows.map(r=>({doc_id:r.doc_id,label:r.label,chunk_id:r.chunk_id,text:r.text,score:r.score})) });
  }catch(e){ res.status(500).json({ error:String(e) }); }
});

// ---------------------------------------------------------------------------
// Med Learner: Topics (hardcoded TOC + helpers)
// ---------------------------------------------------------------------------

// HARDCODED TOC, curated for Internal Medicine (discipline → sub → topics)
const HARDCODED_TOC = {
  Cardiology: {
    Ischemic: [
      "Approach To Acute Coronary Syndrome",
      "NSTEMI vs STEMI Reperfusion Algorithms",
      "Post-MI Secondary Prevention"
    ],
    Arrhythmia: [
      "Atrial Fibrillation (Acute & Chronic)",
      "SVT: Diagnosis & Management",
      "Bradyarrhythmias and Heart Block"
    ],
    HeartFailure: [
      "Acute Decompensated Heart Failure",
      "Chronic HFrEF GDMT",
      "Cardiogenic Shock"
    ],
    Valvular: [
      "Aortic Stenosis",
      "Mitral Regurgitation",
      "Endocarditis (Native vs Prosthetic)"
    ]
  },
  Pulmonology: {
    Airway: [
      "Status Asthmaticus",
      "Acute COPD Exacerbation",
      "OSA: Workup & Treatment"
    ],
    Parenchymal: [
      "Community-Acquired Pneumonia",
      "Hospital-Acquired Pneumonia",
      "Non-massive Hemoptysis"
    ],
    Vascular: [
      "Pulmonary Embolism (Stable vs Unstable)",
      "Pulmonary Hypertension (Groups 1-5)"
    ]
  },
  Nephrology: {
    Electrolytes: [
      "Hyponatremia (Hypo/Eu/Hypervolemic)",
      "Hyperkalemia (Acute Stabilization & Shift)",
      "Metabolic Acidosis (AGMA vs NAGMA)"
    ],
    AKI_CKD: [
      "Acute Kidney Injury: Prerenal vs ATN vs Postrenal",
      "Chronic Kidney Disease Staging & Referral"
    ]
  },
  Endocrinology: {
    Diabetes: [
      "DKA (Adult)",
      "HHS",
      "Outpatient Insulin Intensification"
    ],
    Thyroid: [
      "Thyroid Storm",
      "Myxedema Coma",
      "Approach to Hypothyroidism"
    ]
  },
  InfectiousDiseases: {
    Sepsis: [
      "Sepsis & Septic Shock (Surviving Sepsis)",
      "Neutropenic Fever"
    ],
    CNS: [
      "Bacterial Meningitis (Adult)",
      "Encephalitis: HSV vs others"
    ],
    SkinSoftTissue: [
      "Cellulitis vs Necrotizing Fasciitis",
      "Diabetic Foot Infection"
    ]
  },
  Neurology: {
    Cerebrovascular: [
      "Ischemic Stroke (Thrombolysis & EVT)",
      "TIA: Risk Stratification"
    ],
    Seizure: [
      "New-Onset Seizure in Adults",
      "Status Epilepticus"
    ]
  },
  GI: {
    Bleeding: [
      "Upper GI Bleed (Variceal vs Non-variceal)",
      "Lower GI Bleed"
    ],
    Liver: [
      "Acute Liver Failure",
      "Decompensated Cirrhosis"
    ]
  },
  Rheumatology: {
    Emergencies: [
      "Septic Arthritis",
      "Gout Flare (Inpatient)"
    ]
  },
  Hematology: {
    Thromboembolism: [
      "DVT (Anticoagulation & Outpatient Criteria)"
    ],
    Malignancy: [
      "Tumor Lysis Syndrome"
    ]
  }
};

// Flatten for quick picking
const HARD_TOC_ITEMS = [];
for (const [disc, subs] of Object.entries(HARDCODED_TOC)) {
  for (const [sub, topics] of Object.entries(subs)) {
    for (const t of topics) HARD_TOC_ITEMS.push({ discipline: disc, sub, topic: t });
  }
}

// small helpers
function listAllTopics() { return HARD_TOC_ITEMS.map(o => o.topic); }
function listByDS(discipline, sub) {
  return HARD_TOC_ITEMS.filter(o => (!discipline || o.discipline===discipline) && (!sub || o.sub===sub));
}

// Completed topics endpoints
app.get('/med/topics', (req,res)=>{
  const user_id = String(req.query.user_id||"").trim();
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const rows = medDb.prepare(`SELECT topic FROM completed_topics WHERE user_id=? ORDER BY created_at DESC`).all(user_id);
  res.json({ topics: rows.map(r=>r.topic) });
});
app.post('/med/topics', (req,res)=>{
  const { user_id, topic } = req.body||{};
  if (!user_id || !topic) return res.status(400).json({ error:'user_id and topic required' });
  medDb.prepare(`INSERT OR IGNORE INTO completed_topics (user_id,topic) VALUES (?,?)`).run(user_id, topic);
  res.json({ ok:true });
});

// TOC read
app.get('/med/toc', (req,res)=>{
  const counts = {
    disciplines: Object.keys(HARDCODED_TOC).length,
    subs: HARD_TOC_ITEMS.reduce((s,o)=>s.add(`${o.discipline}::${o.sub}`), new Set()).size,
    topics: HARD_TOC_ITEMS.length
  };
  res.json({ ok:true, label:"HARDCODED_TOC", counts, items: HARD_TOC_ITEMS });
});

// Random pick (respects user’s completed list)
app.get('/med/pick/random', (req,res)=>{
  const user_id   = String(req.query.user_id||"").trim();
  const disc      = req.query.discipline ? String(req.query.discipline) : null;
  const sub       = req.query.sub ? String(req.query.sub) : null;

  const done = user_id
    ? new Set(medDb.prepare(`SELECT topic FROM completed_topics WHERE user_id=?`).all(user_id).map(r=>r.topic))
    : new Set();

  const pool = listByDS(disc, sub).map(o=>o.topic).filter(t=>!done.has(t));
  if (pool.length === 0) return res.status(409).json({ error:"no topics left in selection" });
  const pick = pool[Math.floor(Math.random()*pool.length)];
  res.json({ topic: pick });
});

// High-yield IM picker (AI ranks; excludes completed)
app.get('/med/pick/high-yield', async (req,res)=>{
  try{
    const user_id = String(req.query.user_id||"").trim();
    const done = user_id
      ? new Set(medDb.prepare(`SELECT topic FROM completed_topics WHERE user_id=?`).all(user_id).map(r=>r.topic))
      : new Set();

    // Only Internal-Medicine-relevant buckets (broad)
    const IM_DISC = new Set(["Cardiology","Pulmonology","Nephrology","Endocrinology","InfectiousDiseases","Neurology","GI","Rheumatology","Hematology"]);
    const imPool = HARD_TOC_ITEMS.filter(o => IM_DISC.has(o.discipline) && !done.has(o.topic));
    if (imPool.length === 0) return res.status(409).json({ error:"no IM topics left" });

    // Ask AI to score/rank briefly; use strict model for better citations/URLs later
    const resp = await responsesCall({
      model: STRICT_MODEL,
      input: [
        { role:"system", content:
          `You rank Internal Medicine topics by yield for a Canadian IM trainee.
Return ONLY JSON as {"top":"<topic>"} choosing from the provided list; prefer acute, common, guideline-heavy issues.` },
        { role:"user", content: JSON.stringify({ candidates: imPool.map(o=>o.topic).slice(0,60) }) }
      ],
      temperature: 0.2
    });
    const parsed = parseResponsesJSON(resp) || {};
    const choice = (parsed.top && imPool.find(o=>o.topic===parsed.top)) ? parsed.top
                 : imPool[ Math.floor(Math.random()*imPool.length) ].topic;

    res.json({ topic: choice });
  }catch(e){ res.status(500).json({ error:String(e) }); }
});

// ---------------------------------------------------------------------------
// Learn-mode: Guidelines, Trials, Learning Objectives
// ---------------------------------------------------------------------------

function cleanLinks(text){
  // naive URL detector – keeps https links only and de-dupes
  const urls = new Set((text.match(/https?:\/\/[^\s)"]+/g) || []).map(u=>{
    try{
      const url = new URL(u);
      if (url.protocol!=="https:") return null;
      return url.toString().replace(/[\.,]$/,'');
    }catch{return null;}
  }).filter(Boolean));
  return Array.from(urls);
}

// Guidelines (Canadian → USA → International). Strict model validates links.
app.get('/med/guidelines', async (req,res)=>{
  try{
    const topic = String(req.query.topic||"").trim();
    if(!topic) return res.status(400).json({ error:"topic required" });

    const sys = `Return ONLY JSON:
{"canadian":[{"title":"...","url":"https://..."},...],
 "usa":[...],
 "intl":[...]}
Rules:
- Include 3–6 high-quality, guideline/position-statement links per region (if they exist).
- Prefer: Canadian specialty societies, then US (AHA/ACC/ACP/IDSA/ATS etc.), then international.
- URLs must be direct, public, https links that resolve (no paywalled PDFs if public version exists).
- No 404s. If uncertain, omit.`;
    const r = await responsesCall({
      model: STRICT_MODEL,
      input: [
        { role:"system", content: sys },
        { role:"user", content: `Topic: ${topic}` }
      ],
      temperature: 0.1
    });
    const j = parseResponsesJSON(r) || {};
    // final sanity pass on URLs
    for (const k of ["canadian","usa","intl"]) {
      j[k] = (Array.isArray(j[k])?j[k]:[]).filter(x=>x?.title && /^https:\/\//.test(x?.url));
    }
    res.json(j);
  }catch(e){ res.status(500).json({ error:String(e) }); }
});

// Landmark trials (positive + negative; balanced)
app.get('/med/trials', async (req,res)=>{
  try{
    const topic = String(req.query.topic||"").trim();
    if(!topic) return res.status(400).json({ error:"topic required" });

    const sys = `Return ONLY JSON list [{"name":"...","year":2000,"n":1234,"takeaway":"...","url":"https://..."}].
- 6–12 landmark trials tightly relevant to the topic.
- Include seminal negative trials if they shaped practice.
- Prefer PubMed or journal landing pages (NEJM, Lancet, JAMA, Circulation, etc.).
- URLs must be public https and likely to resolve; avoid paywalled PDF-only links if landing page exists.`;
    const r = await responsesCall({
      model: STRICT_MODEL,
      input: [
        { role:"system", content: sys },
        { role:"user",   content: `Topic: ${topic}` }
      ],
      temperature: 0.15
    });
    const arr = Array.isArray(parseResponsesJSON(r)) ? parseResponsesJSON(r) : [];
    const cleaned = arr
      .filter(x=>x?.name && /^https:\/\//.test(x?.url))
      .map(x=>({ ...x, url: cleanLinks(x.url)[0] || x.url }));
    res.json({ trials: cleaned });
  }catch(e){ res.status(500).json({ error:String(e) }); }
});

// Learning objectives mapped to resources/trials
app.get('/med/objectives', async (req,res)=>{
  try{
    const topic = String(req.query.topic||"").trim();
    if(!topic) return res.status(400).json({ error:"topic required" });

    const sys = `Return ONLY JSON:
[{"objective":"...","why":"...","resources":[{"title":"...","url":"https://..."}, ...]}]
- 8–20 objectives spanning dx, risk stratification, mgmt, algorithms, pitfalls.
- For each, attach 1–3 best open resources (guideline/trial/FOAM reference).
- Prefer URLs previously listed if applicable; all links must be https and likely to resolve.`;
    const r = await responsesCall({
      model: BASE_MODEL,
      input: [
        { role:"system", content: sys },
        { role:"user",   content: `Topic: ${topic}` }
      ],
      temperature: 0.25
    });
    const arr = Array.isArray(parseResponsesJSON(r)) ? parseResponsesJSON(r) : [];
    for (const o of arr) {
      o.resources = (Array.isArray(o.resources)?o.resources:[])
        .filter(x=>x?.title && /^https:\/\//.test(x?.url))
        .map(x=>({ ...x, url: cleanLinks(x.url)[0] || x.url }));
    }
    res.json({ objectives: arr });
  }catch(e){ res.status(500).json({ error:String(e) }); }
});

// ---------------------------------------------------------------------------
// Health & start
// ---------------------------------------------------------------------------
app.get('/', (_req,res)=> res.json({ ok:true, service:"one-line + med-learner" }));

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
