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

// ---- History helpers ----
const kHistory = (u) => `history:${u}`;

// Append one history item, keep only most recent N
async function pushHistory(username, item, keep = 1000) {
  // store as JSON lines
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

    // prefer to break on paragraph/sentence
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
  const docId = uuidv4(); // uses your import { v4 as uuidv4 } from 'uuid'

  medDb.prepare(`INSERT INTO pdf_docs (id, label) VALUES (?, ?)`).run(docId, label || null);

  const chunks = chunkText(data.text || '');
  const insert = medDb.prepare(`INSERT INTO pdf_chunks (id, doc_id, ord, text) VALUES (?, ?, ?, ?)`);

  const tx = medDb.transaction(() => {
    chunks.forEach((c, idx) => insert.run(uuidv4(), docId, idx, c));
  });
  tx();

  return { docId, nChunks: chunks.length };
}



// ADMIN NUKE: delete all app data (guarded)
// ADMIN NUKE: delete all app data (guarded)
// Usage: DELETE /admin/wipe?secret=YOUR_SECRET  (add &dry=1 to dry-run)
app.delete('/admin/wipe', async (req, res) => {
  try {
    const secret = String(req.query.secret || "");
    if (secret !== process.env.ADMIN_SECRET) {
      return res.status(403).json({ error: "forbidden" });
    }
    const dry = String(req.query.dry || "0") === "1";

    // Adjust to your actual key prefixes if different
    const patterns = [
      "user:*",        // user stats hash
      "session:*",     // live sessions
      "sessionitem:*", // per-question items (if applicable)
      "exclusions:*",  // exclusion lists
      "history:*",     // question history (if applicable)
    ];

    let deleted = 0;

    // Helper: delete in chunks to avoid huge payloads
    async function delChunked(keys) {
      const CHUNK = 100;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK);
        if (!dry && slice.length) {
          await redis.del(...slice);
        }
        deleted += slice.length;
      }
    }

    for (const pattern of patterns) {
      const keys = await redis.keys(pattern);   // works on all clients
      if (keys && keys.length) {
        await delChunked(keys);
      }
    }

    // Leaderboard ZSET
    if (!dry) await redis.del("leaderboard:global");

    res.json({ ok: true, dry, deleted_keys_estimate: deleted });
  } catch (e) {
    res.status(500).json({ error: "wipe failed", detail: String(e) });
  }
});



// --- AI username moderation (keeps usernames case-sensitive) ---
const OPENAI_MOD_URL = "https://api.openai.com/v1/moderations";
// Optional: set behavior if the moderation call fails (true = allow; false = block)
const ALLOW_ON_MOD_FAIL = true;

/**
 * Returns true if the username is acceptable, false if it's over the line.
 * Uses OpenAI's moderation model (text-only here).
 */
async function isUsernameAllowedAI(username) {
  try {
    const resp = await fetch(OPENAI_MOD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "omni-moderation-latest",
        input: username, // keep original casing; judgment is case-insensitive internally
      }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || resp.statusText);

    // Normalized access across possible shapes
    const r = Array.isArray(data.results) ? data.results[0] : data;
    const c = r.categories || {};
    const s = r.category_scores || r.scores || {};
    const flagged = r.flagged === true;

    // We block only the clearly over-the-top categories.
    // "Edgy jokes" will usually not trip these thresholds.
    const blockHardFlags =
      c.hate === true || c.hate_threatening === true ||
      c.harassment_threats === true || // explicit threats
      c.sexual_minors === true ||
      c.violence_graphic === true;

    // For softer categories, use higher probability thresholds so borderline stuff passes.
    const blockByScore =
      (s.hate || 0) > 0.50 ||
      (s.hate_threatening || 0) > 0.40 ||
      (s.harassment_threats || 0) > 0.50 ||
      (s.sexual_minors || 0) > 0.20 ||
      (s.violence_graphic || 0) > 0.40;

    return !(flagged || blockHardFlags || blockByScore);
  } catch (e) {
    console.error("Moderation check failed:", e);
    return ALLOW_ON_MOD_FAIL; // choose fail-open by default; flip to false to be stricter
  }
}


