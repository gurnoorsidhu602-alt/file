// server.js
// Shared backend for One Line Pimp Simulator (incl. MCCQE mode), Medical Case
// Simulator and Med Learner. Serves the three pages and the JSON API from the
// same Render web service.
//
// Module map:
//   lib/ai.js           OpenAI wrapper, model routing, usage/latency/cost logging
//   lib/caseCatalog.js  lab tests (SI), panels, studies, medications, order parser
//   lib/caseEngine.js   simulated clock, physiology, orders/MAR, scheduled results
//   lib/caseAi.js       case prompts (generation, questions, progression, debrief)
//   lib/caseStore.js    case persistence (Postgres or Redis) with version checks
//   lib/learnerStore.js Med Learner persistence (Postgres or SQLite)
//   lib/db.js           optional Postgres pool + migrations

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Redis } from '@upstash/redis';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import {
  responsesCall, aiJSON, parseResponsesJSON, extractOutputText, extractCanadianText, setUsageSink, recentUsage, summarizeUsage,
  BASE_MODEL, STRICT_MODEL, PIMP_MODEL, PIMP_GENERATOR_MODEL, PIMP_GRADER_MODEL, PIMP_DISCUSSION_MODEL, CASE_MODEL, CASE_FAST_MODEL
} from './lib/ai.js';
import { hasPg, migrate, q } from './lib/db.js';
import { createMemoryRedis } from './lib/memoryRedis.js';
import { makeCaseStore, ConflictError } from './lib/caseStore.js';
import { learnerStore } from './lib/learnerStore.js';
import { withLock } from './lib/mutex.js';
import { HARDCODED_TOC } from './lib/toc.js';
import {
  initEngine, interact as engineInteract, placeOrders, advance as engineAdvance, publicOrders, pendingList,
  dayLabel, ensureArray, sortLabCategories, ENGINE_VERSION
} from './lib/caseEngine.js';
import { generateCase, caseAiAdapter, concludeCase } from './lib/caseAi.js';
import { createTextbook } from './lib/textbook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = process.env.PORT || 3000;
const uuid = () => crypto.randomUUID();

////////////////////////////////////////////////////////////////////////////////
// APP, STORAGE
////////////////////////////////////////////////////////////////////////////////
const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));

const page = (file) => (_req, res) => res.sendFile(path.join(__dirname, file));
app.get(['/', '/index.html'], page('index.html'));
app.get(['/textbook', '/textbook.html'], page('textbook.html'));
// Med Learner was replaced by the textbook.
app.get(['/learner', '/learner.html', '/medlearner'], (_req, res) => res.redirect(301, '/textbook'));
app.get(['/casesim', '/casesim.html'], page('casesim.html'));
// Punjabi patient-education site: standalone static pages, public (no login), not linked from the other pages.
app.get(['/punjabi', '/patient-education'], (_req, res) => res.redirect(302, '/sehat/'));
app.use('/sehat', express.static(path.join(__dirname, 'sehat'), { maxAge: '1h' }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '1h' }));

const redis = (process.env.REDIS_MEMORY === '1' || !process.env.UPSTASH_REDIS_REST_URL)
  ? createMemoryRedis()
  : new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN });
if (process.env.REDIS_MEMORY === '1' || !process.env.UPSTASH_REDIS_REST_URL) console.warn('[storage] Using in-memory Redis (data is not persisted).');
if (process.env.DISABLE_AUTH === '1') console.warn('[auth] DISABLE_AUTH=1: authentication is OFF. Never use this in production.');

const caseStore = makeCaseStore(redis);
const textbook = createTextbook();

