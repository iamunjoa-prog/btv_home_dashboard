const { Pool } = require('pg');

// 클라이언트(scheduling-performance.html)의 getWL()과 동일한 로직 — date -> "YYYY-MM-Wn" 주차 라벨
function getWL(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(), diff = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(d); mon.setUTCDate(d.getUTCDate() + diff);
  const thu = new Date(mon); thu.setUTCDate(mon.getUTCDate() + 3);
  const y = thu.getUTCFullYear(), m = thu.getUTCMonth() + 1;
  const f = new Date(Date.UTC(y, m - 1, 1)), fd = f.getUTCDay(), dt = (4 - fd + 7) % 7;
  const ft = new Date(f); ft.setUTCDate(1 + dt);
  const wn = Math.floor((thu - ft) / (7 * 864e5)) + 1;
  return `${y}-${String(m).padStart(2, '0')}-W${wn}`;
}

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

module.exports = { pool, initSchema, getWL };
