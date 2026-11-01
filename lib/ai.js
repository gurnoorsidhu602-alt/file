// lib/ai.js
// Shared OpenAI helpers + usage/latency/cost tracking.
//
// Every model call goes through responsesCall({ tag, ... }). The tag names the
// feature (e.g. "case.interact", "pimp.grade") so usage can be broken down by
// route. Usage records are kept in memory (recent window) and handed to an
// optional persistence sink (Postgres table or Redis list) set by server.js.

import OpenAI from 'openai';

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'missing-key' });

// --- Models (env-configurable; defaults match the previous server.js) -------
export const BASE_MODEL = process.env.OPENAI_BASE_MODEL || 'gpt-5.4-mini';
export const STRICT_MODEL = process.env.OPENAI_STRICT_MODEL || 'gpt-5.5';
export const PREMIUM_MODEL = process.env.OPENAI_PREMIUM_MODEL || process.env.OPENAI_CASE_MODEL || STRICT_MODEL;
export const FAST_MODEL = process.env.OPENAI_FAST_MODEL || process.env.OPENAI_PIMP_MODEL || 'gpt-5.4-mini';
export const ULTRA_FAST_MODEL = process.env.OPENAI_ULTRA_FAST_MODEL || 'gpt-5.4-nano';
export const PIMP_MODEL = process.env.OPENAI_PIMP_MODEL || FAST_MODEL;
export const PIMP_GRADER_MODEL = process.env.OPENAI_PIMP_GRADER_MODEL || FAST_MODEL;
export const PIMP_DISCUSSION_MODEL = process.env.OPENAI_PIMP_DISCUSSION_MODEL || FAST_MODEL;
export const CASE_MODEL = process.env.OPENAI_CASE_MODEL || PREMIUM_MODEL;
export const CASE_FAST_MODEL = process.env.OPENAI_CASE_FAST_MODEL || FAST_MODEL;