// AI usage persistence: Postgres table if available, else a capped Redis list.
setUsageSink(async (rec) => {
  if (hasPg()) {
    await q(`INSERT INTO ai_usage (at, tag, model, ok, input_tokens, cached_tokens, output_tokens, reasoning_tokens, ms, cost_usd, session_id, user_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [rec.at, rec.tag, rec.model, rec.ok, rec.input_tokens || 0, rec.cached_tokens || 0, rec.output_tokens || 0, rec.reasoning_tokens || 0, rec.ms || 0, rec.cost_usd, rec.sessionId || null, rec.userId || null]);
  } else {
    await redis.rpush('ai:usage', JSON.stringify(rec));
    await redis.ltrim('ai:usage', -5000, -1);
  }
});

////////////////////////////////////////////////////////////////////////////////
// DIFFICULTY + SCORING
////////////////////////////////////////////////////////////////////////////////
const DIFF = ['Easy', 'Medium', 'Hard', 'Expert', 'Brutal'];
const LEGACY_DIFF_MAP = {
  MSI1: 'Easy', MSI2: 'Medium', MSI3: 'Hard', MSI4: 'Hard', R1: 'Hard', R2: 'Expert', R3: 'Expert', R4: 'Brutal', R5: 'Brutal', Attending: 'Brutal',
  'MSI3-R1': 'Hard', 'MSI4-R2': 'Expert', 'R3-R5': 'Brutal', 'Attending-level brutal': 'Brutal'
};
function normalizeDifficulty(label) {
  const raw = String(label || 'Hard').trim();
  if (DIFF.includes(raw)) return raw;
  return LEGACY_DIFF_MAP[raw] || 'Hard';
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const bumpDifficulty = (label, delta) => {
  const i = DIFF.indexOf(normalizeDifficulty(label));
  return DIFF[i < 0 ? 2 : clamp(i + Number(delta || 0), 0, DIFF.length - 1)];
};
function tierIndex(label) { const i = DIFF.indexOf(normalizeDifficulty(label)); return (i >= 0 ? i : 2) + 1; }
function pointsFor(label) { const t = tierIndex(label); return { correct: 10 * t, wrong: 5 * t }; }

function timeMultiplierForAnswer(elapsedMs, difficulty) {
  const grace = { Easy: 20000, Medium: 30000, Hard: 45000, Expert: 60000, Brutal: 75000 }[normalizeDifficulty(difficulty)] || 45000;
  const elapsed = Math.max(0, Number(elapsedMs || 0));
  if (!elapsed || elapsed <= grace) return 1;
  const overRatio = (elapsed - grace) / (grace * 3);
  return Math.max(0.45, Math.round((1 - 0.55 * Math.min(1, overRatio)) * 100) / 100);
}

////////////////////////////////////////////////////////////////////////////////
// REDIS KEYS + USER HELPERS
////////////////////////////////////////////////////////////////////////////////
const usernameKey = (u) => String(u || '').trim();
const usernameIndexKey = (u) => `username_index:${String(u || '').trim().toLowerCase()}`;
const kUser = (u) => `user:${usernameKey(u)}`;
const kExcl = (u) => `excl:${usernameKey(u)}`;
const kConcepts = (u) => `concepts:${usernameKey(u)}`;
const kSess = (s) => `sess:${s}`;
const kSessItems = (s) => `sess:${s}:items`;
const kHistory = (u) => `history:${usernameKey(u)}`;
const kAuthToken = (h) => `auth:token:${h}`;
const kCaseExcl = (u) => `casesim:excl:${usernameKey(u)}`;
const kCaseReq = (u, r) => `casesim:req:${usernameKey(u)}:${r}`;
const kLB = () => 'leaderboard:global';

function parseMaybeJSON(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.startsWith('{') || t.startsWith('[')) { try { return JSON.parse(t); } catch { return null; } }
  return null;
}

async function getUserScore(username) {
  const h = await redis.hgetall(kUser(username));
  const score = Number(h?.score || 0), answered = Number(h?.answered || 0), correct = Number(h?.correct || 0);
  return { score, answered, correct, accuracy: answered ? correct / answered : 0 };
}

async function applyScoreDelta(username, delta, wasCorrect) {
  await redis.hincrby(kUser(username), 'answered', 1);
  if (wasCorrect) await redis.hincrby(kUser(username), 'correct', 1);
  let newScore = await redis.hincrby(kUser(username), 'score', delta);
  await redis.zincrby(kLB(), delta, username);
  if (newScore < 0) {
    await redis.hincrby(kUser(username), 'score', -newScore);
    await redis.zincrby(kLB(), -newScore, username);
    newScore = 0;
  }
  return newScore;
}

////////////////////////////////////////////////////////////////////////////////
// AUTH
////////////////////////////////////////////////////////////////////////////////
const normalizeUsernameInput = (u) => String(u || '').trim();
function validateUsername(username) {
  const u = normalizeUsernameInput(username);
  if (!u) return 'username required';
  if (u.length < 3 || u.length > 32) return 'username must be 3-32 characters';
  if (!/^[A-Za-z0-9._-]+$/.test(u)) return 'username can only contain letters, numbers, dot, underscore, and hyphen';
  return '';
}
function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 8) return 'password must be at least 8 characters';
  if (p.length > 256) return 'password is too long';
  return '';
}
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const makeSalt = () => crypto.randomBytes(16).toString('hex');
const hashPassword = (p, salt) => crypto.scryptSync(String(p), salt, 64).toString('hex');
function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(String(expectedHash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

async function userExists(username) { return Boolean(await redis.exists(kUser(username))); }

async function createUser(username, password) {
  const u = normalizeUsernameInput(username);
  const salt = makeSalt();
  await redis.hset(kUser(u), { username: u, created_at: Date.now(), score: 0, answered: 0, correct: 0, password_salt: salt, password_hash: hashPassword(password, salt), auth_version: 1 });
  await redis.set(usernameIndexKey(u), u);
  await redis.zadd(kLB(), { score: 0, member: u });
}

async function createAuthToken(username) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttl = Number(process.env.AUTH_SESSION_TTL_SECONDS || 60 * 60 * 24 * 30);
  await redis.set(kAuthToken(hashToken(token)), JSON.stringify({ username, created_at: Date.now() }), { ex: ttl });
  return token;
}

async function readAuthFromReq(req) {
  const m = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  const parsed = parseMaybeJSON(await redis.get(kAuthToken(hashToken(token))));
  if (!parsed?.username) return null;
  const user = await redis.hgetall(kUser(parsed.username));
  if (!user || !Object.keys(user).length) return null;
  return { username: parsed.username, token, user };
}

const PUBLIC_ROUTES = [
  ['GET', /^\/api\/leaderboard/],
  ['GET', /^\/med\/(toc|disciplines|subdisciplines|topics-for-sub)\b/]
];
async function requireAuth(req, res, next) {
  try {
    if (PUBLIC_ROUTES.some(([m, re]) => req.method === m && re.test(req.originalUrl))) return next();
    if (process.env.DISABLE_AUTH === '1') { req.auth = { username: 'dev' }; return next(); }
    const auth = await readAuthFromReq(req);
    if (!auth) return res.status(401).json({ error: 'Login required' });
    req.auth = auth;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Login required' });
  }
}

async function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (secret && safeEqual(req.headers['x-admin-secret'], secret)) return next();
  const admins = String(process.env.ADMIN_USERS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (admins.length) {
    const auth = await readAuthFromReq(req).catch(() => null);
    if (auth && admins.includes(auth.username)) { req.auth = auth; return next(); }
  }
  res.status(403).json({ error: 'forbidden' });
}

// Login throttling: 10 failed attempts per username+IP per 15 minutes.
const loginFailures = new Map();
function tooManyFailures(key) {
  const rec = loginFailures.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > 15 * 60 * 1000) { loginFailures.delete(key); return false; }
  return rec.count >= 10;
}
function noteFailure(key) {
  const rec = loginFailures.get(key);
  if (!rec || Date.now() - rec.first > 15 * 60 * 1000) loginFailures.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
}

// --- Username moderation -------------------------------------------------------
async function isUsernameAllowedAI(username) {
  if (process.env.MOCK_AI === '1' || !process.env.OPENAI_API_KEY) return true;
  try {
    const resp = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'omni-moderation-latest', input: username })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || resp.statusText);
    const r = Array.isArray(data.results) ? data.results[0] : data;
    const c = r.categories || {}, s = r.category_scores || {};
    const blocked = r.flagged === true || c.hate === true || c['hate/threatening'] === true || c['sexual/minors'] === true ||
      (s.hate || 0) > 0.5 || (s['sexual/minors'] || 0) > 0.2;
    return !blocked;
  } catch (e) {
    console.error('Moderation check failed:', e?.message || e);
    return true;
  }
}

////////////////////////////////////////////////////////////////////////////////
// HEALTH + AUTH ROUTES
////////////////////////////////////////////////////////////////////////////////
app.get('/health', async (_req, res) => {
  try {
    await redis.ping();
    if (hasPg()) await q('SELECT 1');
    res.json({ ok: true, storage: hasPg() ? 'postgres+redis' : 'redis+sqlite', engine: ENGINE_VERSION });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post('/auth/signup', async (req, res) => {
  try {
    const { username, password, repeatPassword } = req.body || {};
    const u = normalizeUsernameInput(username);
    const userErr = validateUsername(u);
    if (userErr) return res.status(400).json({ error: userErr });
    const passErr = validatePassword(password);
    if (passErr) return res.status(400).json({ error: passErr });
    if (String(password) !== String(repeatPassword || '')) return res.status(400).json({ error: 'passwords do not match' });
    if (!(await isUsernameAllowedAI(u))) return res.status(400).json({ error: 'That username is not allowed. Please choose something else.' });
    const indexed = await redis.get(usernameIndexKey(u));
    const existing = await redis.hgetall(kUser(u));
    if (indexed && String(indexed) !== u) return res.status(409).json({ error: 'Username taken' });
    if (existing && Object.keys(existing).length) {
      // Old accounts created before passwords existed can only be claimed when
      // explicitly allowed; otherwise anyone could take over their progress.
      if (existing.password_hash || process.env.ALLOW_LEGACY_CLAIM !== '1') return res.status(409).json({ error: 'Username taken' });
      const salt = makeSalt();
      await redis.hset(kUser(u), { username: u, password_salt: salt, password_hash: hashPassword(password, salt), auth_version: 1, legacy_no_password: 0 });
      await redis.set(usernameIndexKey(u), u);
    } else {
      await createUser(u, String(password));
    }
    res.json({ ok: true, token: await createAuthToken(u), username: u });
  } catch (e) {
    console.error('[auth] signup failed:', e?.message || e);
    res.status(500).json({ error: 'Signup failed. The server could not reach its database; try again shortly.' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const u = normalizeUsernameInput(username);
    if (!u || !password) return res.status(400).json({ error: 'username and password required' });
    const throttleKey = `${req.ip}|${u.toLowerCase()}`;
    if (tooManyFailures(throttleKey)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    const actual = String((await redis.get(usernameIndexKey(u))) || u);
    const user = await redis.hgetall(kUser(actual));
    if (!user || !Object.keys(user).length || !verifyPassword(String(password), user.password_salt, user.password_hash)) {
      noteFailure(throttleKey);
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    loginFailures.delete(throttleKey);
    res.json({ ok: true, token: await createAuthToken(actual), username: actual });
  } catch (e) {
    console.error('[auth] login failed:', e?.message || e);
    res.status(500).json({ error: 'Login failed. The server could not reach its database; try again shortly.' });
  }
});

app.get('/auth/me', async (req, res) => {
  const auth = await readAuthFromReq(req).catch(() => null);
  if (!auth) return res.status(401).json({ error: 'Login required' });
  res.json({ ok: true, username: auth.username, stats: await getUserScore(auth.username) });
});

app.post('/auth/logout', async (req, res) => {
  try { const auth = await readAuthFromReq(req); if (auth?.token) await redis.del(kAuthToken(hashToken(auth.token))); } catch {}
  res.json({ ok: true });
});

app.get('/auth/check-username', async (req, res) => {
  const u = normalizeUsernameInput(req.query.username);
  const err = validateUsername(u);
  if (err) return res.json({ available: false, reason: err });
  const exists = Boolean(await redis.get(usernameIndexKey(u))) || await userExists(u);
  res.json({ available: !exists, reason: exists ? 'Username taken' : '' });
});

app.use(['/api', '/case', '/med', '/textbook/api'], requireAuth);

////////////////////////////////////////////////////////////////////////////////
// ONE LINE PIMP + MCCQE
////////////////////////////////////////////////////////////////////////////////
const MOCK = () => process.env.MOCK_AI === '1';
const normQ = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const wordSet = (s) => new Set((String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []));
function similarity(a, b) {
  const A = wordSet(a), B = wordSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}
const parseChoiceLetter = (v) => (String(v || '').trim().toUpperCase().match(/^[A-E]/) || [''])[0];

function publicQuestionPayload(item) {
  return {
    q_number: item.q_number, question: item.question, stem: item.question,
    difficulty: item.final_difficulty || item.starting_difficulty,
    type: item.type || 'short_answer', mode: item.mode || 'pimp',
    options: Array.isArray(item.options) ? item.options : [], topic: item.topic || 'random',
    asked_at: item.asked_at
  };
}

function normalizeGeneratedQuestion(p, mode) {
  p = p && typeof p === 'object' ? p : {};
  const question = String(p.question || p.stem || '').trim();
  if (!question) throw new Error('Bad question JSON: missing question');
  const options = Array.isArray(p.options) ? p.options.map(x => String(x).trim()).filter(Boolean) : [];
  return {
    type: mode === 'mccqe' ? 'mcq' : 'short_answer',
    question,
    expectedAnswer: String(p.expectedAnswer || p.answer || '').trim(),
    answerKey: parseChoiceLetter(p.answerKey || p.correctChoice),
    options,
    explanation: String(p.explanation || '').trim(),
    skill: String(p.skill || '').trim(),
    concept: String(p.concept || '').trim().slice(0, 140)
  };
}

function validateMcq(item) {
  if (item.options.length !== 5) return `expected 5 options, got ${item.options.length}`;
  if (!item.answerKey) return 'missing answer key';
  const letters = item.options.map((o, i) => parseChoiceLetter(o) || 'ABCDE'[i]);
  if (new Set(letters).size !== 5 || !letters.includes(item.answerKey)) return 'answer key does not match options';
  const bodies = item.options.map(o => normQ(o.replace(/^[A-E]\s*[.):-]\s*/i, '')));
  if (new Set(bodies).size !== 5) return 'duplicate options';
  return '';
}

async function aiGenerateQuestion({ topic, difficulty, avoidQuestions, avoidConcepts, mode, askedCount, userId }) {
  if (MOCK()) {
    const n = askedCount + Math.floor(Math.random() * 1e6);
    if (mode === 'mccqe') return { type: 'mcq', question: `(${n}) A 67-year-old with inferior STEMI, BP 84/52 and elevated JVP. Which medication should be avoided?`, options: ['A. Aspirin', 'B. Nitroglycerin', 'C. Heparin', 'D. Ticagrelor', 'E. Atorvastatin'], answerKey: 'B', expectedAnswer: 'Nitroglycerin', explanation: 'RV infarct is preload dependent.', skill: 'hemodynamics', concept: `rv infarct nitrates ${n}` };
    return { type: 'short_answer', question: `(${n}) pH 7.25, PaCO2 25 mmHg, HCO3 11 mmol/L, Na 140, Cl 100. Acid-base disorder?`, expectedAnswer: 'High anion gap metabolic acidosis with appropriate respiratory compensation', explanation: 'AG 29; Winter expected PaCO2 ~24.5.', skill: 'labs', concept: `hagma winter ${n}` };
  }
  const styleCycle = ['clinical_reasoning', 'labs_interpretation', 'next_test', 'management_decision', 'clinical_reasoning', 'labs_interpretation', 'management_decision', 'fact_microdose'];
  const preferredStyle = styleCycle[Math.max(0, Number(askedCount || 0)) % styleCycle.length];
  const conceptRule = `Include "concept": a short canonical label for the single learning point tested (e.g. "DKA: anion gap closure before stopping insulin"). It must not match any avoid_concepts entry, even reworded.`;
  const system = mode === 'mccqe'
    ? `You are the question engine for an MCCQE Part I practice mode.
Return JSON: {"type":"mcq","question":"single-best-answer clinical vignette","options":["A. ...","B. ...","C. ...","D. ...","E. ..."],"answerKey":"A-E","expectedAnswer":"short answer","explanation":"high-yield explanation","skill":"tested skill","concept":""}
Rules:
- Hardest 10% of MCCQE-style clinical reasoning; Canadian framing and SI units.
- Exactly five plausible options; exactly one defensible best answer.
- Prioritize diagnosis, next best test, initial management, risk stratification, ethics/communication, stabilization, and interpretation of labs/ECG/imaging descriptions. Avoid trivia-only stems.
- ${conceptRule}`
    : `You are the question engine for One Line Pimp Simulator.
Return JSON: {"type":"short_answer","question":"...","expectedAnswer":"...","explanation":"...","skill":"...","concept":""}
Rules:
- The answer is one word, one phrase, or one short sentence.
- Most questions must be clinical application: short vignettes, lab or acid-base interpretation, ECG/imaging descriptions, next test, next management step, or mechanism applied to a case. Isolated gene/eponym recall only occasionally.
- Preferred style for this request: ${preferredStyle}.
- Difficulty must match ${normalizeDifficulty(difficulty)} (Easy..Brutal). Brutal must still be fair and coherent.
- No physiologically contradictory or internally inconsistent stems. Canadian/SI units.
- ${conceptRule}`;
  const payload = { topic: topic || 'random', difficulty: normalizeDifficulty(difficulty), avoid_questions: avoidQuestions.slice(-120), avoid_concepts: avoidConcepts.slice(-200) };
  const parsed = await aiJSON({ tag: mode === 'mccqe' ? 'pimp.generate.mcq' : 'pimp.generate', meta: { userId }, system, payload, model: PIMP_GENERATOR_MODEL, temperature: mode === 'mccqe' ? 0.45 : 0.7, max_output_tokens: mode === 'mccqe' ? 3000 : 2000, reasoning_effort: 'low' });
  return parsed;
}

async function aiGradeAnswer({ question, userAnswer, difficulty, expectedAnswer = '', explanation = '', userId }) {
  if (MOCK()) {
    const ans = String(userAnswer || '').toLowerCase(), gold = String(expectedAnswer || '').toLowerCase();
    const credit = gold && ans && (gold.includes(ans) || ans.includes(gold.split(' ')[0])) ? 1 : 0;
    return { verdict: credit ? 'correct' : 'incorrect', credit, is_correct: !!credit, explanation: explanation || `Expected: ${expectedAnswer}.`, difficulty_delta: credit ? 1 : -1, invalid_question: false };
  }
  const system = `You are a strict but fair medical answer grader for a one-line clinical simulator.
Return JSON: {"verdict":"correct|partial|incorrect|invalid","credit":0.0,"explanation":"1-3 concise sentences","difficulty_delta":-1|0|1,"invalid_question":false}
- Continuous credit 0-1. Use the expected answer as the key but accept clinically equivalent wording.
- 1 = core answer correct; 0.60-0.85 very close but missing an important qualifier; 0.30-0.59 materially incomplete; 0.05-0.29 small relevant fragment; 0 wrong, unrelated or unsafe.
- If the learner validly challenges a flawed stem, mark correct or partial by quality.
- If the stem is ambiguous, impossible, internally inconsistent, or built on a false premise: verdict "invalid", invalid_question true, credit 0, difficulty_delta 0, and explain the corrected concept.`;
  try {
    const parsed = await aiJSON({ tag: 'pimp.grade', meta: { userId }, system, payload: { question, expectedAnswer, storedExplanation: explanation, userAnswer, difficulty: normalizeDifficulty(difficulty) }, model: PIMP_GRADER_MODEL, max_output_tokens: 500, reasoning_effort: 'low' });
    const invalid_question = !!parsed.invalid_question || parsed.verdict === 'invalid';
    let credit = Number(parsed.credit);
    if (!Number.isFinite(credit)) credit = invalid_question ? 0 : 0;
    credit = clamp(credit, 0, 1);
    const verdict = invalid_question ? 'invalid' : credit >= 0.85 ? 'correct' : credit > 0 ? 'partial' : 'incorrect';
    let delta = Number(parsed.difficulty_delta);
    if (![-1, 0, 1].includes(delta)) delta = invalid_question ? 0 : credit >= 0.85 ? 1 : credit >= 0.35 ? 0 : -1;
    return { verdict, credit, is_correct: verdict === 'correct', explanation: String(parsed.explanation || explanation || `Expected: ${expectedAnswer}.`).trim(), difficulty_delta: delta, invalid_question };
  } catch (e) {
    // Grader failure must not penalise the learner.
    return { verdict: 'ungraded', credit: 0, is_correct: false, explanation: 'The grader was unavailable, so this answer was not scored. Try again or move on.', difficulty_delta: 0, invalid_question: false, grader_error: true };
  }
}

async function aiDiscussAnswer({ question, userAnswer, grading, dialogue, message, userId }) {
  if (MOCK()) return 'That is a fair challenge. If the stem is internally inconsistent, it should be treated as a flawed question.';
  const system = `You are a rigorous but helpful clinical educator inside a pimp-question simulator.
The learner may challenge the explanation, ask why partial credit was assigned, or request a mechanism. Respond directly and honestly.
If the original grading, credit, or explanation was wrong, say so plainly and give the corrected reasoning. When discussing partial credit, say what was right, what was missing, and what would earn full credit. Be concise and high-yield. Canadian context and SI units.`;
  const resp = await responsesCall({ tag: 'pimp.discuss', meta: { userId }, model: PIMP_DISCUSSION_MODEL, max_output_tokens: 700, reasoning_effort: 'low', messages: [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ question, userAnswer, grading, priorDialogue: ensureArray(dialogue).slice(-8), learnerMessage: message }) }
  ] });
  return extractCanadianText(resp) || 'I could not generate a clarification.';
}

async function aiSummarizeSession({ transcript, startDifficulty, userId }) {
  if (MOCK()) return { feedback: 'Mock session feedback.', rating: normalizeDifficulty(startDifficulty) };
  const system = `Summarize this practice session: strengths and weaknesses with specific examples, then a rating of the level the learner performed at.
Return JSON: {"feedback":"","rating":"Easy|Medium|Hard|Expert|Brutal"}`;
  try {
    const parsed = await aiJSON({ tag: 'pimp.summary', meta: { userId }, system, payload: {
      startDifficulty: normalizeDifficulty(startDifficulty),
      items: transcript.map(t => ({ question: t.question, userAnswer: t.user_answer ?? '', verdict: t.verdict, credit: Number(t.credit || 0), explanation: t.explanation ?? '' }))
    }, model: PIMP_DISCUSSION_MODEL, max_output_tokens: 1000, reasoning_effort: 'low' });
    return { feedback: String(parsed.feedback || 'Session saved.'), rating: normalizeDifficulty(parsed.rating) };
  } catch {
    return { feedback: 'Session saved. Feedback could not be generated this time.', rating: normalizeDifficulty(startDifficulty) };
  }
}

// Session storage helpers
async function getSessionMeta(id) {
  const d = await redis.hgetall(kSess(id));
  if (!d || !Object.keys(d).length) return null;
  if (d.start_diff) d.start_diff = normalizeDifficulty(d.start_diff);
  return d;
}
async function getSessionItems(id) {
  const raw = await redis.lrange(kSessItems(id), 0, -1);
  return (raw || []).map(parseMaybeJSON).filter(Boolean);
}
async function updateLastSessionItem(id, patch) {
  const len = await redis.llen(kSessItems(id));
  if (!len) return;
  const last = parseMaybeJSON(await redis.lindex(kSessItems(id), len - 1));
  if (!last) return;
  await redis.lset(kSessItems(id), len - 1, JSON.stringify({ ...last, ...patch }));
}
async function loadOwnedPimpSession(req, res, sessionId) {
  if (!sessionId) { res.status(400).json({ error: 'sessionId required' }); return null; }
  const meta = await getSessionMeta(String(sessionId));
  if (!meta) { res.status(404).json({ error: 'Session not found' }); return null; }
  if (meta.username !== req.auth.username) { res.status(403).json({ error: 'Cannot access another user session' }); return null; }
  return meta;
}
const requestedUser = (req) => req.auth.username;

app.post('/api/users', (_req, res) => res.status(410).json({ error: 'Use /auth/signup to create accounts.' }));

app.get('/api/exclusions/count', async (req, res) => {
  res.json({ count: await redis.llen(kExcl(requestedUser(req))) });
});
app.get('/api/exclusions', async (req, res) => {
  res.json({ questions: await redis.lrange(kExcl(requestedUser(req)), 0, -1) });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { topic, startingDifficulty, mode } = req.body || {};
    const id = uuid();
    const cleanMode = mode === 'mccqe' ? 'mccqe' : 'pimp';
    const cleanDifficulty = normalizeDifficulty(startingDifficulty || 'Hard');
    await redis.hset(kSess(id), { username: req.auth.username, topic: String(topic || 'random').slice(0, 120), start_diff: cleanDifficulty, mode: cleanMode, created_at: Date.now() });
    res.json({ sessionId: id, topic: topic || 'random', difficulty: cleanDifficulty, mode: cleanMode });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Resume support: returns the current state of a session, including an
// unanswered question if there is one.
app.get('/api/sessions/:id', async (req, res) => {
  const meta = await loadOwnedPimpSession(req, res, req.params.id);
  if (!meta) return;
  const items = await getSessionItems(req.params.id);
  const last = items[items.length - 1];
  const pending = last && !Object.prototype.hasOwnProperty.call(last, 'user_answer') ? publicQuestionPayload(last) : null;
  res.json({ sessionId: req.params.id, mode: meta.mode, topic: meta.topic, difficulty: last?.final_difficulty || meta.start_diff, concluded: !!meta.concluded_at, answered: items.filter(i => 'user_answer' in i).length, pending });
});

app.post('/api/next', async (req, res) => {
  const { sessionId } = req.body || {};
  const meta = await loadOwnedPimpSession(req, res, sessionId);
  if (!meta) return;
  if (meta.concluded_at) return res.status(400).json({ error: 'Session already concluded' });
  await withLock(`pimp:${sessionId}`, async () => {
    try {
      const username = meta.username;
      const items = await getSessionItems(sessionId);
      const last = items[items.length - 1];
      // An unanswered question is returned again instead of being skipped.
      if (last && !Object.prototype.hasOwnProperty.call(last, 'user_answer')) return res.json({ ...publicQuestionPayload(last), resumed: true });

      const topic = meta.topic || 'random';
      const mode = meta.mode === 'mccqe' ? 'mccqe' : 'pimp';
      const difficulty = items.length ? normalizeDifficulty(last.final_difficulty) : normalizeDifficulty(meta.start_diff);
      const excl = await redis.lrange(kExcl(username), -400, -1);
      const concepts = (await redis.lrange(kConcepts(username), -300, -1)).map(String);
      const avoidQuestions = [...excl.map(String), ...items.map(i => i.question)].filter(Boolean);
      const avoidConcepts = [...concepts, ...items.map(i => i.concept)].filter(Boolean);
      const qSet = new Set(avoidQuestions.map(normQ));
      const cSet = new Set(avoidConcepts.map(normQ));
      const recentForSim = avoidQuestions.slice(-300);

      let item = null, lastProblem = '';
      for (let attempt = 0; attempt < 3 && !item; attempt++) {
        let candidate;
        try { candidate = normalizeGeneratedQuestion(await aiGenerateQuestion({ topic, difficulty, avoidQuestions, avoidConcepts, mode, askedCount: items.length + attempt, userId: username }), mode); }
        catch (e) { lastProblem = String(e?.message || e); continue; }
        if (mode === 'mccqe') { const p = validateMcq(candidate); if (p) { lastProblem = p; continue; } }
        if (qSet.has(normQ(candidate.question))) { lastProblem = 'exact duplicate'; continue; }
        if (candidate.concept && cSet.has(normQ(candidate.concept))) { lastProblem = 'repeated concept'; avoidConcepts.push(candidate.concept); continue; }
        if (recentForSim.some(prev => similarity(prev, candidate.question) > 0.72)) { lastProblem = 'near-duplicate wording'; avoidQuestions.push(candidate.question); continue; }
        item = candidate;
      }
      if (!item) return res.status(503).json({ error: 'Could not generate a new, non-repeated question. Please try again.', detail: lastProblem });

      const baseCount = await redis.llen(kExcl(username));
      const record = { ...item, mode, topic, starting_difficulty: difficulty, final_difficulty: difficulty, asked_index_in_session: items.length + 1, q_number: baseCount + items.length + 1, asked_at: Date.now() };
      await redis.rpush(kSessItems(sessionId), JSON.stringify(record));
      res.json(publicQuestionPayload(record));
    } catch (e) {
      res.status(500).json({ error: 'Failed to get next question', detail: String(e?.message || e) });
    }
  });
});

app.post('/api/answer', async (req, res) => {
  const { sessionId, answer } = req.body || {};
  if (typeof answer !== 'string' || !answer.trim()) return res.status(400).json({ error: 'answer required' });
  const meta = await loadOwnedPimpSession(req, res, sessionId);
  if (!meta) return;
  await withLock(`pimp:${sessionId}`, async () => {
    try {
      const username = meta.username;
      const items = await getSessionItems(sessionId);
      const last = items[items.length - 1];
      if (!last) return res.status(400).json({ error: 'No question to grade' });
      // Repeated submission: return the stored grade instead of scoring twice.
      if (Object.prototype.hasOwnProperty.call(last, 'user_answer')) return res.json({ ...(last.result || {}), duplicate: true });

      // Server-authoritative timing; small allowance for network/render latency.
      const elapsedMs = Math.max(0, Date.now() - Number(last.asked_at || Date.now()) - 1500);
      let graded;
      if (last.type === 'mcq') {
        const chosen = parseChoiceLetter(answer), key = parseChoiceLetter(last.answerKey);
        const ok = !!chosen && chosen === key;
        graded = { verdict: ok ? 'correct' : 'incorrect', credit: ok ? 1 : 0, is_correct: ok, explanation: last.explanation || `Correct answer: ${key}.`, difficulty_delta: ok ? 1 : -1, invalid_question: false, correctChoice: key, expectedAnswer: last.expectedAnswer || '' };
      } else {
        graded = await aiGradeAnswer({ question: last.question, expectedAnswer: last.expectedAnswer || '', explanation: last.explanation || '', userAnswer: answer, difficulty: last.final_difficulty, userId: username });
      }
      if (graded.grader_error) return res.status(503).json({ error: graded.explanation });

      const { verdict, credit, is_correct, explanation, difficulty_delta, invalid_question } = graded;
      const nextDiff = bumpDifficulty(last.final_difficulty, difficulty_delta);
      const { correct: max_points, wrong: penalty_points } = pointsFor(last.final_difficulty);
      const time_multiplier = timeMultiplierForAnswer(elapsedMs, last.final_difficulty);
      let points_delta = 0;
      if (invalid_question) points_delta = 0;
      else if (verdict === 'correct') points_delta = Math.round(max_points * time_multiplier);
      else if (verdict === 'partial') points_delta = Math.round(max_points * credit * time_multiplier);
      else points_delta = -penalty_points;

      const score_after = await applyScoreDelta(username, points_delta, is_correct);
      const result = {
        correct: is_correct, verdict, credit, explanation, invalid_question, nextDifficulty: nextDiff, points_delta, max_points, penalty_points,
        time_multiplier, elapsed_ms: Math.round(elapsedMs), elapsed_seconds: Math.round(elapsedMs / 1000), score: score_after,
        correctChoice: graded.correctChoice || undefined, expectedAnswer: graded.expectedAnswer || last.expectedAnswer || undefined
      };
      await updateLastSessionItem(sessionId, { user_answer: answer, is_correct, verdict, credit, explanation, invalid_question, final_difficulty: nextDiff, points_delta, time_multiplier, elapsed_ms: Math.round(elapsedMs), score_after, answered_at: Date.now(), dialogue: [], result });
      await redis.lpush(kHistory(username), JSON.stringify({
        question: last.question, type: last.type || 'short_answer', options: last.type === 'mcq' ? last.options : undefined, correct_choice: graded.correctChoice,
        difficulty: normalizeDifficulty(last.final_difficulty), user_answer: answer, expected_answer: last.expectedAnswer || '', is_correct, verdict, credit, explanation,
        invalid_question, points_delta, max_points, penalty_points, time_multiplier, elapsed_ms: Math.round(elapsedMs), score_after, asked_at: last.asked_at, answered_at: Date.now(), concept: last.concept || ''
      }));
      await redis.ltrim(kHistory(username), 0, 999);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: 'Failed to grade answer', detail: String(e?.message || e) });
    }
  });
});

app.post('/api/discuss', async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  const meta = await loadOwnedPimpSession(req, res, sessionId);
  if (!meta) return;
  try {
    const items = await getSessionItems(sessionId);
    const last = items[items.length - 1];
    if (!last || !Object.prototype.hasOwnProperty.call(last, 'user_answer')) return res.status(400).json({ error: 'Answer the question before starting discussion' });
    const dialogue = ensureArray(last.dialogue);
    const grading = { verdict: last.verdict, credit: Number(last.credit || 0), explanation: last.explanation || '', invalid_question: !!last.invalid_question, expectedAnswer: last.expectedAnswer, points_delta: Number(last.points_delta || 0) };
    const reply = await aiDiscussAnswer({ question: last.question, userAnswer: last.user_answer || '', grading, dialogue, message: message.slice(0, 2000), userId: meta.username });
    await updateLastSessionItem(sessionId, { dialogue: [...dialogue, { role: 'user', content: message, at: Date.now() }, { role: 'assistant', content: reply, at: Date.now() }] });
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(500).json({ error: 'Discussion failed' });
  }
});

app.post('/api/conclude', async (req, res) => {
  const { sessionId } = req.body || {};
  const meta = await loadOwnedPimpSession(req, res, sessionId);
  if (!meta) return;
  await withLock(`pimp:${sessionId}`, async () => {
    try {
      const username = meta.username;
      const fresh = await getSessionMeta(sessionId);
      if (fresh?.concluded_at && fresh.summary) return res.json({ ...parseMaybeJSON(fresh.summary), duplicate: true });
      const items = await getSessionItems(sessionId);
      const answered = items.filter(it => it?.question && Object.prototype.hasOwnProperty.call(it, 'user_answer'));
      const existing = new Set((await redis.lrange(kExcl(username), 0, -1)).map(normQ));
      // Only answered questions become exclusions; an unanswered one can be seen again.
      const toAdd = [];
      for (const it of answered) { const n = normQ(it.question); if (n && !existing.has(n)) { existing.add(n); toAdd.push(it.question); } }
      if (toAdd.length) await redis.rpush(kExcl(username), ...toAdd);
      const concepts = answered.map(i => i.concept).filter(Boolean);
      if (concepts.length) { await redis.rpush(kConcepts(username), ...concepts); await redis.ltrim(kConcepts(username), -2000, -1); }
      const session_points = answered.reduce((s, it) => s + Number(it.points_delta || 0), 0);
      let feedback = 'No answered questions yet.', rating = meta.start_diff || 'Hard';
      if (answered.length) ({ feedback, rating } = await aiSummarizeSession({ transcript: answered, startDifficulty: meta.start_diff, userId: username }));
      const new_count = await redis.llen(kExcl(username));
      const summary = { ok: true, added: toAdd.length, new_count, next_number: new_count + 1, session_points, answered: answered.length, feedback, rating };
      await redis.hset(kSess(sessionId), { concluded_at: Date.now(), rating, summary: JSON.stringify(summary) });
      res.json(summary);
    } catch (e) {
      res.status(500).json({ error: 'Failed to conclude session' });
    }
  });
});

app.get('/api/score', async (req, res) => res.json(await getUserScore(requestedUser(req))));

app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = clamp(Number(req.query.limit || 10), 1, 100);
    const raw = await redis.zrange(kLB(), 0, limit - 1, { rev: true, withScores: true });
    const pairs = [];
    if (Array.isArray(raw) && raw.length) {
      if (typeof raw[0] === 'object' && raw[0] !== null) raw.forEach(r => pairs.push([String(r.member ?? ''), Number(r.score ?? 0)]));
      else for (let i = 0; i < raw.length; i += 2) pairs.push([String(raw[i] ?? ''), Number(raw[i + 1] ?? 0)]);
    }
    const board = [];
    for (const [m, s] of pairs.filter(([m]) => m.trim())) {
      const h = await redis.hgetall(kUser(m));
      board.push({ rank: board.length + 1, username: m, score: Number.isFinite(s) ? s : 0, answered: Number(h?.answered || 0) });
    }
    res.json({ leaderboard: board, rows: board });
  } catch (e) {
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

app.get('/api/history', async (req, res) => {
  const limit = clamp(Number(req.query.limit || 200), 1, 1000);
  const rows = await redis.lrange(kHistory(requestedUser(req)), 0, limit - 1);
  res.json({ items: (rows || []).map(r => parseMaybeJSON(r) || { raw: r }) });
});

////////////////////////////////////////////////////////////////////////////////
// MED LEARNER
////////////////////////////////////////////////////////////////////////////////
function tocItemsFromTree(tree) {
  const out = [];
  for (const [discipline, subs] of Object.entries(tree)) for (const [sub, topics] of Object.entries(subs)) for (const topic of topics) out.push({ discipline, sub, topic });
  return out;
}
const normalizeTopicName = (s = '') => String(s).toLowerCase()
  .replace(/^(approach\s*to|evaluation\s*of|diagnosis\s*of|management\s*of|treatment\s*of|overview\s*of)\s+/i, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();

app.get('/med/toc', (_req, res) => {
  const items = tocItemsFromTree(HARDCODED_TOC);
  res.json({ ok: true, label: 'HARDCODED_TOC_V1', items, counts: { disciplines: Object.keys(HARDCODED_TOC).length, topics: items.length } });
});
app.get('/med/disciplines', (_req, res) => res.json({ disciplines: Object.keys(HARDCODED_TOC) }));
app.get('/med/subdisciplines', (req, res) => { const d = String(req.query.discipline || ''); res.json({ discipline: d, subs: HARDCODED_TOC[d] ? Object.keys(HARDCODED_TOC[d]) : [] }); });
app.get('/med/topics-for-sub', (req, res) => { const d = String(req.query.discipline || ''), s = String(req.query.sub || ''); res.json({ discipline: d, sub: s, topics: HARDCODED_TOC[d]?.[s] || [] }); });

app.get('/med/topics', async (req, res) => {
  try { res.json({ topics: await learnerStore.completedTopics(req.auth.username) }); }
  catch (e) { res.status(500).json({ error: 'Failed to load topics' }); }
});
app.post('/med/topics', async (req, res) => {
  const topic = String(req.body?.topic || '').trim().slice(0, 200);
  if (!topic) return res.status(400).json({ error: 'topic required' });
  try { await learnerStore.markCompleted(req.auth.username, topic); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Failed to save topic' }); }
});
app.delete('/med/topics', async (req, res) => {
  const topic = String(req.body?.topic || req.query.topic || '').trim();
  if (!topic) return res.status(400).json({ error: 'topic required' });
  try { await learnerStore.unmarkCompleted(req.auth.username, topic); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'Failed to update topic' }); }
});

app.post('/med/high-yield-im', async (req, res) => {
  try {
    const n = clamp(Number(req.body?.n || 1), 1, 10);
    const IM = new Set(['Cardiology', 'Endocrinology', 'Gastroenterology', 'Hematology', 'Infectious Disease', 'Nephrology', 'Neurology', 'Respirology', 'Rheumatology']);
    const completedNorm = new Set((await learnerStore.completedTopics(req.auth.username)).map(normalizeTopicName));
    const eligible = [...new Set(tocItemsFromTree(HARDCODED_TOC).filter(i => IM.has(i.discipline)).map(i => i.topic))].filter(t => !completedNorm.has(normalizeTopicName(t)));
    if (!eligible.length) return res.json({ ok: true, ranked: [], pick: null, reason: 'All topics completed.' });
    let ranked = [];
    if (!MOCK()) {
      try {
        const out = await aiJSON({ tag: 'learner.highYield', meta: { userId: req.auth.username }, system: `You are a clerkship director selecting HIGH-YIELD Internal Medicine study topics for a Canadian clerk. From the provided list ONLY, rank the most high-yield topics. Prefer common inpatient problems, emergencies, and algorithm-heavy entities. Return {"ranked":[{"topic":"","reason":""}]}.`, payload: { topics: eligible, max: Math.min(20, eligible.length) }, model: BASE_MODEL, max_output_tokens: 1500 });
        const ok = new Set(eligible);
        ranked = ensureArray(out.ranked).filter(x => x?.topic && ok.has(x.topic));
      } catch {}
    }
    if (!ranked.length) ranked = [{ topic: eligible[Math.floor(Math.random() * eligible.length)], reason: 'Random pick from remaining topics.' }];
    res.json({ ok: true, ranked: ranked.slice(0, n), pick: ranked[0] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to pick topic' });
  }
});

async function buildPimpQuestionsAI(topic, noteSnippets, n, userId) {
  if (MOCK()) return Array.from({ length: n }, (_, i) => ({ q: `${topic}: mock question ${i + 1}?`, answer: 'Mock answer', explain: 'Mock explanation.' }));
  const out = await aiJSON({ tag: 'learner.testQuestions', meta: { userId }, system: `You are a senior Internal Medicine attending running ward rounds for a Canadian clerk. Write ${n} short, clinically applied questions on the topic, progressing from hard to brutal. Emphasize diagnosis, next test, management, risk stratification, complications, monitoring and contraindications. Canadian guidelines and SI units.
Return {"questions":[{"q":"","answer":"concise expected answer","explain":"one-paragraph explanation"}]}`, payload: { topic, note_snippets: noteSnippets.slice(0, 12) }, model: PIMP_MODEL, max_output_tokens: 3500 });
  return ensureArray(out.questions).map(x => ({ q: String(x.q || '').trim(), answer: String(x.answer || '').trim(), explain: String(x.explain || '').trim() })).filter(x => x.q && x.answer).slice(0, n);
}

async function searchNoteSnippets(topic, k = 8) {
  try { return (await learnerStore.search(topic, k)).map(r => r.text); } catch { return []; }
}

async function testQuestionsHandler(req, res) {
  try {
    const topic = String(req.body?.topic || req.query?.topic || '').trim();
    const n = clamp(Number(req.body?.n || req.query?.n || 10), 4, 20);
    if (!topic) return res.status(400).json({ error: 'topic required' });
    const questions = await buildPimpQuestionsAI(topic, await searchNoteSnippets(topic, 12), n, req.auth.username);
    if (!questions.length) return res.status(502).json({ error: 'failed to generate questions' });
    res.json({ ok: true, topic, count: questions.length, questions });
  } catch (e) {
    res.status(500).json({ error: 'Failed to generate questions' });
  }
}
app.post('/med/test-questions', testQuestionsHandler);
app.get('/med/test-questions', testQuestionsHandler);

async function urlOk(url, timeoutMs = 7000) {
  if (!url || typeof url !== 'string' || !/^https:\/\//i.test(url)) return false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctrl.signal });
    if (!r.ok) r = await fetch(url, { method: 'GET', redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

async function buildLearnPlanAI(topic, noteSnippets, userId) {
  if (MOCK()) return { guidelines: [{ region: 'Canada', org: 'Mock', year: 2024, title: `${topic} guideline`, why: 'Mock', link: '' }], trials: [], objectives: [{ objective: `Recognise ${topic}`, rationale: 'Mock', resources: [] }] };
  const system = `You are an evidence-based Internal Medicine educator. Create a learning plan with "guidelines", "trials", "objectives".
Return {"guidelines":[{"region":"Canada|USA|International","org":"","year":2020,"title":"","why":"","link":""}],
"trials":[{"name":"","year":1999,"question":"","design":"","n":"","result":"","impact":"","one_liner":"","link":""}],
"objectives":[{"objective":"","rationale":"","resources":[{"type":"guideline|trial|other","ref":"","title":"","link":""}]}]}
- Prefer Canadian guidelines first, then USA, then international. Up to 8 guidelines.
- Trials must be landmark/seminal (include influential negative trials). Up to 10.
- 8-14 objectives covering pathophysiology, diagnosis, risk stratification, ED/inpatient/outpatient management, complications and follow-up; cite matching guideline/trial names in "ref".
- Links must be stable landing pages, DOI or PubMed URLs; leave empty if unsure.`;
  try {
    return await aiJSON({ tag: 'learner.plan', meta: { userId }, system, payload: { topic, note_snippets: noteSnippets }, model: PIMP_DISCUSSION_MODEL, max_output_tokens: 6000, reasoning_effort: 'low',
      validate: (p) => (Array.isArray(p.guidelines) && Array.isArray(p.trials) && Array.isArray(p.objectives) ? '' : 'missing arrays') });
  } catch {
    return { guidelines: [], trials: [], objectives: [] };
  }
}

async function improvePlanLinks(plan, topic) {
  const order = { Canada: 0, USA: 1, International: 2 };
  plan.guidelines.sort((a, b) => (order[a.region] ?? 99) - (order[b.region] ?? 99) || (b.year || 0) - (a.year || 0));
  const checks = [...plan.guidelines, ...plan.trials].map(async (x) => { if (x.link && !(await urlOk(x.link))) x.link = ''; });
  await Promise.all(checks);
  for (const g of plan.guidelines) if (!g.link) g.link = `https://www.google.com/search?q=${encodeURIComponent(`${g.title || topic} ${g.org || ''} guideline`)}`;
  for (const t of plan.trials) if (!t.link) t.link = `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(t.name || topic)}`;
  return plan;
}

async function learnPlanHandler(req, res) {
  try {
    const topic = String(req.body?.topic || req.query?.topic || '').trim();
    if (!topic) return res.status(400).json({ error: 'topic required' });
    const snippets = await searchNoteSnippets(topic, 8);
    const plan = await improvePlanLinks(await buildLearnPlanAI(topic, snippets, req.auth.username), topic);
    res.json({ ok: true, topic, ...plan, snippets_count: snippets.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to build learning plan' });
  }
}
app.post('/med/learn-plan', learnPlanHandler);
app.get('/med/learn-plan', learnPlanHandler);

// --- PDFs ---------------------------------------------------------------------
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });

function chunkText(raw) {
  const text = (raw || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let slice = text.slice(i, Math.min(i + 1200, text.length));
    const stop = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('. '));
    if (stop > 400 && i + 1200 < text.length) slice = slice.slice(0, stop + 1);
    chunks.push(slice.trim());
    i += Math.max(slice.length - 150, 1);
  }
  return chunks.filter(Boolean);
}

async function indexPdfBuffer(buffer, label) {
  const data = await pdfParse(buffer);
  const chunks = chunkText(data.text || '');
  const docId = await learnerStore.insertPdf(label, chunks);
  return { docId, nChunks: chunks.length };
}

function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  if (h.startsWith('[') || h.includes(':')) return true;
  return false;
}

async function fetchPdf(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || isPrivateHost(u.hostname)) throw new Error('Only public https URLs are allowed');
  const r = await fetch(u, { redirect: 'follow' });
  if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
  if (Number(r.headers.get('content-length') || 0) > MAX_PDF_BYTES) throw new Error('PDF too large');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_PDF_BYTES) throw new Error('PDF too large');
  return buf;
}

