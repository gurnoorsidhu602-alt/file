// lib/memoryRedis.js
// In-memory stand-in for the subset of the Upstash Redis client this app uses.
// Enabled with REDIS_MEMORY=1 (local development and automated tests only;
// data is lost on restart).

function globToRe(p) { return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'); }

export function createMemoryRedis() {
  const kv = new Map();
  const exp = new Map();
  const alive = (k) => { const e = exp.get(k); if (e && e < Date.now()) { kv.delete(k); exp.delete(k); } return kv.has(k); };
  const get = (k) => (alive(k) ? kv.get(k) : undefined);
  const autoParse = (v) => { if (typeof v !== 'string') return v; try { const p = JSON.parse(v); return (p && typeof p === 'object') ? p : v; } catch { return v; } };
  return {
    async ping() { return 'PONG'; },
    async get(k) { const v = get(k); return v === undefined ? null : autoParse(v); },
    async set(k, v, opts = {}) { kv.set(k, typeof v === 'string' ? v : JSON.stringify(v)); if (opts.ex) exp.set(k, Date.now() + opts.ex * 1000); else exp.delete(k); return 'OK'; },
    async del(...keys) { let n = 0; for (const k of keys) { if (kv.delete(k)) n++; exp.delete(k); } return n; },
    async exists(k) { return alive(k) ? 1 : 0; },
    async keys(p) { const re = globToRe(p); return [...kv.keys()].filter(k => alive(k) && re.test(k)); },
    async hset(k, obj) { const h = get(k) || {}; for (const [f, v] of Object.entries(obj)) h[f] = typeof v === 'string' ? v : JSON.stringify(v); kv.set(k, h); return Object.keys(obj).length; },
    async hgetall(k) { const h = get(k); if (!h) return null; return Object.fromEntries(Object.entries(h).map(([f, v]) => [f, autoParse(v)])); },
    async hincrby(k, f, by) { const h = get(k) || {}; h[f] = String(Number(h[f] || 0) + Number(by)); kv.set(k, h); return Number(h[f]); },
    async rpush(k, ...vals) { const l = get(k) || []; l.push(...vals.map(v => (typeof v === 'string' ? v : JSON.stringify(v)))); kv.set(k, l); return l.length; },
    async lpush(k, ...vals) { const l = get(k) || []; l.unshift(...vals.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).reverse()); kv.set(k, l); return l.length; },
    async lrange(k, a, b) { const l = get(k) || []; const end = b < 0 ? l.length + b : b; return l.slice(a, end + 1).map(autoParse); },
    async llen(k) { return (get(k) || []).length; },
    async lindex(k, i) { const l = get(k) || []; const v = l[i < 0 ? l.length + i : i]; return v === undefined ? null : autoParse(v); },
    async lset(k, i, v) { const l = get(k) || []; l[i < 0 ? l.length + i : i] = typeof v === 'string' ? v : JSON.stringify(v); kv.set(k, l); return 'OK'; },
    async ltrim(k, a, b) { const l = get(k) || []; const end = b < 0 ? l.length + b : b; kv.set(k, l.slice(a, end + 1)); return 'OK'; },
    async zadd(k, ...items) { const z = get(k) || new Map(); for (const it of items) z.set(String(it.member), Number(it.score)); kv.set(k, z); return items.length; },
    async zincrby(k, by, m) { const z = get(k) || new Map(); z.set(String(m), Number(z.get(String(m)) || 0) + Number(by)); kv.set(k, z); return z.get(String(m)); },
    async zrange(k, a, b, opts = {}) {
      const z = get(k) || new Map();
      let arr = [...z.entries()].sort((x, y) => x[1] - y[1]);
      if (opts.rev) arr.reverse();
      const end = b < 0 ? arr.length + b : b;
      arr = arr.slice(a, end + 1);
      return opts.withScores ? arr.flatMap(([m, s]) => [m, s]) : arr.map(([m]) => m);
    }
  };
}
