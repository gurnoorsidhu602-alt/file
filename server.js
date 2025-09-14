// server.js
import express from "express";
import cors from "cors";
import { Redis } from "@upstash/redis";
import crypto from "crypto";

const app = express();
app.use(express.json());
app.use(cors());

// -------- Upstash client (uses REST creds from env) --------
const redis = new Redis({
  url: (process.env.UPSTASH_REDIS_REST_URL || "").trim(),
  token: (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim(),
});

// -------- Utils --------
const log = (...a) => console.log(new Date().toISOString(), ...a);
const norm = (s) => String(s || "").trim().toLowerCase();
const key  = (user_id) => `user:${norm(user_id)}:topics`;

async function getTopics(user_id) {
  const k = key(user_id);
  const raw = await redis.get(k);
  log("GET_FROM_REDIS", { key: k, type: typeof raw, raw });
  if (!raw) return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function putTopics(user_id, topics) {
  const k = key(user_id);
  await redis.set(k, JSON.stringify(topics));
  log("SET_IN_REDIS", { key: k, value: topics });
}

// -------- Health --------
app.get("/", (_req, res) => res.type("text").send("ok"));

// Debug: verify env + Redis connectivity (safe: no secrets leaked)
app.get("/debug", async (_req, res) => {
  const url = process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const meta = {
    hasUrl: !!url,
    hasTok: !!token,
    urlPrefix: url.slice(0, 28),
    tokLen: token.length,
  };
  try {
    const pong = await redis.ping();
    res.json({ env: meta, redis: { ping: pong } });
  } catch (e) {
    res.status(500).json({ env: meta, error: String(e) });
  }
});

// Dump raw stored value for the user (handy for debugging)
app.get("/dump", async (req, res) => {
  const user_id = norm(req.query.user_id);
  if (!user_id) return res.status(400).json({ error: "user_id is required" });
  const k = key(user_id);
  const raw = await redis.get(k);
  res.json({ user_id, key: k, raw });
});

// -------- API --------
app.get("/topics", async (req, res) => {
  try {
    const user_id = norm(req.query.user_id);
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    log("GET /topics", { user_id, key: key(user_id) });
    const topics = await getTopics(user_id);
    res.json({ user_id, topics });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/topics", async (req, res) => {
  try {
    const user_id = norm((req.body || {}).user_id);
    const topic   = (req.body || {}).topic;
    if (!user_id || !topic) return res.status(400).json({ error: "user_id and topic are required" });
    log("POST /topics", { user_id, topic, key: key(user_id) });

    const topics = await getTopics(user_id);
    const exists = topics.some((t) => t.toLowerCase() === String(topic).toLowerCase());
    if (!exists) topics.push(topic);
    await putTopics(user_id, topics);

    res.json({ user_id, topics, added: topic });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/topics", async (req, res) => {
  try {
    const user_id = norm((req.body || {}).user_id);
    const topic   = (req.body || {}).topic;
    if (!user_id || !topic) return res.status(400).json({ error: "user_id and topic are required" });
    log("DELETE /topics", { user_id, topic, key: key(user_id) });

    const topics   = await getTopics(user_id);
    const filtered = topics.filter((t) => t.toLowerCase() !== String(topic).toLowerCase());
    await putTopics(user_id, filtered);

    res.json({ user_id, topics: filtered, removed: topic });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/reset", async (req, res) => {
  try {
    const user_id = norm((req.body || {}).user_id);
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    log("POST /reset", { user_id, key: key(user_id) });
    await putTopics(user_id, []);
    res.json({ user_id, topics: [] });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- Exclusions helpers ----------
const qNorm = (s) => String(s || "").trim();             // keep case/punct (used for display)
const qHash = (s) => crypto.createHash("sha256").update(qNorm(s).toLowerCase()).digest("hex");

const exKey = (user_id) => `user:${norm(user_id)}:exclusions:v1`;  // single JSON blob

async function loadExclusions(user_id) {
  const raw = await redis.get(exKey(user_id));
  if (!raw) return { list: [], hashes: {} };
  const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  return {
    list: Array.isArray(obj.list) ? obj.list : [],
    hashes: obj.hashes && typeof obj.hashes === "object" ? obj.hashes : {},
  };
}

async function saveExclusions(user_id, data) {
  // data: { list: [...strings...], hashes: { sha256: true } }
  await redis.set(exKey(user_id), JSON.stringify(data));
}

function renderExclusionTxt(list) {
  // "1. First question\n2. Second question\n..."
  return list.map((q, i) => `${i + 1}. ${q}`).join("\n");
}

// GET /exclusions/count?user_id=...
app.get("/exclusions/count", async (req, res) => {
  try {
    const user_id = norm(req.query.user_id);
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    const { list } = await loadExclusions(user_id);
    res.json({ user_id, count: list.length, next_number: list.length + 1 });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /exclusions?user_id=...&limit=50&offset=0   (paginated)
app.get("/exclusions", async (req, res) => {
  try {
    const user_id = norm(req.query.user_id);
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    const limit  = Math.max(1, Math.min(parseInt(req.query.limit ?? "50", 10) || 50, 200));
    const offset = Math.max(0, parseInt(req.query.offset ?? "0", 10) || 0);

    const { list } = await loadExclusions(user_id);
    const total = list.length;
    const slice = list.slice(offset, offset + limit);
    const next_offset = offset + limit < total ? offset + limit : null;

    res.json({ user_id, total, limit, offset, next_offset, questions: slice });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /exclusions/merge  { user_id, new_questions: [string] }
// Appends unique questions (exact-text dedup; case-insensitive).
app.post("/exclusions/merge", async (req, res) => {
  try {
    const { user_id: uidRaw, new_questions } = req.body || {};
    const user_id = norm(uidRaw);
    if (!user_id || !Array.isArray(new_questions))
      return res.status(400).json({ error: "user_id and new_questions[] are required" });

    const MAX_TOPIC_LEN = 300; // prevent huge blobs
    const src = new_questions
      .map(qNorm)
      .filter(Boolean)
      .filter((q) => q.length <= MAX_TOPIC_LEN);

    const data = await loadExclusions(user_id);
    let added = 0;
    for (const q of src) {
      const h = qHash(q);
      if (!data.hashes[h]) {
        data.hashes[h] = true;
        data.list.push(q);
        added++;
      }
    }
    await saveExclusions(user_id, data);

    res.json({
      user_id,
      added,
      new_count: data.list.length,
      next_number: data.list.length + 1,
      exclusion_text: renderExclusionTxt(data.list),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /exclusions/import { user_id, text }   (optional one-time initializer)
// Accepts the legacy TXT (numbered or not), replaces existing list.
app.post("/exclusions/import", async (req, res) => {
  try {
    const { user_id: uidRaw, text } = req.body || {};
    const user_id = norm(uidRaw);
    if (!user_id || typeof text !== "string")
      return res.status(400).json({ error: "user_id and text are required" });

    const lines = text.split(/\r?\n/).map((ln) => ln.replace(/^\s*\d+\.\s*/, "").trim()).filter(Boolean);
    const MAX_TOPIC_LEN = 300;
    const list = [];
    const hashes = {};
    for (const q of lines) {
      if (q.length > MAX_TOPIC_LEN) continue;
      const h = qHash(q);
      if (!hashes[h]) {
        hashes[h] = true;
        list.push(q);
      }
    }
    await saveExclusions(user_id, { list, hashes });
    res.json({ user_id, count: list.length, next_number: list.length + 1 });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// POST /exclusions/reset { user_id }   (nuke list)
app.post("/exclusions/reset", async (req, res) => {
  try {
    const user_id = norm((req.body || {}).user_id);
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    await saveExclusions(user_id, { list: [], hashes: {} });
    res.json({ user_id, count: 0, next_number: 1 });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});



// -------- Start --------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`server listening on ${PORT}`));
