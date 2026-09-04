const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: +(process.env.POSTGRES_PORT || 5432),
  user: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || 'postgres',
  database: process.env.POSTGRES_DB || 'btvcurationperformance',
  max: 5,
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id BIGSERIAL PRIMARY KEY,
      date DATE NOT NULL,
      week TEXT NOT NULL,
      gnb TEXT NOT NULL,
      d1 TEXT NOT NULL DEFAULT '#',
      d2 TEXT NOT NULL DEFAULT '#',
      d3 TEXT NOT NULL DEFAULT '#',
      cid TEXT NOT NULL DEFAULT '',
      cname TEXT NOT NULL DEFAULT '',
      logcode TEXT NOT NULL,
      uv INT NOT NULL DEFAULT 0,
      pv INT NOT NULL DEFAULT 0,
      rev BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (date, gnb, d1, d2, d3, cid, logcode)
    );
    CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
    CREATE INDEX IF NOT EXISTS idx_events_week ON events(week);
    CREATE INDEX IF NOT EXISTS idx_events_gnb ON events(gnb);
  `);
}

module.exports = { pool, initSchema };
