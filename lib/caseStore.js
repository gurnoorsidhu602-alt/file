// lib/caseStore.js
// Case session persistence with optimistic version checks.
// Postgres when configured; otherwise Upstash Redis (previous behaviour).
// In Postgres mode, sessions that still live in Redis are imported on first load,
// so in-progress cases survive the switch.

import { hasPg, q } from './db.js';

export class ConflictError extends Error {
  constructor() { super('Case was updated by another request. Reload and try again.'); this.statusCode = 409; }
}

const kCase = (id) => `casesim:session:${id}`;
const kUserCases = (u) => `casesim:user:${u}:sessions`;
const TTL = Number(process.env.CASE_SESSION_TTL_SECONDS || 60 * 60 * 24 * 30);

function parse(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

function listMeta(s) {
  return {
    id: s.id,
    title: s.caseTitle || 'Medical case',
    complaint: s.patient?.presentingComplaint || '',
    patient: s.patient ? `${s.patient.displayName || ''} ${s.patient.age || ''}${s.patient.sex || ''}`.trim() : '',
    mode: s.mode, difficulty: s.difficulty, specialty: s.specialty || '',
    concluded: !!s.concluded,
    createdAt: s.createdAt, updatedAt: s.updatedAt || s.createdAt,
    simTime: s.sim?.now || s.currentTime || ''
  };
}

export function makeCaseStore(redis) {
  async function loadRedis(id) {
    return parse(await redis.get(kCase(id)));
  }

  return {
    async load(id) {
      if (!id) return null;
      if (hasPg()) {
        const r = await q('SELECT data, version FROM case_sessions WHERE id = $1', [id]);
        if (r.rows[0]) return { ...r.rows[0].data, version: r.rows[0].version };
        const legacy = await loadRedis(id);
        if (!legacy) return null;
        legacy.version = 1;
        await q(`INSERT INTO case_sessions (id, user_id, version, title, complaint, mode, difficulty, concluded, data, created_at)
                 VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now())) ON CONFLICT (id) DO NOTHING`,
          [legacy.id, legacy.userId || '', legacy.caseTitle || '', legacy.patient?.presentingComplaint || '', legacy.mode || '', legacy.difficulty || '', !!legacy.concluded, legacy, legacy.createdAt || null]);
        return legacy;
      }
      const s = await loadRedis(id);
      if (s && !s.version) s.version = 1;
      return s;
    },

    async create(session) {
      session.version = 1;
      session.updatedAt = new Date().toISOString();
      if (hasPg()) {
        await q(`INSERT INTO case_sessions (id, user_id, version, title, complaint, mode, difficulty, concluded, data)
                 VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8)`,
          [session.id, session.userId, session.caseTitle || '', session.patient?.presentingComplaint || '', session.mode, session.difficulty, !!session.concluded, session]);
        return session;
      }
      await redis.set(kCase(session.id), JSON.stringify(session), { ex: TTL });
      await redis.zadd(kUserCases(session.userId), { score: Date.now(), member: session.id });
      return session;
    },

    // Saves only if nobody else saved since this copy was loaded.
    async save(session) {
      const expected = Number(session.version || 1);
      session.updatedAt = new Date().toISOString();
      if (hasPg()) {
        const next = { ...session, version: expected + 1 };
        const r = await q(`UPDATE case_sessions SET data = $1, version = version + 1, concluded = $2, title = $3, updated_at = now()
                           WHERE id = $4 AND version = $5`,
          [next, !!session.concluded, session.caseTitle || '', session.id, expected]);
        if (r.rowCount !== 1) throw new ConflictError();
        session.version = expected + 1;
        return session;
      }
      const current = await loadRedis(session.id);
      if (current && Number(current.version || 1) !== expected) throw new ConflictError();
      session.version = expected + 1;
      await redis.set(kCase(session.id), JSON.stringify(session), { ex: TTL });
      await redis.zadd(kUserCases(session.userId), { score: Date.now(), member: session.id });
      return session;
    },

    async listForUser(userId, limit = 30) {
      if (hasPg()) {
        const r = await q(`SELECT data FROM case_sessions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT $2`, [userId, limit]);
        return r.rows.map(x => listMeta(x.data));
      }
      const ids = await redis.zrange(kUserCases(userId), 0, limit - 1, { rev: true });
      const out = [];
      for (const id of ids || []) {
        const s = await loadRedis(String(id));
        if (s) out.push(listMeta(s));
      }
      return out;
    }
  };
}
