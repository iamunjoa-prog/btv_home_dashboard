const express = require('express');
const path = require('path');
const { pool, initSchema } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// 플랫폼이 앱을 /btv-curation-performance 같은 하위 경로에 붙여서 서빙하는 경우를 대비해
// 그 접두사가 붙어 들어오면 벗겨내고 처리한다. 접두사 없이(로컬 개발 등) 오면 그대로 통과.
const BASE_PREFIX = '/btv-curation-performance';
app.use((req, res, next) => {
  if (req.url === BASE_PREFIX || req.url.startsWith(BASE_PREFIX + '/')) {
    req.url = req.url.slice(BASE_PREFIX.length) || '/';
  }
  next();
});

app.use(express.json({ limit: '80mb' }));

/* ═══════════════════════════════════════
   API — 주차별 이벤트 데이터 업로드/조회 (PostgreSQL)
   행 하나 = date+gnb+d1+d2+d3+cid+logcode 조합 (자연키), 같은 조합 재업로드 시 최신값으로 덮어씀
═══════════════════════════════════════ */
const UPLOAD_COLS = 12; // date, week, gnb, d1, d2, d3, cid, cname, logcode, uv, pv, rev
const UPLOAD_BATCH = 500;

app.post('/api/upload', async (req, res) => {
  const rows = req.body && req.body.rows;
  if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'rows required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < rows.length; i += UPLOAD_BATCH) {
      const chunk = rows.slice(i, i + UPLOAD_BATCH);
      const values = [];
      const params = [];
      chunk.forEach((r, idx) => {
        const base = idx * UPLOAD_COLS;
        values.push(`(${Array.from({ length: UPLOAD_COLS }, (_, k) => '$' + (base + k + 1)).join(',')})`);
        params.push(
          r.date, r.week, r.gnb,
          r.d1 || '#', r.d2 || '#', r.d3 || '#',
          r.cid || '', r.cname || '', r.logcode,
          r.uv || 0, r.pv || 0, r.rev || 0
        );
      });
      await client.query(
        `INSERT INTO events (date, week, gnb, d1, d2, d3, cid, cname, logcode, uv, pv, rev)
         VALUES ${values.join(',')}
         ON CONFLICT (date, gnb, d1, d2, d3, cid, logcode)
         DO UPDATE SET cname = EXCLUDED.cname, uv = EXCLUDED.uv, pv = EXCLUDED.pv, rev = EXCLUDED.rev, updated_at = now()`,
        params
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('upload failed', e);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get('/api/rows', async (req, res) => {
  const { start, end, gnb } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });
  try {
    const params = [start, end];
    let sql = `SELECT date::text as date, gnb, d1, d2, d3, cid, cname, logcode, uv, pv, rev
               FROM events WHERE date >= $1 AND date <= $2`;
    if (gnb) { params.push(gnb); sql += ` AND gnb = $${params.length}`; }
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('rows query failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/weeks', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT week, MIN(date)::text as min_date, MAX(date)::text as max_date, COUNT(*)::int as row_count
       FROM events GROUP BY week ORDER BY week`
    );
    res.json(rows);
  } catch (e) {
    console.error('weeks query failed', e);
    res.status(500).json({ error: e.message });
  }
});

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'scheduling-performance.html'));
});

initSchema()
  .then(() => console.log('DB schema ready'))
  .catch(e => console.error('DB schema init failed (app will still serve static files):', e.message));

app.listen(PORT, () => {
  console.log(`BTV Scheduling Performance Dashboard running on port ${PORT}`);
});
