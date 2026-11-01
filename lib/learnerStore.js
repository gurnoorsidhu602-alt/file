// lib/learnerStore.js
// Med Learner persistence: completed topics + PDF chunk search.
// Postgres (durable, full-text search via tsvector) when DATABASE_URL is set;
// otherwise the original local SQLite file (FTS5). Note: on Render without a
// persistent disk, the SQLite file is erased on every deploy.

import crypto from 'crypto';
import { hasPg, q, pool } from './db.js';

let sqlite = null;
async function getSqlite() {
  if (sqlite) return sqlite;
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(process.env.SQLITE_PATH || 'medlearner.db');
  db.pragma('journal_mode = WAL');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS completed_topics (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, topic TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, topic));
    CREATE TABLE IF NOT EXISTS pdf_docs (id TEXT PRIMARY KEY, label TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS pdf_chunks (id TEXT PRIMARY KEY, doc_id TEXT NOT NULL, ord INTEGER NOT NULL, text TEXT NOT NULL, FOREIGN KEY(doc_id) REFERENCES pdf_docs(id) ON DELETE CASCADE);
    CREATE VIRTUAL TABLE IF NOT EXISTS pdf_chunks_fts USING fts5(text, content='pdf_chunks', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS pdf_chunks_ai AFTER INSERT ON pdf_chunks BEGIN INSERT INTO pdf_chunks_fts(rowid, text) VALUES (new.rowid, new.text); END;
    CREATE TRIGGER IF NOT EXISTS pdf_chunks_ad AFTER DELETE ON pdf_chunks BEGIN INSERT INTO pdf_chunks_fts(pdf_chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text); END;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pdf_label_unique ON pdf_docs(label) WHERE label IS NOT NULL;
  `);
  sqlite = db;
  return db;
}

// FTS5 treats punctuation as syntax; quote each term so user text can't break the query.
function ftsQuery(text) {
  const terms = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return terms.slice(0, 12).map(t => `"${t}"`).join(' OR ');
}

export const learnerStore = {
  async completedTopics(userId) {
    if (hasPg()) return (await q('SELECT topic FROM completed_topics WHERE user_id = $1 ORDER BY created_at DESC', [userId])).rows.map(r => r.topic);
    const db = await getSqlite();
    return db.prepare('SELECT topic FROM completed_topics WHERE user_id = ? ORDER BY created_at DESC').all(userId).map(r => r.topic);
  },

  async markCompleted(userId, topic) {
    if (hasPg()) { await q('INSERT INTO completed_topics (user_id, topic) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, topic]); return; }
    const db = await getSqlite();
    db.prepare('INSERT OR IGNORE INTO completed_topics (user_id, topic) VALUES (?, ?)').run(userId, topic);
  },

  async unmarkCompleted(userId, topic) {
    if (hasPg()) { await q('DELETE FROM completed_topics WHERE user_id = $1 AND topic = $2', [userId, topic]); return; }
    const db = await getSqlite();
    db.prepare('DELETE FROM completed_topics WHERE user_id = ? AND topic = ?').run(userId, topic);
  },

  async pdfExistsByLabel(label) {
    if (hasPg()) return (await q('SELECT 1 FROM pdf_docs WHERE label = $1', [label])).rowCount > 0;
    const db = await getSqlite();
    return !!db.prepare('SELECT id FROM pdf_docs WHERE label = ?').get(label);
  },

  async insertPdf(label, chunks) {
    const docId = crypto.randomUUID();
    if (hasPg()) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('INSERT INTO pdf_docs (id, label) VALUES ($1,$2)', [docId, label || null]);
        for (let i = 0; i < chunks.length; i++) {
          await client.query('INSERT INTO pdf_chunks (id, doc_id, ord, text) VALUES ($1,$2,$3,$4)', [crypto.randomUUID(), docId, i, chunks[i]]);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      return docId;
    }
    const db = await getSqlite();
    db.prepare('INSERT INTO pdf_docs (id, label) VALUES (?, ?)').run(docId, label || null);
    const ins = db.prepare('INSERT INTO pdf_chunks (id, doc_id, ord, text) VALUES (?, ?, ?, ?)');
    db.transaction(() => chunks.forEach((c, i) => ins.run(crypto.randomUUID(), docId, i, c)))();
    return docId;
  },

  async deletePdfByLabel(label) {
    if (hasPg()) return (await q('DELETE FROM pdf_docs WHERE label = $1', [label])).rowCount > 0;
    const db = await getSqlite();
    const row = db.prepare('SELECT id FROM pdf_docs WHERE label = ?').get(label);
    if (!row) return false;
    db.prepare('DELETE FROM pdf_chunks WHERE doc_id = ?').run(row.id);
    db.prepare('DELETE FROM pdf_docs WHERE id = ?').run(row.id);
    return true;
  },

  async search(text, k = 8) {
    const limit = Math.max(1, Math.min(50, Number(k) || 8));
    if (hasPg()) {
      const r = await q(`SELECT c.id AS chunk_id, c.doc_id, d.label, c.text, ts_rank(c.tsv, query) AS score
                         FROM pdf_chunks c JOIN pdf_docs d ON d.id = c.doc_id, websearch_to_tsquery('english', $1) query
                         WHERE c.tsv @@ query ORDER BY score DESC LIMIT $2`, [String(text || ''), limit]);
      if (r.rows.length) return r.rows;
      // websearch syntax is AND by default; fall back to OR across terms.
      const terms = (String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).slice(0, 12).join(' | ');
      if (!terms) return [];
      return (await q(`SELECT c.id AS chunk_id, c.doc_id, d.label, c.text, ts_rank(c.tsv, query) AS score
                       FROM pdf_chunks c JOIN pdf_docs d ON d.id = c.doc_id, to_tsquery('english', $1) query
                       WHERE c.tsv @@ query ORDER BY score DESC LIMIT $2`, [terms, limit])).rows;
    }
    const match = ftsQuery(text);
    if (!match) return [];
    const db = await getSqlite();
    return db.prepare(`SELECT pc.id AS chunk_id, pc.doc_id, pd.label, pc.text, bm25(pdf_chunks_fts) AS score
                       FROM pdf_chunks_fts JOIN pdf_chunks pc ON pc.rowid = pdf_chunks_fts.rowid JOIN pdf_docs pd ON pd.id = pc.doc_id
                       WHERE pdf_chunks_fts MATCH ? ORDER BY score LIMIT ?`).all(match, limit);
  }
};
