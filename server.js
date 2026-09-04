const express = require('express');
const path = require('path');
const { pool, initSchema, getWL } = require('./db');

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

app.use(express.json({ limit: '150mb' })); // body-parser inflates gzip (Content-Encoding: gzip) automatically

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
          r.date, getWL(r.date), r.gnb,
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

// 메뉴 단위(콘텐츠 무시하고 date+gnb+d1+d2+d3+logcode로 합산) — KPI/퍼널/차트/블록표용, 가벼움
app.get('/api/rows/menu', async (req, res) => {
  const { start, end, gnb } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });
  try {
    const params = [start, end];
    let sql = `SELECT date::text as date, gnb, d1, d2, d3, logcode,
                      SUM(uv)::int as uv, SUM(pv)::int as pv, SUM(rev)::bigint as rev
               FROM events WHERE date >= $1 AND date <= $2`;
    if (gnb) { params.push(gnb); sql += ` AND gnb = $${params.length}`; }
    sql += ` GROUP BY date, gnb, d1, d2, d3, logcode`;
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('menu rows query failed', e);
    res.status(500).json({ error: e.message });
  }
});

// 콘텐츠 단위(cid/cname 포함, 원본 그대로) — 콘텐츠 랭킹/타이틀 비교용
app.get('/api/rows/content', async (req, res) => {
  const { start, end, gnb } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });
  try {
    const params = [start, end];
    let sql = `SELECT date::text as date, gnb, d1, d2, d3, cid, cname, logcode, uv, pv, rev
               FROM events WHERE date >= $1 AND date <= $2 AND cid <> ''`;
    if (gnb) { params.push(gnb); sql += ` AND gnb = $${params.length}`; }
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error('content rows query failed', e);
    res.status(500).json({ error: e.message });
  }
});

// 사이드바 메뉴 트리 구성용 — 전체 기간의 gnb/d1/d2 조합만(날짜·이벤트 무시), 훨씬 작음
app.get('/api/menu-tree', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT DISTINCT gnb, d1, d2 FROM events`);
    res.json(rows);
  } catch (e) {
    console.error('menu-tree query failed', e);
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