app.post('/med/pdfs', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const label = String(req.body?.label || req.file.originalname).slice(0, 200);
    const { docId, nChunks } = await indexPdfBuffer(req.file.buffer, label);
    res.json({ ok: true, doc_id: docId, chunks: nChunks, label });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.post('/med/pdfs/by-url', async (req, res) => {
  try {
    const { url, label } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    const buf = await fetchPdf(String(url));
    const { docId, nChunks } = await indexPdfBuffer(buf, String(label || url).slice(0, 200));
    res.json({ ok: true, doc_id: docId, chunks: nChunks, label: label || url });
  } catch (e) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

app.get('/med/pdfs/search', async (req, res) => {
  const qtext = String(req.query.q || '').trim();
  if (!qtext) return res.status(400).json({ error: 'q required' });
  try { res.json({ hits: await learnerStore.search(qtext, Number(req.query.k || 8)) }); }
  catch (e) { res.status(500).json({ error: 'Search failed' }); }
});

const STANDARD_PDF_URL = process.env.STANDARD_PDF_URL || 'https://raw.githubusercontent.com/gurnoorsidhu602-alt/file/7c1f0d025f19f12e2494694197bd38da92f09f49/toc.pdf';
const STANDARD_PDF_LABEL = process.env.STANDARD_PDF_LABEL || 'STANDARD_TOC_V1';
async function ensureStandardPdfIndexed() {
  try {
    if (!STANDARD_PDF_URL || process.env.SKIP_STANDARD_PDF === '1') return;
    if (await learnerStore.pdfExistsByLabel(STANDARD_PDF_LABEL)) return;
    const { docId, nChunks } = await indexPdfBuffer(await fetchPdf(STANDARD_PDF_URL), STANDARD_PDF_LABEL);
    console.log(`[MedLearner] Indexed standard PDF ${STANDARD_PDF_LABEL} as ${docId} (${nChunks} chunks).`);
  } catch (err) {
    console.error('[MedLearner] Standard PDF not indexed:', err?.message || err);
  }
}

////////////////////////////////////////////////////////////////////////////////
// MEDICAL CASE SIMULATOR
////////////////////////////////////////////////////////////////////////////////
const getCaseExclusions = async (u) => (await redis.lrange(kCaseExcl(u), 0, -1)).map(String);
async function pushUniqueCaseExclusion(u, entry) {
  const e = String(entry || '').trim();
  if (!e) return 0;
  const n = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (new Set((await getCaseExclusions(u)).map(n)).has(n(e))) return 0;
  await redis.rpush(kCaseExcl(u), e);
  return 1;
}

function isPendingConsultSetting(specialty = '') {
  const s = String(specialty).toLowerCase();
  return /\b(ctu|clinical teaching unit|internal medicine|medicine|gim)\b/.test(s) && /\b(consult|referral|ed|emerg)/.test(s);
}

function normalizeNote(n = {}) {
  const noteType = String(n.noteType || n.type || 'Note');
  const providerName = String(n.providerName || n.provider || n.author || '');
  return { id: String(n.id || uuid()), datetime: String(n.datetime || ''), service: String(n.service || n.department || ''), providerName, noteType, type: noteType, author: providerName, title: String(n.title || noteType), text: String(n.text || '') };
}

// Applied once, to the generated opening chart only (never to learner notes).
function removePrematureConsultNotes(patient, specialty) {
  if (!isPendingConsultSetting(specialty)) return;
  patient.notes = patient.notes.filter(note => {
    const service = String(note.service || '').toLowerCase();
    const type = String(`${note.noteType} ${note.title}`).toLowerCase();
    const isIM = /internal medicine|\bmedicine\b|gim|ctu/.test(`${service} ${type}`);
    const isRequest = /request|referral|triage|\bed\b|emergency/.test(`${type} ${service}`);
    const isCompleted = /consult note|admission|progress|assessment|plan|recommendation/.test(`${type} ${String(note.text).toLowerCase().slice(0, 400)}`);
    return isRequest || !(isIM && isCompleted);
  });
}

function sanitizeGeneratedPatient(p) {
  p = p && typeof p === 'object' ? p : {};
  const withIds = (arr) => ensureArray(arr).map(x => ({ id: String(x?.id || uuid()), ...x }));
  return {
    id: uuid(),
    displayName: String(p.displayName || p.name || 'Doe, Alex'),
    age: Number.isFinite(Number(p.age)) ? Number(p.age) : 50,
    sex: String(p.sex || 'U'),
    location: String(p.location || 'Emergency Department'),
    allergies: ensureArray(p.allergies).map(String),
    codeStatus: String(p.codeStatus || 'Full Code'),
    presentingComplaint: String(p.presentingComplaint || 'Undifferentiated presentation'),
    banner: String(p.banner || ''),
    vitals: [],
    labCategories: [],
    investigations: withIds(p.investigations),
    nursingNotes: withIds(p.nursingNotes),
    medications: withIds(p.medications),
    notes: ensureArray(p.notes).map(normalizeNote)
  };
}

function publicCasePayload(session) {
  const isLegacy = session.engineVersion !== ENGINE_VERSION;
  const p = session.patient || {};
  const currentTime = session.sim?.now || session.currentTime || '';
  return {
    ok: true,
    sessionId: session.id,
    version: session.version,
    legacy: isLegacy,
    mode: session.mode, specialty: session.specialty, difficulty: session.difficulty, createdAt: session.createdAt,
    caseTitle: session.caseTitle || 'Medical case',
    currentTime, currentDayLabel: dayLabel(currentTime),
    patient: {
      id: p.id, displayName: p.displayName, age: p.age, sex: p.sex, location: p.location, allergies: ensureArray(p.allergies),
      codeStatus: p.codeStatus, presentingComplaint: p.presentingComplaint, banner: p.banner,
      vitals: ensureArray(p.vitals), labCategories: sortLabCategories(ensureArray(p.labCategories)), investigations: ensureArray(p.investigations),
      nursingNotes: ensureArray(p.nursingNotes), medications: ensureArray(p.medications), notes: ensureArray(p.notes),
      orders: isLegacy ? ensureArray(p.orders) : publicOrders(session)
    },
    pending: isLegacy ? [] : pendingList(session),
    transcript: ensureArray(session.transcript).slice(-150).map(t => ({ at: t.at, q: t.q, a: t.a })),
    activity: ensureArray(session.activity).slice(-80),
    orderHistory: ensureArray(session.orderHistory),
    concluded: !!session.concluded,
    conclusion: session.concluded ? session.conclusion || null : null
  };
}

const sendErr = (res, e, fallback) => {
  const code = e?.statusCode || 500;
  res.status(code).json({ error: code === 500 ? fallback : String(e.message || fallback), detail: code === 500 ? String(e?.message || e).slice(0, 300) : undefined });
};

// Load-modify-save wrapper: per-session lock, ownership, idempotent retries
// (same requestId returns the stored result), and a version-checked save.
async function withCase(req, res, { allowConcluded = false, allowLegacy = false } = {}, fn) {
  const id = String(req.params.id || '');
  await withLock(`case:${id}`, async () => {
    try {
      const session = await caseStore.load(id);
      if (!session) return res.status(404).json({ error: 'Case session not found' });
      if (session.userId && session.userId !== req.auth.username) return res.status(403).json({ error: "Cannot access another user's case session" });
      const requestId = String(req.body?.requestId || '').slice(0, 80);
      if (requestId && session.processed?.[requestId]) return res.json({ ...publicCasePayload(session), ...session.processed[requestId], duplicate: true });
      if (session.concluded && !allowConcluded) return res.status(400).json({ error: 'Case already concluded' });
      if (session.engineVersion !== ENGINE_VERSION && !allowLegacy) return res.status(409).json({ error: 'This case was created before the simulator upgrade. You can review it and conclude it for a debrief; start a new case to keep playing.' });
      const extra = (await fn(session)) || {};
      if (requestId) {
        session.processed = session.processed || {};
        session.processed[requestId] = extra;
        const keys = Object.keys(session.processed);
        if (keys.length > 30) delete session.processed[keys[0]];
      }
      await caseStore.save(session);
      res.json({ ...publicCasePayload(session), ...extra });
    } catch (e) {
      if (e instanceof ConflictError) return res.status(409).json({ error: e.message });
      sendErr(res, e, 'Case action failed');
    }
  });
}

app.get('/case/exclusions/count', async (req, res) => res.json({ count: await redis.llen(kCaseExcl(req.auth.username)) }));
app.get('/case/exclusions', async (req, res) => res.json({ entries: await getCaseExclusions(req.auth.username) }));

app.get('/case/sessions', async (req, res) => {
  try { res.json({ sessions: await caseStore.listForUser(req.auth.username, 30) }); }
  catch (e) { sendErr(res, e, 'Failed to list cases'); }
});

app.post('/case/sessions', async (req, res) => {
  const userId = req.auth.username;
  const requestId = String(req.body?.requestId || '').slice(0, 80);
  await withLock(`case-create:${userId}`, async () => {
    try {
      if (requestId) {
        const existingId = await redis.get(kCaseReq(userId, requestId));
        if (existingId) { const s = await caseStore.load(String(existingId)); if (s) return res.json({ ...publicCasePayload(s), duplicate: true }); }
      }
      const body = req.body || {};
      const mode = String(body.mode || 'regular').toLowerCase() === 'zebra' ? 'zebra' : 'regular';
      const specialty = String(body.specialty || '').trim().slice(0, 120);
      const difficulty = normalizeDifficulty(body.difficulty || 'Hard');
      const saved = await getCaseExclusions(userId);
      const exclusionText = [...saved, String(body.exclusionText || '').trim()].filter(Boolean).join('\n');
      const id = uuid();
      const gen = await generateCase({ mode, specialty, difficulty, exclusionText, userId, meta: { sessionId: id, userId } });
      const session = {
        id, userId, mode, specialty, difficulty, createdAt: new Date().toISOString(),
        caseTitle: String(gen.caseTitle || 'Medical case').slice(0, 120),
        lock: gen.lock,
        patient: sanitizeGeneratedPatient(gen.patient),
        activity: [], orderHistory: [], concluded: false
      };
      removePrematureConsultNotes(session.patient, specialty);
      initEngine(session, gen);
      session.simStartTime = session.sim.now;
      session.activity.push({ at: session.sim.now, type: 'system', text: 'Case opened.' });
      await caseStore.create(session);
      if (requestId) await redis.set(kCaseReq(userId, requestId), id, { ex: 3600 });
      res.json({ ...publicCasePayload(session), caseExclusionCount: saved.length });
    } catch (e) {
      sendErr(res, e, 'Failed to start case session');
    }
  });
});

app.get('/case/sessions/:id', async (req, res) => {
  try {
    const s = await caseStore.load(req.params.id);
    if (!s) return res.status(404).json({ error: 'Case session not found' });
    if (s.userId && s.userId !== req.auth.username) return res.status(403).json({ error: "Cannot access another user's case session" });
    res.json(publicCasePayload(s));
  } catch (e) { sendErr(res, e, 'Failed to load case session'); }
});

// The answer file is only available after the case is concluded.
app.get('/case/sessions/:id/lockfile', async (req, res) => {
  const s = await caseStore.load(req.params.id).catch(() => null);
  if (!s) return res.status(404).type('text/plain').send('Case session not found');
  if (s.userId && s.userId !== req.auth.username) return res.status(403).type('text/plain').send('Forbidden');
  if (!s.concluded) return res.status(403).type('text/plain').send('Available after the case is concluded.');
  const lock = s.lock || {};
  const txt = [
    'Medical Case Simulator case file', `Session ID: ${s.id}`, `Created: ${s.createdAt}`, `Mode: ${s.mode}`, `Setting: ${s.specialty || 'unspecified'}`, '',
    `PRIMARY DIAGNOSIS: ${lock.primaryDiagnosis || ''}`, `Secondary diagnoses: ${ensureArray(lock.secondaryDiagnoses).join('; ')}`,
    `Expected key actions: ${ensureArray(lock.expectedKeyActions).join('; ')}`, `Dangerous actions: ${ensureArray(lock.dangerousActions).join('; ')}`, '',
    'Exclusion entry:', lock.exclusionEntry || lock.primaryDiagnosis || ''
  ].join('\n');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="case-${s.id}.txt"`);
  res.send(txt);
});

app.post('/case/sessions/:id/interact', (req, res) => {
  const request = String(req.body?.request || '').trim().slice(0, 1500);
  if (!request) return res.status(400).json({ error: 'request required' });
  return withCase(req, res, {}, async (session) => {
    const out = await engineInteract(session, request, caseAiAdapter({ sessionId: session.id, userId: session.userId }));
    return { response: out.response };
  });
});

app.post('/case/sessions/:id/orders', (req, res) => {
  const orders = ensureArray(req.body?.orders).map(x => String(x || '').trim().slice(0, 300)).filter(Boolean).slice(0, 25);
  if (!orders.length) return res.status(400).json({ error: 'orders required' });
  return withCase(req, res, {}, async (session) => {
    const orderResults = await placeOrders(session, orders, caseAiAdapter({ sessionId: session.id, userId: session.userId }));
    return { orderResults, visibleEvent: 'RN: Orders acknowledged.' };
  });
});

app.post('/case/sessions/:id/advance', (req, res) => {
  const mode = req.body?.mode === 'minutes' ? 'minutes' : 'next';
  const minutes = Number(req.body?.minutes || 60);
  return withCase(req, res, {}, async (session) => {
    const out = await engineAdvance(session, { mode, minutes }, caseAiAdapter({ sessionId: session.id, userId: session.userId }));
    return { event: out.event, notices: out.notices, urgency: out.urgency };
  });
});

app.post('/case/sessions/:id/note', (req, res) => {
  const text = String(req.body?.text || '').trim().slice(0, 20000);
  if (!text) return res.status(400).json({ error: 'note text required' });
  return withCase(req, res, { allowLegacy: true }, async (session) => {
    const now = session.sim?.now || session.currentTime || '';
    const note = normalizeNote({
      id: uuid(), datetime: now, service: String(req.body?.service || 'Internal Medicine').slice(0, 80),
      providerName: String(req.body?.providerName || req.body?.author || 'Learner').slice(0, 80), noteType: String(req.body?.noteType || 'Progress note').slice(0, 60),
      title: String(req.body?.title || 'Learner note').slice(0, 120), text
    });
    note.authoredByLearner = true;
    session.patient.notes = ensureArray(session.patient.notes);
    session.patient.notes.push(note);
    session.activity = ensureArray(session.activity);
    session.activity.push({ at: now, type: 'user_note', text: note.title });
    return { savedNoteId: note.id };
  });
});

app.post('/case/sessions/:id/conclude', (req, res) => {
  return withCase(req, res, { allowConcluded: true, allowLegacy: true }, async (session) => {
    if (session.concluded && session.conclusion) return { conclusion: session.conclusion };
    const out = await concludeCase(session, { finalNoteText: String(req.body?.finalNoteText || '').slice(0, 20000), finalOrdersText: String(req.body?.finalOrdersText || '').slice(0, 5000) }, { sessionId: session.id, userId: session.userId });
    session.concluded = true;
    session.concludedAt = new Date().toISOString();
    session.conclusion = out;
    const caseExclusionAdded = await pushUniqueCaseExclusion(session.userId, out.exclusionEntry || session.lock?.exclusionEntry || '');
    return { conclusion: out, caseExclusionAdded };
  });
});

////////////////////////////////////////////////////////////////////////////////
// TEXTBOOK (Google Drive "IM Textbook Project")
////////////////////////////////////////////////////////////////////////////////
app.get('/textbook/api/tree', (_req, res) => res.json({ status: textbook.status(), specialties: textbook.tree() }));
app.get('/textbook/api/article', (req, res) => {
  const a = textbook.article(String(req.query.id || ''));
  if (!a) return res.status(404).json({ error: 'Article not found. It may have been renamed in the source document.' });
  res.json(a);
});
app.get('/textbook/api/search', (req, res) => {
  const qtext = String(req.query.q || '').slice(0, 200);
  res.json(textbook.search(qtext, { limit: clamp(Number(req.query.limit || 30), 1, 60), specialty: String(req.query.specialty || '') }));
});
// Images are served without login because <img> cannot send a bearer token;
// keys are unguessable hashes.
app.get('/textbook/img/:key', async (req, res) => {
  try {
    const img = await textbook.getImage(String(req.params.key));
    if (!img) return res.status(404).end();
    res.setHeader('Content-Type', img.type || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(img.data);
  } catch { res.status(500).end(); }
});

////////////////////////////////////////////////////////////////////////////////
// ADMIN (requires X-Admin-Secret header or ADMIN_USERS login)
////////////////////////////////////////////////////////////////////////////////
app.use('/admin', requireAdmin);

app.get('/admin/usage', async (req, res) => {
  try {
    const days = clamp(Number(req.query.days || 7), 1, 90);
    const sessionId = req.query.session ? String(req.query.session) : null;
    let records;
    if (hasPg()) {
      const r = sessionId
        ? await q('SELECT * FROM ai_usage WHERE session_id = $1 ORDER BY at', [sessionId])
        : await q(`SELECT * FROM ai_usage WHERE at > now() - ($1 || ' days')::interval ORDER BY at`, [String(days)]);
      records = r.rows.map(x => ({ ...x, cost_usd: x.cost_usd == null ? null : Number(x.cost_usd), sessionId: x.session_id }));
    } else {
      const raw = (await redis.lrange('ai:usage', 0, -1)).map(parseMaybeJSON).filter(Boolean);
      const cutoff = Date.now() - days * 86400000;
      records = raw.filter(r => (sessionId ? r.sessionId === sessionId : Date.parse(r.at) >= cutoff));
      if (!records.length && !sessionId) records = recentUsage();
    }
    const perCase = {};
    for (const r of records) if (r.sessionId && String(r.tag || '').startsWith('case.')) {
      const c = perCase[r.sessionId] ||= { sessionId: r.sessionId, calls: 0, input_tokens: 0, output_tokens: 0 };
      c.calls++; c.input_tokens += Number(r.input_tokens || 0); c.output_tokens += Number(r.output_tokens || 0);
    }
    const cases = Object.values(perCase);
    res.json({
      window: sessionId ? { session: sessionId } : { days },
      models: { case: CASE_MODEL, caseFast: CASE_FAST_MODEL, pimp: PIMP_MODEL, pimpGenerator: PIMP_GENERATOR_MODEL, grader: PIMP_GRADER_MODEL, discussion: PIMP_DISCUSSION_MODEL, strict: STRICT_MODEL },
      ...summarizeUsage(records),
      cases: { count: cases.length, avg_input_tokens: cases.length ? Math.round(cases.reduce((s, c) => s + c.input_tokens, 0) / cases.length) : 0, recent: cases.slice(-20) }
    });
  } catch (e) { sendErr(res, e, 'Usage query failed'); }
});

app.delete('/admin/wipe', async (req, res) => {
  try {
    if (String(req.query.confirm || '') !== 'WIPE') return res.status(400).json({ error: 'Add ?confirm=WIPE to proceed.' });
    const dry = String(req.query.dry || '0') === '1';
    const patterns = ['user:*', 'username_index:*', 'auth:token:*', 'sess:*', 'excl:*', 'concepts:*', 'history:*', 'leaderboard:*', 'casesim:*'];
    let deleted = 0;
    for (const p of patterns) {
      const keys = await redis.keys(p);
      for (let i = 0; i < keys.length; i += 100) { const slice = keys.slice(i, i + 100); if (!dry && slice.length) await redis.del(...slice); deleted += slice.length; }
    }
    if (hasPg() && !dry) await q('TRUNCATE case_sessions');
    res.json({ ok: true, dry, deleted_keys_estimate: deleted });
  } catch (e) { sendErr(res, e, 'wipe failed'); }
});

app.get('/admin/peek-session', async (req, res) => {
  const id = String(req.query.sessionId || '');
  if (!id) return res.status(400).json({ error: 'sessionId required' });
  const items = await getSessionItems(id);
  res.json({ meta: await getSessionMeta(id), items_count: items.length, last_item: items[items.length - 1] || null });
});

app.post('/admin/textbook/sync', async (req, res) => {
  res.json(await textbook.sync({ force: String(req.query.force || '') === '1' }));
});
app.get('/admin/textbook/status', (_req, res) => res.json(textbook.status()));

app.delete('/admin/pdfs/by-label', async (req, res) => {
  const label = String(req.query.label || '');
  if (!label) return res.status(400).json({ error: 'label required' });
  res.json({ ok: true, deleted: await learnerStore.deletePdfByLabel(label), label });
});

////////////////////////////////////////////////////////////////////////////////
// START
////////////////////////////////////////////////////////////////////////////////
app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 25 MB).' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  console.error('[unhandled]', err);
  res.status(500).json({ error: 'Server error' });
});

async function start() {
  if (hasPg()) {
    // If the database is configured but unreachable, fail the deploy so Render
    // keeps the previous version live instead of serving a broken one.
    await migrate();
    console.log('[storage] Postgres ready.');
  }
  app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
  textbook.start().catch(err => console.error('[textbook] start failed:', err?.message || err));
}

if (process.env.NO_LISTEN !== '1') {
  start().catch(err => { console.error('[startup] failed:', err); process.exit(1); });
}

export { app };