// Redis keys (per-username / per-session)
const kUser = (u) => `user:${u}`;
const kExcl = (u) => `excl:${u}`; // Redis LIST of question strings (ordered)
const kSess = (s) => `sess:${s}`; // Redis HASH for session meta
const kSessItems = (s) => `sess:${s}:items`; // Redis LIST of JSON strings (one per Q&A)

//DEBUGGERS
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

// Points map: harder tiers are worth more.
// Correct = +10 * tierIndex, Wrong = -5 * tierIndex (never lets score drop below 0).
// Tier index: MSI1=1 ... Attending=10
const kLB = () => `leaderboard:global`;

function tierIndex(label) {
  const i = DIFF.indexOf(label);
  return (i >= 0 ? i : 0) + 1; // 1..10
}
function pointsFor(label) {
  const t = tierIndex(label);
  return { correct: 10 * t, wrong: 5 * t };
}

async function getUserScore(username) {
  const h = await redis.hgetall(kUser(username));
  const score = Number(h?.score || 0);
  const answered = Number(h?.answered || 0);
  const correct = Number(h?.correct || 0);
  return { score, answered, correct, accuracy: answered ? correct / answered : 0 };
}

// Atomically bump score/stats and the leaderboard.
// Floors score at 0 if it would go negative.
async function applyScoreDelta(username, delta, wasCorrect) {
  // increment counters
  await redis.hincrby(kUser(username), "answered", 1);
  if (wasCorrect) await redis.hincrby(kUser(username), "correct", 1);

  // bump score in user hash and leaderboard ZSET
  let newScore = await redis.hincrby(kUser(username), "score", delta);
  await redis.zincrby(kLB(), delta, username);

  if (newScore < 0) {
    // clamp both back to 0
    await redis.hincrby(kUser(username), "score", -newScore);      // add positive to bring to 0
    await redis.zincrby(kLB(), -newScore, username);
    newScore = 0;
  }
  return newScore;
}


// put this helper near your other helpers
// SAFE: never throws, only parses when a string clearly looks like JSON.
function parseResponsesJSON(resp) {
  try {
    // A) Aggregated text
    const t1 = typeof resp?.output_text === "string" ? resp.output_text.trim() : "";
    if (t1 && (t1.startsWith("{") || t1.startsWith("["))) {
      return JSON.parse(t1);
    }

    // B) First content part
    const part = resp?.output?.[0]?.content?.[0];
    if (!part) return null;

    // text field (string)
    const t2 = typeof part?.text === "string" ? part.text.trim() : "";
    if (t2 && (t2.startsWith("{") || t2.startsWith("["))) {
      return JSON.parse(t2);
    }

    // explicit json field (already parsed)
    if (part && typeof part.json === "object" && part.json !== null) {
      return part.json;
    }

    // the part itself might already be a JSON object
    if (part && typeof part === "object" && !Array.isArray(part)) {
      return part;
    }

    return null;
  } catch {
    // never throw
    return null;
  }
}

//DEBUG
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
    res.json({
      meta,
      items_count: items.length,
      last_item: items[items.length - 1] || null
    });
  } catch (e) {
    res.status(500).json({ error: "peek failed", detail: String(e) });
  }
});

// Helpers
async function userExists(username) {
  return Boolean(await redis.exists(kUser(username)));
}

async function createUser(username) {
  // Simple marker key; hash allows future fields
  await redis.hset(kUser(username), { created_at: Date.now() });
  // after: await createUser(username);
  await redis.hset(kUser(username), { score: 0, answered: 0, correct: 0 });
  await redis.zadd(kLB(), { score: 0, member: username });
  await redis.zadd('leaderboard:global', { score: 0, member: username }); // NOT empty string
}

async function exclusionsCount(username) {
  return await redis.llen(kExcl(username));
}

async function getExclusions(username) {
  // full list (as strings)
  return await redis.lrange(kExcl(username), 0, -1);
}

