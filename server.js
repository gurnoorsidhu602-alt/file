import express from "express";
import cors from "cors";
import { Redis } from "@upstash/redis";

const app = express();
app.use(express.json());
app.use(cors());

// --- Upstash client using ENV VARS (trim to avoid stray spaces) ---
const redis = new Redis({
  url: (process.env.UPSTASH_REDIS_REST_URL || "").trim(),
  token: (process.env.UPSTASH_REDIS_REST_TOKEN || "").trim(),
});

// --- Helpers ---
const key = (user_id) => `user:${user_id}:topics`;
async function getTopics(user_id) {
  if (!user_id) return [];
  const raw = await redis.get(key(user_id));
  try { return Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []); }
  catch { return []; }
}
async function putTopics(user_id, topics) {
  await redis.set(key(user_id), JSON.stringify(topics));
}

// --- Health root ---
app.get("/", (_req, res) => res.type("text").send("ok"));

// --- DEBUG route (to verify env + Redis connectivity) ---
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

// --- API ---
app.get("/topics", async (req, res) => {
  try {
    const user_id = req.query.user_id;
    if (!user_id) return res.status(400).json({ error: "user_id is required" });
    const topics = await getTopics(user_id);
    res.json({ user_id, topics });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/topics", async (req, res) => {
  try {
    const { user_id, topic } = req.body || {};
    if (!user_id || !topic) return res.status(400).json({ error: "user_id and topic are required" });
    const topics = await getTopics(user_id);
    const exists = topics.some(t => t.toLowerCase() === String(topic).toLowerCase());
    if (!exists) topics.push(topic);
    await putTopics(user_id, topics);
    res.json({ user_id, topics, added: topic });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete("/topics", async (req, res) => {
  try {
    const { user_id, topic } = req.body || {};
    if (!user_id || !topic) return res.status(400).json({ error: "user_id and topic are required" });
    const topics = await getTopics(user_id);
    const filtered = topics.filter(t => t.toLowerCase() !== String(topic).toLowerCase());
    await putTopics(user_id, filtered);
    res.json({ user_id, topics: filtered, removed: topic });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`server listening on ${PORT}`));
