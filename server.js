import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Redis } from '@upstash/redis';
import OpenAI from 'openai';
import { v4 as uuid } from 'uuid';

// ==== Med Learner imports ====
import Database from 'better-sqlite3';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { v4 as uuidv4 } from 'uuid';

////////////////////////////////////////////////////////////////////////////////
// CONFIG & INIT
////////////////////////////////////////////////////////////////////////////////

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT = process.env.PORT || 3000;

// Difficulty ladder
const DIFF = ["MSI1","MSI2","MSI3","MSI4","R1","R2","R3","R4","R5","Attending"];
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const bumpDifficulty = (label, delta) => {
  const i = DIFF.indexOf(label);
  const next = i < 0 ? 2 : clamp(i + delta, 0, DIFF.length - 1);
  return DIFF[next];
};

medDb.exec(`
  CREATE TABLE IF NOT EXISTS toc_cache (
    label TEXT PRIMARY KEY,
    json  TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ---- TOC helpers (bullet extraction + AI) ----

// Build consolidated bullet entries from the indexed PDF text
function buildBulletEntriesForLabel(label) {
  const rows = medDb.prepare(`
    SELECT pc.text
    FROM pdf_chunks pc
    JOIN pdf_docs pd ON pd.id = pc.doc_id
    WHERE pd.label = ?
    ORDER BY pc.ord
  `).all(label);

  const rawLines = [];
  for (const { text } of rows) String(text || '').split(/\r?\n/).forEach(l => rawLines.push(l));

  const BULLET = /^\s*([●○•◦▪▸►▶-])\s*(.*)$/u; // common PDF bullets
  const entries = []; // { b: '●'|'○'|'-'|..., t: 'line text' }
  let pending = null;

  for (let line of rawLines) {
    // trim dot leaders + trailing page numbers; collapse ws
    line = String(line || '')
      .replace(/\.{2,}\s*\d+\s*$/, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!line) continue;

    const m = line.match(BULLET);
    if (m) {
      if (pending && pending.t.trim()) entries.push(pending);
      const b = m[1];
      const t = (m[2] || '').trim();
      pending = t ? { b, t } : null;
    } else if (pending) {
      // continuation (wrapped line)
      pending.t += ' ' + line;
    }
  }
  if (pending && pending.t.trim()) entries.push(pending);

  // Normalize bullets to just two classes we care about
  // black circle (●) ~ major; white circle (○) ~ sub; others → keep as is
  return entries.map(e => {
    let b = e.b;
    if ('•◦▪▸►▶-'.includes(b)) b = e.b === '◦' ? '○' : '●';
    return { b, t: e.t };
  });
}

// De-dupe items
function dedupeToc(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = `${it.discipline}__${it.sub}__${it.topic}`;
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

// Ask the model to map bullet entries → {discipline,sub,topic} items
async function aiInferTocFromEntries(entries, { batchSize = 220 } = {}) {
  const all = [];
  for (let i = 0; i < entries.length; i += batchSize) {
    const chunk = entries.slice(i, i + batchSize);

    const system = `You are an information extraction assistant. You will be given an ordered list of bullet entries from a PDF table of contents of a medical notebook. Each entry has a "b" (bullet) and "t" (text).
Hierarchy rules:
- A black circle ● that is immediately followed by one or more ○ entries indicates a new DISCIPLINE.
- A white circle ○ is a SUB-DISCIPLINE under the most recent DISCIPLINE.
- Subsequent ● while a SUB-DISCIPLINE is active are TOPICs belonging to (current DISCIPLINE, current SUB-DISCIPLINE).
- If two ● entries appear with no ○ between them, treat the second ● as a new DISCIPLINE (close any open SUB).
- Ignore page numbers and noise. Preserve the order.
Return ONLY JSON:
{"items":[{"discipline":"...","sub":"...","topic":"..."}]}`;

    const payload = { entries: chunk };

    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(payload) }
      ]
    });

    const parsed = (function tryParse(r) {
      try {
        const j = JSON.parse(r.output_text ?? "{}");
        return Array.isArray(j.items) ? j : null;
      } catch {
        // fallback to our existing parser helper if you kept it
        try { return parseResponsesJSON(r); } catch { return null; }
      }
    })(resp);

    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    all.push(...items);
  }
  return dedupeToc(all);
}

// Cache helpers
function getCachedToc(label) {
  const row = medDb.prepare(`SELECT json FROM toc_cache WHERE label = ?`).get(label);
  if (!row) return null;
  try { return JSON.parse(row.json); } catch { return null; }
}
function setCachedToc(label, data) {
  medDb.prepare(`
    INSERT INTO toc_cache (label, json) VALUES (?, ?)
    ON CONFLICT(label) DO UPDATE SET json=excluded.json, created_at=CURRENT_TIMESTAMP
  `).run(label, JSON.stringify(data));
}


// ---- History helpers ----
const kHistory = (u) => `history:${u}`;

// Append one history item, keep only most recent N
async function pushHistory(username, item, keep = 1000) {
  await redis.lpush(kHistory(username), JSON.stringify(item));
  await redis.ltrim(kHistory(username), 0, keep - 1);
}

// ==== Med Learner: SQLite DB init (namespaced, no collisions) ====
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

  -- Full-text search over PDF chunks
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

// ==== Med Learner: helpers (unique names) ====
const upload = multer({ storage: multer.memoryStorage() });

const CHUNK_SIZE = 1200;     // characters
const CHUNK_OVERLAP = 150;   // characters

function chunkText(raw) {
  const text = (raw || '')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK_SIZE, text.length);
    let slice = text.slice(i, end);

    const lastPara = slice.lastIndexOf('\n\n');
    const lastSent = slice.lastIndexOf('. ');
    const lastStop = Math.max(lastPara, lastSent);
    if (lastStop > 400 && end < text.length) slice = slice.slice(0, lastStop + 1);

    chunks.push(slice.trim());
    i += Math.max(slice.length - CHUNK_OVERLAP, 1);
  }
  return chunks.filter(Boolean);
}

async function indexPdfBuffer(buffer, label) {
  const data = await pdfParse(buffer);
  const docId = uuidv4();

  medDb.prepare(`INSERT INTO pdf_docs (id, label) VALUES (?, ?)`).run(docId, label || null);

  const chunks = chunkText(data.text || '');
  const insert = medDb.prepare(`INSERT INTO pdf_chunks (id, doc_id, ord, text) VALUES (?, ?, ?, ?)`);

  const tx = medDb.transaction(() => {
    chunks.forEach((c, idx) => insert.run(uuidv4(), docId, idx, c));
  });
  tx();

  return { docId, nChunks: chunks.length };
}

// ================= ADMIN NUKE (guarded) =================
app.delete('/admin/wipe', async (req, res) => {
  try {
    const secret = String(req.query.secret || "");
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }
    const dry = String(req.query.dry || "0") === "1";

    const patterns = ["user:*","session:*","sessionitem:*","exclusions:*","history:*"];
    let deleted = 0;

    async function delChunked(keys) {
      const CHUNK = 100;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK);
        if (!dry && slice.length) await redis.del(...slice);
        deleted += slice.length;
      }
    }

    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);
      if (keys?.length) await delChunked(keys);
    }

    if (!dry) await redis.del("leaderboard:global");
    res.json({ ok: true, dry, deleted_keys_estimate: deleted });
  } catch (e) {
    res.status(500).json({ error: "wipe failed", detail: String(e) });
  }
});

// --- AI username moderation ---
const OPENAI_MOD_URL = "https://api.openai.com/v1/moderations";
const ALLOW_ON_MOD_FAIL = true;

async function isUsernameAllowedAI(username) {
  try {
    const resp = await fetch(OPENAI_MOD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input: username }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || resp.statusText);

    const r = Array.isArray(data.results) ? data.results[0] : data;
    const c = r.categories || {};
    const s = r.category_scores || r.scores || {};
    const flagged = r.flagged === true;

    const blockHardFlags =
      c.hate === true || c.hate_threatening === true ||
      c.harassment_threats === true ||
      c.sexual_minors === true ||
      c.violence_graphic === true;

    const blockByScore =
      (s.hate || 0) > 0.50 ||
      (s.hate_threatening || 0) > 0.40 ||
      (s.harassment_threats || 0) > 0.50 ||
      (s.sexual_minors || 0) > 0.20 ||
      (s.violence_graphic || 0) > 0.40;

    return !(flagged || blockHardFlags || blockByScore);
  } catch (e) {
    console.error("Moderation check failed:", e);
    return ALLOW_ON_MOD_FAIL;
  }
}

// Redis keys
const kUser = (u) => `user:${u}`;
const kExcl = (u) => `excl:${u}`;
const kSess = (s) => `sess:${s}`;
const kSessItems = (s) => `sess:${s}:items`;

// DEBUGGERS
app.get("/admin/raw-items", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const key = kSessItems(String(sessionId));
    const raw = await redis.lrange(key, 0, -1);
    res.json({
      key,
      length: raw.length,
      items: raw.map((x, i) => ({ idx: i, typeof: typeof x, preview: String(x).slice(0, 120) }))
    });
  } catch (e) {
    res.status(500).json({ error: "raw-items failed", detail: String(e) });
  }
});

app.post("/admin/append-dummy", async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });
    const key = kSessItems(String(sessionId));
    const dummy = { question: "DUMMY?", final_difficulty: "MSI3", asked_at: Date.now() };
    const newLen = await redis.rpush(key, JSON.stringify(dummy));
    res.json({ ok: true, key, newLen });
  } catch (e) {
    res.status(500).json({ error: "append failed", detail: String(e) });
  }
});

// Points helpers
const kLB = () => `leaderboard:global`;
function tierIndex(label) { const i = DIFF.indexOf(label); return (i >= 0 ? i : 0) + 1; }
function pointsFor(label) { const t = tierIndex(label); return { correct: 10 * t, wrong: 5 * t }; }

async function getUserScore(username) {
  const h = await redis.hgetall(kUser(username));
  const score = Number(h?.score || 0);
  const answered = Number(h?.answered || 0);
  const correct = Number(h?.correct || 0);
  return { score, answered, correct, accuracy: answered ? correct / answered : 0 };
}

async function applyScoreDelta(username, delta, wasCorrect) {
  await redis.hincrby(kUser(username), "answered", 1);
  if (wasCorrect) await redis.hincrby(kUser(username), "correct", 1);

  let newScore = await redis.hincrby(kUser(username), "score", delta);
  await redis.zincrby(kLB(), delta, username);

  if (newScore < 0) {
    await redis.hincrby(kUser(username), "score", -newScore);
    await redis.zincrby(kLB(), -newScore, username);
    newScore = 0;
  }
  return newScore;
}

// ==== Med Learner: ensure standard PDF is indexed on startup ====
// Prefer ENV so you can swap the file without changing code.
const STANDARD_PDF_URL =
  process.env.STANDARD_PDF_URL || 'https://raw.githubusercontent.com/gurnoorsidhu602-alt/file/7c1f0d025f19f12e2494694197bd38da92f09f49/toc.pdf';
const STANDARD_PDF_LABEL =
  process.env.STANDARD_PDF_LABEL || 'STANDARD_TOC_V1';

medDb.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_label_unique
  ON pdf_docs(label) WHERE label IS NOT NULL;
`);