async function pushExclusions(username, questions) {
  if (!questions?.length) return 0;
  // RPUSH preserves order of session
  return await redis.rpush(kExcl(username), ...questions);
}

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
      if (t.startsWith("{") || t.startsWith("[")) {
        try { items.push(JSON.parse(t)); } catch {}
      }
    } else if (r && typeof r === "object" && !Array.isArray(r)) {
      // Upstash client may already deserialize JSON -> object
      items.push(r);
    }
  }
  return items;
}


async function pushSessionItem(sessionId, item) {
  await redis.rpush(kSessItems(sessionId), item);
}

// UPDATE last
async function updateLastSessionItem(sessionId, patch) {
  const len = await redis.llen(kSessItems(sessionId));
  if (len === 0) return;

  const raw = await redis.lindex(kSessItems(sessionId), len - 1);
  let last = null;

  if (typeof raw === "string") {
    const t = raw.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { last = JSON.parse(t); } catch {}
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    last = raw;
  }

  if (!last) return;

  const updated = { ...last, ...patch };

  // Write back using the same style as push (see below)
  // If your push writes objects, write object. If it writes strings, JSON.stringify here too.
  await redis.lset(kSessItems(sessionId), len - 1, updated);
}


////////////////////////////////////////////////////////////////////////////////
// OPENAI HELPERS
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
  // Mock path to keep you unblocked if quota/rate-limit/whatever:
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
    // If OpenAI itself errors (429/500/etc), fall back gracefully
    return { is_correct: false, explanation: "Grader unavailable; keeping same difficulty.", difficulty_delta: 0 };
  }

  // If parsing failed or fields missing, also fail gracefully
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
    
    // AI moderation gate (case-sensitive username preserved)
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

    // Determine current difficulty: last session item or session start
    const items = await getSessionItems(sessionId);
    const lastDiff = items.length
      ? items[items.length - 1].final_difficulty
      : (overrideDiff || meta.start_diff || "MSI3");
    const difficulty = lastDiff;

    // Avoid duplicates by consulting user's existing exclusions
    const avoidList = await getExclusions(username);
    const exclList = await getExclusions(username);

    // Get current session items (so we don't repeat within the session)
    const already = await getSessionItems(sessionId);
    const sessionQs = already.map(it => it.question).filter(Boolean);

    // Build a fast lookup set (case/space normalized)
    const norm = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    const avoidSet = new Set([...exclList, ...sessionQs].map(norm));

    // Generate with retry if duplicate slips through
    let question;
    let tries = 0;
    do {
      question = await aiGenerateQuestion({
        topic,
        difficulty,
        avoidList: [...avoidSet]   // still pass for model context
      });
      tries++;
    } while (avoidSet.has(norm(question)) && tries < 3);

    // If still duplicate after retries, tweak the prompt topic slightly as a hacky escape
    if (avoidSet.has(norm(question))) {
      question = `${topic !== 'random' ? topic + ': ' : ''}${question}`;
    }

    /*
    let question = await aiGenerateQuestion({ topic, difficulty, avoidList });
    let tries = 0;
    while (avoidList.includes(question) && tries < 2) {
      question = await aiGenerateQuestion({ topic, difficulty, avoidList });
      tries++;
    }
    */

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

    // compute points for THIS item using the difficulty at the time of asking
    const { correct, wrong } = pointsFor(last.final_difficulty);
    const points_delta = is_correct ? correct : -wrong;

    // apply score change + counters
    const score_after = await applyScoreDelta(username, points_delta, is_correct);

    // compute points_delta above…
    const askedAt = Date.now();

    // record to history
    await pushHistory(username, {
      question: last.question,
      difficulty: last.final_difficulty,   // difficulty when asked
      user_answer: answer,
      is_correct,
      explanation,
      points_delta,
      score_after,                         // optional: current score after grading
      asked_at: askedAt,
    });


    // persist back to last item
    await updateLastSessionItem(sessionId, {
      user_answer: answer,
      is_correct,
      explanation,
      final_difficulty: nextDiff,
      points_delta,
      score_after
    });

    res.json({
      correct: is_correct,
      explanation,
      nextDifficulty: nextDiff,
      points_delta,
      score: score_after
    });
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

