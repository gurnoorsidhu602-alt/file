// server.js
import express from "express";
import cors from "cors";
import { Redis } from "@upstash/redis";

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

// -------- Start --------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => log(`server listening on ${PORT}`));
