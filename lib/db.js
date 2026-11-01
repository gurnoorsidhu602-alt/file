// lib/db.js
// Optional Postgres. When DATABASE_URL is set (e.g. a Render Postgres
// instance), case sessions, Med Learner progress, PDF search and AI usage are
// stored here. Without it the app falls back to Upstash Redis + local SQLite,
// exactly as before, so deploying this code never requires a database first.

import pg from 'pg';

const url = process.env.DATABASE_URL || '';

function sslFor(u) {
  if (process.env.PGSSLMODE === 'disable') return false;
  // Render's internal URLs (no domain) don't use TLS; external ones do.
  return /\.render\.com|sslmode=require/.test(u) ? { rejectUnauthorized: false } : false;
}

export const pool = url ? new pg.Pool({ connectionString: url, ssl: sslFor(url), max: Number(process.env.PG_POOL_MAX || 5) }) : null;
export const hasPg = () => !!pool;

export async function q(text, params = []) {
  if (!pool) throw new Error('Postgres not configured');
  return pool.query(text, params);
}

export async function migrate() {
  if (!pool) return false;
  await q(`
    CREATE TABLE IF NOT EXISTS case_sessions (
      id          text PRIMARY KEY,
      user_id     text NOT NULL,
      version     integer NOT NULL DEFAULT 1,
      title       text,
      complaint   text,
      mode        text,
      difficulty  text,
      concluded   boolean NOT NULL DEFAULT false,
      data        jsonb NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS case_sessions_user_idx ON case_sessions (user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS completed_topics (
      user_id    text NOT NULL,
      topic      text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, topic)
    );

    CREATE TABLE IF NOT EXISTS pdf_docs (
      id         text PRIMARY KEY,
      label      text UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pdf_chunks (
      id     text PRIMARY KEY,
      doc_id text NOT NULL REFERENCES pdf_docs(id) ON DELETE CASCADE,
      ord    integer NOT NULL,
      text   text NOT NULL,
      tsv    tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
    );
    CREATE INDEX IF NOT EXISTS pdf_chunks_tsv_idx ON pdf_chunks USING gin (tsv);

    CREATE TABLE IF NOT EXISTS ai_usage (
      id               bigserial PRIMARY KEY,
      at               timestamptz NOT NULL DEFAULT now(),
      tag              text,
      model            text,
      ok               boolean,
      input_tokens     integer,
      cached_tokens    integer,
      output_tokens    integer,
      reasoning_tokens integer,
      ms               integer,
      cost_usd         numeric,
      session_id       text,
      user_id          text
    );
    CREATE INDEX IF NOT EXISTS ai_usage_at_idx ON ai_usage (at DESC);
    CREATE INDEX IF NOT EXISTS ai_usage_session_idx ON ai_usage (session_id);
  `);
  return true;
}