// Leaderboard (global). Defaults to top 20.
// Replace your current /api/leaderboard with this
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 10)));
    const key = 'leaderboard:global';

    const raw = await redis.zrange(key, 0, limit - 1, { rev: true, withScores: true });

    // Normalize: supports both object-array and alternating-array formats
    let pairs = [];

    if (Array.isArray(raw) && raw.length > 0) {
      if (typeof raw[0] === 'object' && raw[0] !== null && ('member' in raw[0] || 'score' in raw[0])) {
        // Upstash modern shape: [{member, score}, ...]
        pairs = raw.map(r => [String(r.member ?? ''), Number(r.score ?? 0)]);
      } else if (typeof raw[0] === 'string' || typeof raw[0] === 'number') {
        // Alternating shape: ["member","score","member","score", ...]
        for (let i = 0; i < raw.length; i += 2) {
          const m = String(raw[i] ?? '');
          const s = Number(raw[i + 1] ?? 0);
          pairs.push([m, s]);
        }
      }
    }

    // Filter out empty members and clamp NaN scores to 0
    const board = pairs
      .filter(([m]) => m && m.trim().length > 0)
      .map(([m, s], i) => ({
        rank: i + 1,
        username: m,
        score: Number.isFinite(s) ? s : 0
      }));

    res.json({ leaderboard: board });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get leaderboard', detail: String(e) });
  }
});

// GET /api/history?username=alice&limit=200
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


// Conclude session (merge to exclusions, return new_count, next_number, feedback, rating)
app.post('/api/conclude', async (req, res) => {
  try {
    const { sessionId } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: "sessionId required" });

    const meta = await getSessionMeta(sessionId);
    if (!meta) return res.status(404).json({ error: "Session not found" });

    const username = meta.username;
    const transcript = await getSessionItems(sessionId);

    // Merge all session questions into user's exclusions
    const newQs = transcript.map(t => t.question);
    await pushExclusions(username, newQs);

    const new_count = await exclusionsCount(username);
    const next_number = new_count + 1;

    const session_points = transcript.reduce((sum, t) => {
      if (typeof t.points_delta === "number") return sum + t.points_delta;
      // fallback if older items predate scoring: estimate by starting_difficulty
      const { correct, wrong } = pointsFor(t.starting_difficulty || t.final_difficulty || "MSI3");
      return sum + (t.is_correct ? correct : -wrong);
    }, 0);

    const { feedback, rating } = await aiSummarizeSession({
      transcript,
      startDifficulty: meta.start_diff
    });

    res.json({ new_count, next_number, feedback, rating, session_points });
  } catch (e) {
    res.status(500).json({ error: "Failed to conclude session", detail: String(e) });
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
    medDb.prepare(`INSERT OR IGNORE INTO completed_topics (user_id, topic) VALUES (?, ?)`)
         .run(user_id, topic);
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

    // Node 18+ has global fetch on Render; no node-fetch needed
    const r = await fetch(url);
    if (!r.ok) return res.status(400).json({ error: `fetch failed: ${r.status}` });

    const buf = Buffer.from(await r.arrayBuffer());
    const { docId, nChunks } = await indexPdfBuffer(buf, label || url);
    res.json({ ok: true, doc_id: docId, chunks: nChunks, label: label || url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Search indexed PDFs (FTS5; supports BM25 ranking)
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

// ==== Med Learner: ensure standard PDF is indexed on startup ====
// Prefer ENV so you can swap the file without changing code.
const STANDARD_PDF_URL =
  process.env.STANDARD_PDF_URL || 'https://raw.githubusercontent.com/gurnoorsidhu602-alt/file/7c1f0d025f19f12e2494694197bd38da92f09f49/toc.pdf';
const STANDARD_PDF_LABEL =
  process.env.STANDARD_PDF_LABEL || 'STANDARD_TOC_V1';

// Optional: prevent accidental duplicate labels from different deploys
medDb.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_label_unique
  ON pdf_docs(label) WHERE label IS NOT NULL;
`);

// Returns true if a doc with this label already exists
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

// Kick it off at boot—non-blocking
ensureStandardPdfIndexed();


////////////////////////////////////////////////////////////////////////////////
// START
////////////////////////////////////////////////////////////////////////////////

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
