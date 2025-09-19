import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Redis } from '@upstash/redis';
import OpenAI from 'openai';
import { v4 as uuid } from 'uuid';

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
The questions should be considered very challenging/difficult for that particular difficulty level. For example, if the difficulty is R1, the question should be considered challenging but doable for the top 20% of first year residents. 
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
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
    // Upstash client supports ZRANGE with {rev:true, withScores:true}
    const rows = await redis.zrange(kLB(), 0, limit - 1, { rev: true, withScores: true });

    // rows is [{member, score}, ...] in modern client
    const board = rows.map((r, i) => ({
      rank: i + 1,
      username: r.member || r.member?.toString?.() || r[0],
      score: Number(r.score ?? r[1] ?? 0)
    }));

    res.json({ leaderboard: board });
  } catch (e) {
    res.status(500).json({ error: "Failed to get leaderboard", detail: String(e) });
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

////////////////////////////////////////////////////////////////////////////////
// START
////////////////////////////////////////////////////////////////////////////////

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