export function envInt(name, fallback) {
  const n = Number.parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function supportsTemperature(model = '') {
  const m = String(model || '').toLowerCase();
  if (m.startsWith('gpt-5')) return false;
  if (/^o\d/.test(m)) return false;
  return true;
}

export function supportsReasoningEffort(model = '') {
  const m = String(model || '').toLowerCase();
  return m.startsWith('gpt-5') || /^o\d/.test(m);
}

// --- Usage tracking ---------------------------------------------------------
// Optional pricing, USD per 1M tokens, e.g.
// OPENAI_PRICING_JSON={"gpt-5.5":{"input":1.25,"cached":0.125,"output":10}}
// No prices are hard-coded: if a model is missing, cost is reported as null.
let PRICING = {};
try { PRICING = JSON.parse(process.env.OPENAI_PRICING_JSON || '{}') || {}; } catch { PRICING = {}; }

export function estimateCost(model, u) {
  const p = PRICING[model];
  if (!p) return null;
  const cached = Number(u.cached_tokens || 0);
  const freshIn = Math.max(0, Number(u.input_tokens || 0) - cached);
  const cost = (freshIn * Number(p.input || 0) + cached * Number(p.cached ?? p.input ?? 0) + Number(u.output_tokens || 0) * Number(p.output || 0)) / 1e6;
  return Math.round(cost * 1e6) / 1e6;
}

const RECENT_LIMIT = 2000;
const recent = [];
let usageSink = null;
export function setUsageSink(fn) { usageSink = typeof fn === 'function' ? fn : null; }
export function recentUsage() { return recent.slice(); }

function recordUsage(rec) {
  recent.push(rec);
  if (recent.length > RECENT_LIMIT) recent.splice(0, recent.length - RECENT_LIMIT);
  if (usageSink) Promise.resolve().then(() => usageSink(rec)).catch(err => console.warn('[usage] sink failed:', err?.message || err));
}

export function summarizeUsage(records) {
  const byTag = {};
  const total = { calls: 0, errors: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, ms: 0, cost_usd: 0, cost_known: true };
  for (const r of records) {
    const k = `${r.tag}|${r.model}`;
    const b = byTag[k] ||= { tag: r.tag, model: r.model, calls: 0, errors: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_ms: 0, cost_usd: 0, cost_known: true };
    for (const t of [b, total]) {
      t.calls += 1;
      if (!r.ok) t.errors += 1;
      t.input_tokens += Number(r.input_tokens || 0);
      t.cached_tokens += Number(r.cached_tokens || 0);
      t.output_tokens += Number(r.output_tokens || 0);
      t.reasoning_tokens += Number(r.reasoning_tokens || 0);
      if (r.cost_usd == null) t.cost_known = false; else t.cost_usd += Number(r.cost_usd);
    }
    b.total_ms += Number(r.ms || 0);
    total.ms += Number(r.ms || 0);
  }
  const rows = Object.values(byTag).map(b => ({ ...b, avg_ms: b.calls ? Math.round(b.total_ms / b.calls) : 0, avg_input_tokens: b.calls ? Math.round(b.input_tokens / b.calls) : 0 }));
  rows.sort((a, b) => b.input_tokens - a.input_tokens);
  return { total, byTag: rows };
}

// --- Responses API wrapper ----------------------------------------------------
export async function responsesCall({ tag = 'untagged', meta = {}, model, messages, temperature, max_output_tokens, reasoning_effort, jsonMode = false }) {
  const req = { model, input: messages };
  if (temperature !== undefined && supportsTemperature(model)) req.temperature = temperature;
  if (max_output_tokens !== undefined) req.max_output_tokens = max_output_tokens;
  if (reasoning_effort && supportsReasoningEffort(model)) req.reasoning = { effort: reasoning_effort };
  if (jsonMode) req.text = { format: { type: 'json_object' } };

  const started = Date.now();
  let resp;
  try {
    resp = await openai.responses.create(req);
    return resp;
  } catch (err) {
    recordUsage({ at: new Date().toISOString(), tag, model, ok: false, error: String(err?.message || err).slice(0, 300), ms: Date.now() - started, ...meta });
    throw err;
  } finally {
    if (resp) {
      const u = resp.usage || {};
      const rec = {
        at: new Date().toISOString(), tag, model, ok: resp.status !== 'incomplete',
        status: resp.status || '',
        input_tokens: Number(u.input_tokens || 0),
        cached_tokens: Number(u.input_tokens_details?.cached_tokens || 0),
        output_tokens: Number(u.output_tokens || 0),
        reasoning_tokens: Number(u.output_tokens_details?.reasoning_tokens || 0),
        ms: Date.now() - started,
        ...meta
      };
      rec.cost_usd = estimateCost(model, rec);
      recordUsage(rec);
    }
  }
}

// --- Output parsing -----------------------------------------------------------
export function extractOutputText(resp) {
  if (typeof resp?.output_text === 'string' && resp.output_text.trim()) return resp.output_text.trim();
  const parts = [];
  const output = Array.isArray(resp?.output) ? resp.output : [];
  for (const item of output) {
    if (!item) continue;
    if (typeof item.text === 'string' && item.text.trim()) parts.push(item.text.trim());
    const content = Array.isArray(item.content) ? item.content : [];
    for (const c of content) {
      if (!c) continue;
      if (typeof c.text === 'string' && c.text.trim()) parts.push(c.text.trim());
      if (typeof c.refusal === 'string' && c.refusal.trim()) parts.push(c.refusal.trim());
    }
  }
  return parts.join('\n').trim();
}

export function parseLooseJSON(text) {
  if (text && typeof text === 'object' && !Array.isArray(text)) return text;
  if (typeof text !== 'string') return null;
  let t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  const c = t.indexOf('['), d = t.lastIndexOf(']');
  if (c >= 0 && d > c) { try { return JSON.parse(t.slice(c, d + 1)); } catch {} }
  return null;
}

export function parseResponsesJSON(resp) {
  return parseLooseJSON(extractOutputText(resp));
}

export class AiOutputError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// JSON call with: JSON mode (with fallback), truncation detection, parse, an
// optional validator, and one bounded retry on malformed output.
export async function aiJSON({ tag, meta, system, payload, model, temperature = 0, max_output_tokens = 2000, reasoning_effort = 'low', validate = null, retries = 1 }) {
  const messages = [
    { role: 'system', content: `${system}\n\nRespond with one complete valid JSON object only. No markdown, prose, or code fences.` },
    { role: 'user', content: JSON.stringify(payload) }
  ];
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let resp;
    try {
      resp = await responsesCall({ tag, meta, model, temperature, max_output_tokens, reasoning_effort, jsonMode: true, messages });
    } catch (err) {
      const msg = String(err?.message || err || '').toLowerCase();
      if (!msg.includes('json') && !msg.includes('text.format') && !msg.includes('response_format')) throw err;
      resp = await responsesCall({ tag, meta, model, temperature, max_output_tokens, reasoning_effort, messages });
    }
    if (resp?.status === 'incomplete' && resp?.incomplete_details?.reason === 'max_output_tokens') {
      lastErr = new AiOutputError(`AI output truncated at max_output_tokens=${max_output_tokens}`, 'truncated');
      // A bigger budget is the only useful retry for truncation.
      max_output_tokens = Math.round(max_output_tokens * 1.5);
      continue;
    }
    const parsed = parseLooseJSON(extractOutputText(resp));
    if (!parsed || typeof parsed !== 'object') {
      lastErr = new AiOutputError('AI returned non-JSON output', 'non_json');
      continue;
    }
    if (validate) {
      const problem = validate(parsed);
      if (problem) { lastErr = new AiOutputError(`AI output failed validation: ${problem}`, 'invalid'); continue; }
    }
    return parsed;
  }
  throw lastErr || new AiOutputError('AI call failed', 'unknown');
}