function pdfExistsByLabel(label) {
  const row = medDb.prepare('SELECT id FROM pdf_docs WHERE label = ?').get(label);
  return !!row;
}

async function ensureStandardPdfIndexed() {
  try {
    if (!STANDARD_PDF_URL) {
      console.warn('[MedLearner] STANDARD_PDF_URL not set; skipping auto-index.');
      return;
    }
    if (pdfExistsByLabel(STANDARD_PDF_LABEL)) {
      console.log(`[MedLearner] Standard PDF already indexed: ${STANDARD_PDF_LABEL}`);
      return;
    }
    console.log(`[MedLearner] Fetching standard PDF from ${STANDARD_PDF_URL}`);
    const resp = await fetch(STANDARD_PDF_URL);
    if (!resp.ok) {
      console.error(`[MedLearner] Failed to fetch standard PDF: ${resp.status}`);
      return;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    const { docId, nChunks } = await indexPdfBuffer(buf, STANDARD_PDF_LABEL);
    console.log(`[MedLearner] Indexed standard PDF "${STANDARD_PDF_LABEL}" as ${docId} (${nChunks} chunks).`);
  } catch (err) {
    console.error('[MedLearner] Error ensuring standard PDF:', err);
  }
}
ensureStandardPdfIndexed();

app.get('/med/toc', async (req, res) => {
  try {
    const label = req.query.label || (process.env.STANDARD_PDF_LABEL || 'STANDARD_TOC_V1');
    const wantDebug  = String(req.query.debug   || '0') === '1';
    const forceFresh = String(req.query.refresh || '0') === '1';

    // cache first (unless refresh)
    if (!forceFresh) {
      const cached = getCachedToc(label);
      if (cached && Array.isArray(cached.items) && cached.items.length) {
        return res.json(cached);
      }
    }

    const entries = buildBulletEntriesForLabel(label);
    if (wantDebug) return res.json({ ok: true, label, sample_count: Math.min(250, entries.length), sample: entries.slice(0,250) });

    // --- fast deterministic attempt (same logic as before, but tightened) ---
    const itemsFast = [];
    let disc = null, sub = null;

    const nextNonEmpty = (fromIdx) => {
      for (let j = fromIdx + 1; j < entries.length; j++) if (entries[j].t.trim()) return entries[j];
      return null;
    };

    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.b === '○') { sub = e.t; if (!disc) disc = 'General'; continue; }
      if (e.b === '●') {
        const nxt = nextNonEmpty(i);
        const newDisc = !sub || (nxt && nxt.b === '○');
        if (newDisc) { disc = e.t; sub = null; }
        else if (disc && sub) { itemsFast.push({ discipline: disc, sub, topic: e.t }); }
      }
    }

    let items = dedupeToc(itemsFast);

    // If the deterministic pass looks too small, fall back to AI
    if (items.length < 5) {
      items = await aiInferTocFromEntries(entries, { batchSize: 220 });
    }

    const out = {
      ok: true,
      label,
      items,
      counts: {
        disciplines: new Set(items.map(i => i.discipline)).size,
        subs:        new Set(items.map(i => `${i.discipline}::${i.sub}`)).size,
        topics:      items.length
      }
    };

    // cache
    if (out.items.length) setCachedToc(label, out);

    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ---------- Response parsing helpers ----------
function parseResponsesJSON(resp) {
  try {
    const t1 = typeof resp?.output_text === "string" ? resp.output_text.trim() : "";
    if (t1 && (t1.startsWith("{") || t1.startsWith("["))) return JSON.parse(t1);

    const part = resp?.output?.[0]?.content?.[0];
    if (!part) return null;

    const t2 = typeof part?.text === "string" ? part.text.trim() : "";
    if (t2 && (t2.startsWith("{") || t2.startsWith("["))) return JSON.parse(t2);

    if (part && typeof part.json === "object" && part.json !== null) return part.json;
    if (part && typeof part === "object" && !Array.isArray(part)) return part;

    return null;
  } catch { return null; }
}

function debugResp(tag, resp) {
  try {
    console.log(`[${tag}] typeof output_text=`, typeof resp?.output_text);
    if (typeof resp?.output_text === "string") {
      console.log(`[${tag}] output_text (first 200):`, resp.output_text.slice(0, 200));
    }
    const part = resp?.output?.[0]?.content?.[0];
    console.log(`[${tag}] part keys:`, part ? Object.keys(part) : null);
    if (typeof part?.text === "string") {
      console.log(`[${tag}] part.text (first 200):`, part.text.slice(0, 200));
    }
  } catch {}
}

// Peek at a session's stored items
app.get("/admin/peek-session", async (req, res) => {
  try {
    const { sessionId } = req.query;
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const meta = await getSessionMeta(String(sessionId));
    const items = await getSessionItems(String(sessionId));
    res.json({ meta, items_count: items.length, last_item: items[items.length - 1] || null });
  } catch (e) {
    res.status(500).json({ error: "peek failed", detail: String(e) });
  }
});

// Helpers
async function userExists(username) { return Boolean(await redis.exists(kUser(username))); }

async function createUser(username) {
  await redis.hset(kUser(username), { created_at: Date.now() });
  await redis.hset(kUser(username), { score: 0, answered: 0, correct: 0 });
  await redis.zadd(kLB(), { score: 0, member: username });
  await redis.zadd('leaderboard:global', { score: 0, member: username });
}

async function exclusionsCount(username) { return await redis.llen(kExcl(username)); }
async function getExclusions(username) { return await redis.lrange(kExcl(username), 0, -1); }
async function pushExclusions(username, questions) { if (!questions?.length) return 0; return await redis.rpush(kExcl(username), ...questions); }

async function createSession({ username, topic, startingDifficulty }) {
  const id = uuid();
  await redis.hset(kSess(id), {
    username,
    topic: topic || 'random',
    start_diff: startingDifficulty || 'MSI3',
    created_at: Date.now()
  });
  return id;
}

async function getSessionMeta(sessionId) {
  const data = await redis.hgetall(kSess(sessionId));
  if (!data || Object.keys(data).length === 0) return null;
  return data;
}

async function getSessionItems(sessionId) {
  const raw = await redis.lrange(kSessItems(sessionId), 0, -1);
  const items = [];
  for (const r of raw) {
    if (typeof r === "string") {
      const t = r.trim();
      if (t.startsWith("{") || t.startsWith("[")) { try { items.push(JSON.parse(t)); } catch {} }
    } else if (r && typeof r === "object" && !Array.isArray(r)) {
      items.push(r);
    }
  }
  return items;
}

async function pushSessionItem(sessionId, item) { await redis.rpush(kSessItems(sessionId), item); }

async function updateLastSessionItem(sessionId, patch) {
  const len = await redis.llen(kSessItems(sessionId));
  if (len === 0) return;

  const raw = await redis.lindex(kSessItems(sessionId), len - 1);
  let last = null;

  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("{") || t.startsWith("[")) { try { last = JSON.parse(t); } catch {} }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) { last = raw; }

  if (!last) return;

  const updated = { ...last, ...patch };
  await redis.lset(kSessItems(sessionId), len - 1, updated);
}

