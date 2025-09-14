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

// put this helper near your other helpers
function parseResponsesJSON(resp) {
  // 1) Best case: OpenAI aggregates valid JSON here
  if (typeof resp.output_text === 'string' && resp.output_text.trim().startsWith('{')) {
    try { return JSON.parse(resp.output_text); } catch {}
  }

  // 2) Raw parts
  const part = resp?.output?.[0]?.content?.[0];
  if (!part) return null;

  // a) Some SDKs return { type: 'output_text', text: '..."' }
  if (typeof part.text === 'string' && part.text.trim().startsWith('{')) {
    try { return JSON.parse(part.text); } catch {}
  }

  // b) Some SDKs return a parsed object under "json" or as the part itself
  if (part.json && typeof part.json === 'object') return part.json;
  if (typeof part === 'object' && !Array.isArray(part)) return part;

  return null;
}


// Helpers
async function userExists(username) {
  return Boolean(await redis.exists(kUser(username)));
}

async function createUser(username) {
  // Simple marker key; hash allows future fields
  await redis.hset(kUser(username), { created_at: Date.now() });
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
  return raw.map((r) => JSON.parse(r));
}

async function pushSessionItem(sessionId, item) {
  // item shape:
  // { question, topic, starting_difficulty, final_difficulty, asked_index_in_session,
  //   user_answer, is_correct, explanation, asked_at }
  await redis.rpush(kSessItems(sessionId), JSON.stringify(item));
}

async function updateLastSessionItem(sessionId, patch) {
  // read last, patch, write back at same index
  const len = await redis.llen(kSessItems(sessionId));
  if (len === 0) return;
  const last = JSON.parse(await redis.lindex(kSessItems(sessionId), len - 1));
  const updated = { ...last, ...patch };
  await redis.lset(kSessItems(sessionId), len - 1, JSON.stringify(updated));
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
Keep it clinical or tightly clinically-relevant basic science.
Avoid duplicates / near-duplicates of provided examples.`;

  const userPayload = { topic: topic || "random", difficulty: difficulty || "MSI3", avoid_examples: avoid };

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0.7,
    response_format: { type: "json_object" },
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
  if (process.env.MOCK_AI === '1') {
    const golds = {
      "First-line treatment for status asthmaticus?": "nebulized saba and ipratropium",
      "Antidote for organophosphate poisoning?": "atropine and pralidoxime",
      "Next step for suspected PE in a hemodynamically stable patient?": "ctpa",
      "Diagnostic test of choice for C. difficile infection?": "stool pcr",
      "Target INR for mechanical mitral valve?": "3.0"
    };
    const gold = (golds[question] || "").toLowerCase().trim();
    const ans = String(userAnswer || "").toLowerCase().trim();
    const is_correct = gold && (ans === gold || gold.includes(ans) || ans.includes(gold));
    return { is_correct, explanation: is_correct ? "" : (gold ? `Correct: ${gold}.` : "Reviewed."), difficulty_delta: is_correct ? 1 : 0 };
  }

  const system = `Grade medical answers tersely.
Return ONLY JSON:
{"is_correct": true|false, "explanation": "1-3 sentences if incorrect else empty", "difficulty_delta": -1|0|1}`;

  const userPayload = { question, userAnswer, difficulty };

  const resp = await openai.responses.create({
    model: "gpt-4.1-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    input: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(userPayload) }
    ]
  });

  const parsed = parseResponsesJSON(resp) || {};
  const is_correct = !!parsed.is_correct;
  const explanation = typeof parsed.explanation === "string" ? parsed.explanation : "";
  let delta = Number(parsed.difficulty_delta);
  if (![ -1, 0, 1 ].includes(delta)) delta = is_correct ? 1 : 0;
  return { is_correct, explanation, difficulty_delta: delta };
}


async function aiSummarizeSession({ transcript, startDifficulty }) {
  const system = `You are a strict medical educator. Summarize performance briefly and assign a single rating.
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

    // Generate, with a simple retry if exact duplicate slips through
    let question = await aiGenerateQuestion({ topic, difficulty, avoidList });
    let tries = 0;
    while (avoidList.includes(question) && tries < 2) {
      question = await aiGenerateQuestion({ topic, difficulty, avoidList });
      tries++;
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

    const items = await getSessionItems(sessionId);
    if (items.length === 0) return res.status(400).json({ error: "No question to grade" });
    const last = items[items.length - 1];

    const { is_correct, explanation, difficulty_delta } = await aiGradeAnswer({
      question: last.question,
      userAnswer: answer,
      difficulty: last.final_difficulty
    });

    const nextDiff = bumpDifficulty(last.final_difficulty, difficulty_delta);

    await updateLastSessionItem(sessionId, {
      user_answer: answer,
      is_correct,
      explanation,
      final_difficulty: nextDiff
    });

    res.json({ correct: is_correct, explanation, nextDifficulty: nextDiff });
  } catch (e) {
    res.status(500).json({ error: "Failed to grade answer", detail: String(e) });
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

    const { feedback, rating } = await aiSummarizeSession({
      transcript,
      startDifficulty: meta.start_diff
    });

    res.json({ new_count, next_number, feedback, rating });
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