////////////////////////////////////////////////////////////////////////////////
// OPENAI HELPERS (question/grade/summarize)
////////////////////////////////////////////////////////////////////////////////

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
The questions should be difficult questions designed to mimic questions an attending physician would as (or "pimp") a medical student or resident.
Ensure you take into account the appropriate difficulty and topic. The questions should be primarily clinical and related to medicine. Questions should not be excessively basic sceince questions, and should always be relevant to clincal practice. Things like MOA of drugs is fair game but the details of an obscure second messenger cascade for example are not.  
The questions should be considered very challenging/difficult for that particular difficulty level. For example, if the difficulty is R1, the question should be considered challenging but doable for the top 5% of first year residents. Ensure that the difficuly is actually scaling, in other words ensure that there is actually a noticeable change in difficulty between the levels. 
Avoid duplicates / near-duplicates of provided examples.`;

  const userPayload = { topic: topic || "random", difficulty: difficulty || "MSI3", avoid_examples: avoid };

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) }
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

  const system = `Grade medical answers tersely.
Return ONLY JSON:
{"is_correct": true|false, "explanation": "1-3 sentences if incorrect else empty", "difficulty_delta": -1|0|1}`;

  const userPayload = { question, userAnswer, difficulty };

  let parsed = null;
  try {
    const resp = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      input: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(userPayload) }
      ]
    });
    debugResp("grade", resp);
    parsed = parseResponsesJSON(resp);
  } catch (e) {
    return { is_correct: false, explanation: "Grader unavailable; keeping same difficulty.", difficulty_delta: 0 };
  }

  if (!parsed || (parsed.is_correct === undefined && parsed.explanation === undefined)) {
    return { is_correct: false, explanation: "Grader returned unexpected format.", difficulty_delta: 0 };
  }

  const is_correct = !!parsed.is_correct;
  const explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";
  let delta = Number(parsed.difficulty_delta);
  if (![ -1, 0, 1 ].includes(delta)) delta = is_correct ? 1 : 0;

  return { is_correct, explanation, difficulty_delta: delta };
}

async function aiSummarizeSession({ transcript, startDifficulty }) {
  const system = `You will summarize the session in detail, explain in detail the strengths and weaknesses of the user in that session with examples. Be a fair but objective rater. Try to use the sandwhich method to provide feedback. Additioanlly, you must return a final rating for that student (what level they are performing at).
Return JSON ONLY:
{"feedback": "short feedback", "rating": "MSI1|MSI2|MSI3|MSI4|R1|R2|R3|R4|R5|Attending"}`;

  const userPayload = {
    startDifficulty: startDifficulty || "MSI3",
    items: transcript.map(t => ({
      question: t.question,
      userAnswer: t.user_answer ?? "",
      correct: !!t.is_correct,
      explanation: t.explanation ?? ""
    }))
  };

  const resp = await openai.responses.create({
    model: "gpt-4.1",
    temperature: 0,
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) }
    ]
  });

  const txt = resp.output_text?.trim() || resp.output?.[0]?.content?.[0]?.text || "{}";
  let parsed;
  try { parsed = JSON.parse(txt); } catch { parsed = {}; }

  const feedback = typeof parsed.feedback === "string" ? parsed.feedback : "Good effort.";
  const rating = DIFF.includes(parsed.rating) ? parsed.rating : "MSI3";
  return { feedback, rating };
}

////////////////////////////////////////////////////////////////////////////////
// ROUTES
////////////////////////////////////////////////////////////////////////////////

// Health check
app.get('/health', async (_req, res) => {
  try {
    await redis.ping();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Create user
app.post('/api/users', async (req, res) => {
  try {
    const { username } = req.body || {};
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: "username required" });
    }

    const ok = await isUsernameAllowedAI(username);
    if (!ok) {
      return res.status(400).json({ error: 'That username isn’t allowed. Please choose something else.' });
    }

    if (await userExists(username)) {
      return res.status(409).json({ error: "Username taken" });
    }
    await createUser(username);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Failed to create user", detail: String(e) });
  }
});

// Exclusions count
app.get('/api/exclusions/count', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "username required" });
    const count = await exclusionsCount(String(username));
    res.json({ count });
  } catch (e) {
    res.status(500).json({ error: "Failed to get count", detail: String(e) });
  }
});

// Full exclusions list
app.get('/api/exclusions', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "username required" });
    const list = await getExclusions(String(username));
    res.json({ questions: list });
  } catch (e) {
    res.status(500).json({ error: "Failed to get exclusions", detail: String(e) });
  }
});

// Start session
app.post('/api/sessions', async (req, res) => {
  try {
    const { username, topic, startingDifficulty } = req.body || {};
    if (!username) return res.status(400).json({ error: "username required" });
    if (!(await userExists(username))) {
      return res.status(404).json({ error: "User not found" });
    }
    const id = await createSession({ username, topic, startingDifficulty });
    res.json({ sessionId: id, topic: topic || 'random', difficulty: startingDifficulty || 'MSI3' });
  } catch (e) {
    res.status(500).json({ error: "Failed to create session", detail: String(e) });
  }
});

// Next question
app.post('/api/next', async (req, res) => {
  try {
    const { sessionId, topic: overrideTopic, difficulty: overrideDiff } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const meta = await getSessionMeta(sessionId);
    if (!meta) return res.status(404).json({ error: "Session not found" });

    const username = meta.username;
    const topic = overrideTopic || meta.topic || 'random';

    const items = await getSessionItems(sessionId);
    const lastDiff = items.length
      ? items[items.length - 1].final_difficulty
      : (overrideDiff || meta.start_diff || "MSI3");
    const difficulty = lastDiff;

    const exclList = await getExclusions(username);

    const already = await getSessionItems(sessionId);
    const sessionQs = already.map(it => it.question).filter(Boolean);

    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const avoidSet = new Set([...exclList, ...sessionQs].map(norm));

    let question;
    let tries = 0;
    do {
      question = await aiGenerateQuestion({ topic, difficulty, avoidList: [...avoidSet] });
      tries++;
    } while (avoidSet.has(norm(question)) && tries < 3);

    if (avoidSet.has(norm(question))) {
      question = `${topic !== 'random' ? topic + ': ' : ''}${question}`;
    }

    const asked_index_in_session = items.length + 1;
    const baseCount = await exclusionsCount(username);
    const q_number = baseCount + asked_index_in_session;

    await pushSessionItem(sessionId, {
      question,
      topic,
      starting_difficulty: difficulty,
      final_difficulty: difficulty,
      asked_index_in_session,
      asked_at: Date.now()
    });

    res.json({ q_number, question, difficulty });
  } catch (e) {
    res.status(500).json({ error: "Failed to get next question", detail: String(e) });
  }
});

// Grade answer
app.post('/api/answer', async (req, res) => {
  try {
    const { sessionId, answer } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    if (typeof answer !== "string") return res.status(400).json({ error: "answer required" });

    const meta = await getSessionMeta(sessionId);
    if (!meta) return res.status(404).json({ error: "Session not found" });
    const username = meta.username;

    const items = await getSessionItems(sessionId);
    if (items.length === 0) return res.status(400).json({ error: "No question to grade" });
    const last = items[items.length - 1];

    const { is_correct, explanation, difficulty_delta } = await aiGradeAnswer({
      question: last.question,
      userAnswer: answer,
      difficulty: last.final_difficulty
    });

    const nextDiff = bumpDifficulty(last.final_difficulty, difficulty_delta);

    const { correct, wrong } = pointsFor(last.final_difficulty);
    const points_delta = is_correct ? correct : -wrong;

    const score_after = await applyScoreDelta(username, points_delta, is_correct);

    const askedAt = Date.now();

    await pushHistory(username, {
      question: last.question,
      difficulty: last.final_difficulty,
      user_answer: answer,
      is_correct,
      explanation,
      points_delta,
      score_after,
      asked_at: askedAt,
    });

    await updateLastSessionItem(sessionId, {
      user_answer: answer,
      is_correct,
      explanation,
      final_difficulty: nextDiff,
      points_delta,
      score_after
    });

    res.json({ correct: is_correct, explanation, nextDifficulty: nextDiff, points_delta, score: score_after });
  } catch (e) {
    res.status(500).json({ error: "Failed to grade answer", detail: String(e) });
  }
});

// Get a user's score + stats
app.get('/api/score', async (req, res) => {
  try {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: "username required" });
    if (!(await userExists(String(username)))) return res.status(404).json({ error: "User not found" });

    const stats = await getUserScore(String(username));
    res.json(stats);
  } catch (e) {
    res.status(500).json({ error: "Failed to get score", detail: String(e) });
  }
});

// Leaderboard (global)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 10)));
    const key = 'leaderboard:global';

    const raw = await redis.zrange(key, 0, limit - 1, { rev: true, withScores: true });

    let pairs = [];
    if (Array.isArray(raw) && raw.length > 0) {
      if (typeof raw[0] === 'object' && raw[0] !== null && ('member' in raw[0] || 'score' in raw[0])) {
        pairs = raw.map(r => [String(r.member ?? ''), Number(r.score ?? 0)]);
      } else if (typeof raw[0] === 'string' || typeof raw[0] === 'number') {
        for (let i = 0; i < raw.length; i += 2) {
          const m = String(raw[i] ?? '');
          const s = Number(raw[i + 1] ?? 0);
          pairs.push([m, s]);
        }
      }
    }

    const board = pairs
      .filter(([m]) => m && m.trim().length > 0)
      .map(([m, s], i) => ({ rank: i + 1, username: m, score: Number.isFinite(s) ? s : 0 }));

    res.json({ leaderboard: board });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get leaderboard', detail: String(e) });
  }
});

// GET /api/history
app.get('/api/history', async (req, res) => {
  try {
    const username = String(req.query.username || "");
    if (!username) return res.status(400).json({ error: "username required" });

    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));
    const rows = await redis.lrange(kHistory(username), 0, limit - 1);

    const items = (rows || []).map((s) => {
      try { return JSON.parse(s); } catch { return { raw: s }; }
    });

    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: "history failed", detail: String(e) });
  }
});

// ==================== MED LEARNER ROUTES (all under /med) ====================

// Get completed topics for a user
app.get('/med/topics', (req, res) => {
  const user_id = req.query.user_id;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });
  const rows = medDb
    .prepare(`SELECT topic FROM completed_topics WHERE user_id = ? ORDER BY created_at DESC`)
    .all(user_id);
  res.json({ topics: rows.map(r => r.topic) });
});

// Add a completed topic
app.post('/med/topics', (req, res) => {
  const { user_id, topic } = req.body || {};
  if (!user_id || !topic) return res.status(400).json({ error: 'user_id and topic required' });
  try {
    medDb.prepare(`INSERT OR IGNORE INTO completed_topics (user_id, topic) VALUES (?, ?)`).run(user_id, topic);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload & index a PDF (multipart/form-data)
app.post('/med/pdfs', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const label = req.body?.label || req.file.originalname;
    const { docId, nChunks } = await indexPdfBuffer(req.file.buffer, label);
    res.json({ ok: true, doc_id: docId, chunks: nChunks, label });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch & index a PDF by URL
app.post('/med/pdfs/by-url', async (req, res) => {
  try {
    const { url, label } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });

    const r = await fetch(url);
    if (!r.ok) return res.status(400).json({ error: `fetch failed: ${r.status}` });

    const buf = Buffer.from(await r.arrayBuffer());
    const { docId, nChunks } = await indexPdfBuffer(buf, label || url);
    res.json({ ok: true, doc_id: docId, chunks: nChunks, label: label || url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search indexed PDFs (FTS5; BM25 ranking)
app.get('/med/pdfs/search', (req, res) => {
  const q = req.query.q;
  const k = Number(req.query.k || 8);
  if (!q) return res.status(400).json({ error: 'q required' });

  try {
    const rows = medDb.prepare(`
      SELECT pc.rowid as rowid,
             pc.id     as chunk_id,
             pc.doc_id as doc_id,
             pd.label  as label,
             pc.text   as text,
             bm25(pdf_chunks_fts) as score
      FROM pdf_chunks_fts
      JOIN pdf_chunks pc ON pc.rowid = pdf_chunks_fts.rowid
      JOIN pdf_docs   pd ON pd.id = pc.doc_id
      WHERE pdf_chunks_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(q, k);

    res.json({
      hits: rows.map(r => ({
        doc_id: r.doc_id,
        label : r.label,
        chunk_id: r.chunk_id,
        text  : r.text,
        score : r.score
      }))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

////////////////////////////////////////////////////////////////////////////////
// START
////////////////////////////////////////////////////////////////////////////////
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
