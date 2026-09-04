# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two BTV analytics dashboards.

- **`index.html`** — "홈 이용 지표 통합 대시보드" (home usage KPI dashboard). Single-file, no backend — pulls data live from a published Google Sheet (`gviz/tq?tqx=out:csv`) each time it loads. Stable/legacy; not under active development.
- **`scheduling-performance.html`** + **`server.js`** + **`db.js`** — "편성 실적 대시보드" (BTV Scheduling Performance dashboard). The active project. Users upload weekly Excel exports through the browser; the server parses nothing itself — the browser parses the Excel client-side (SheetJS) and POSTs rows to a small Express API backed by PostgreSQL. Everyone who opens the dashboard reads from the same DB, so there is no per-user/per-browser data silo. This is what most work in this repo touches.

## Running it

No build/lint/test tooling exists in this repo.

```bash
npm install && npm start
# needs a reachable Postgres — set POSTGRES_HOST/PORT/USER/PASSWORD/DB env vars,
# or just run one locally (see below) and it'll use the localhost fallback defaults in db.js
```

For local dev without touching the real deployment DB, spin up a throwaway Postgres:
```bash
pg_ctlcluster 16 main start   # or however Postgres is installed locally
sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'testpass';"
sudo -u postgres createdb btvcurationperformance
POSTGRES_PASSWORD=testpass npm start
```
`db.js`'s `initSchema()` creates the `events` table itself on startup if it doesn't exist — no separate migration step.

`vendor/` holds `xlsx.full.min.js` (SheetJS) and `chart.umd.js` (Chart.js), copied in from npm rather than loaded from a CDN — the sandbox this was built in blocks cdnjs/jsdelivr outbound, and vendoring also makes the dashboard load fast on a locked-down corporate network. Keep loading these from `vendor/`, not a CDN.

### Deployment

The internal deploy target is a separate GitLab mirror (`team-btv-curation-performance/btv-curation-performance`) on the "SK Broadband playground" internal PaaS, not this GitHub repo — pushes here don't auto-deploy; someone has to pull/merge this branch into that GitLab repo's `main`. That platform:
- Runs the app from `Diyfile.yaml` (`build.entrypoint: ["node","server.js"]`, `build.port: 3000`) — kept in the GitLab repo, not here.
- Serves the app behind a path prefix (`/btv-curation-performance`), which `server.js` strips off at the top of the request pipeline before routing/static-serving — any new route added to `server.js` doesn't need to know about this prefix, the stripping middleware handles it.
- Provisions the Postgres instance separately ("apps/databases" → PostgreSQL template) and injects `POSTGRES_HOST/PORT/USER/PASSWORD/DB` env vars automatically **only if** `Diyfile.yaml`'s `deploy.secrets` references that DB's secret name (e.g. `btvcurationperformance-db-credentials`) — this has to be wired up in `Diyfile.yaml` for the deployed app to actually reach the DB; `db.js` falls back to `localhost`/`postgres`/`postgres` otherwise, which only works for local dev.
- A leftover `ldas-db-credentials` secret reference from an earlier, unrelated app on the same platform slot should **not** be re-added to `deploy.secrets` — it was removed because the app doesn't use that DB and the secret didn't reliably exist, which caused 503s.

## `db.js` / `server.js` — the API

Single table (`events`, defined in `db.js`), one row per `(date, gnb, d1, d2, d3, cid, logcode)` — that natural key is also the table's UNIQUE constraint, so re-uploading the same combination **overwrites** it (last upload wins) via `INSERT ... ON CONFLICT ... DO UPDATE`. `week` (the ISO-ish week label, e.g. `2026-04-W5`) is computed **server-side** from `date` (`getWL()` in `db.js`, duplicating the exact algorithm the browser uses) — the browser doesn't send it, so the two can never disagree.

Endpoints (all in `server.js`):
- `POST /api/upload` — body `{rows: [...]}`, batched upsert (500 rows/statement, one transaction). A full weekly Excel upload can be tens of thousands to ~500K rows; the browser gzip-compresses the JSON body (`CompressionStream`, see `apiPost()` in the HTML) since uncompressed JSON for a big upload can approach 100MB and would otherwise blow past reasonable request-size limits.
- `GET /api/rows/menu?start=&end=&gnb=` — `SUM`s away `cid`/`cname` (GROUP BY date,gnb,d1,d2,d3,logcode) — cheap, used for KPI/funnel/trend/GNB charts/block tables.
- `GET /api/rows/content?start=&end=&gnb=` — raw per-content rows (`cid <> ''`) — used only for the content-ranking table and title-vs-GNB revenue comparison, which need content names.
- `GET /api/menu-tree` — `DISTINCT gnb, d1, d2` across all history — cheap way to (re)build the sidebar tree without pulling every row.
- `GET /api/weeks` — one row per week with `min_date`/`max_date`/`row_count` — feeds the period picker's week dropdown and the "누적 현황" sidebar stat.

There's no need for the old browser-storage-size tradeoffs (content-level detail used to be kept only for a recent rolling window, with older weeks collapsed to menu-level) — a real DB doesn't have that ceiling, so full content-level detail is kept for the whole history.

## `scheduling-performance.html` architecture

Everything client-side lives in one file: styles, markup, and a single `<script>` block. Reading it top-to-bottom roughly follows this pipeline:

**1. Excel ingest.** `parseExcelFile()` reads the uploaded workbook (SheetJS) in the browser, auto-detects the header row (looks for `기준일자`), and maps fixed column positions: date, GNB, 1depth, 2depth, 3depth, content ID, content name, event code, event name, UV, PV, revenue. Event codes (`MNIN`/`CTSEL`/`SNSSIN`/`CTPL`/`BUY`/etc., see `LOG_MAP`) form a funnel: 메뉴진입 → 클릭 → 시놉진입 → 재생 → 구매 (`FUNNEL_STEPS`). `aggregateRows()` sums duplicate natural-key rows client-side before `uploadRows()` POSTs to `/api/upload` (mostly a no-op today since source rows are already unique, but cheap insurance and shrinks the payload if not).

**2. Menu tree & the 홈 special case (`effPath`, `buildMenuTree`, `renderMenuTree`).** `effPath(row)` is the single source of truth for "where does this row live in the sidebar tree" — every filter, tree-build, and drill-down table calls it, so it's the one place to change if the tree structure needs to change. For every GNB **except** 홈 it's simply `[gnb, d1, d2]` (skipping `'#'`/empty segments). For **홈**, the raw 1depth is far too fragmented (60+ block names) to browse directly, so `effPath` reclassifies it into 5 fixed sections via `classifyHomeSection()` (keyword rules against the raw d1 string) instead of using the raw value: `Today B tv`, `오늘 핫한 콘텐츠`, `일반 콘텐츠 블록`, `RACE 블록`, `배너 블록` (order fixed in `HOME_SECTIONS`). Within "일반 콘텐츠 블록", MY-family blocks get a small "MY" badge (`isHomeMY()`) rather than their own section. `renderMenuTree()` walks `MENU_TREE` (built from `/api/menu-tree`) generically/recursively (max depth 3) using `effPath`'s shape, so it needs no GNB-specific branching itself.

GNB display order in the sidebar follows the real product nav (`GNB_ORDER`/`sortGnbKeys()`), not alphabetical.

**3. Navigation model.** The sidebar is a plain clickable tree (no checkboxes) — clicking a label calls `drillInto(path)`, which sets `DRILL_KEY` and `SELECTED_MENU` to that single path and re-renders everything scoped to it; `resetDrill()` (also the "🏠 메인" row) clears back to the overall summary. `filterByMenu()` is the scoping filter everything else composes with — it matches a row if its `effPath` join equals or is a descendant of the current `DRILL_KEY`.

The main (undrilled) view and a drilled-into-a-menu view render different card sets — cross-GNB comparison cards (`#mainOnlySection`: GNB perf table, GNB bar chart, GNB trend chart) only make sense at the top level and are hidden once drilled in; the block-detail table(s) (`renderBlockTable`) only make sense once drilled in, and render 1 or 2 tables depending on how deep the current drill is (down to the 2depth level — deeper than that is a leaf, no further table).

**4. Period selection.** Four modes (`PERIOD_MODE`: day/week/month/custom) all funnel into the same `#dtStart`/`#dtEnd` inputs that `applyFilters()` reads — day and month use native `<input type=date|month>`, week picks from actually-uploaded weeks (`populatePeriodPickers`, backed by `WEEKS_INFO` from `/api/weeks`) and uses that week's real min/max dates rather than computed ISO week boundaries. Every KPI card shows a WoW-style delta automatically, computed against the immediately preceding period of equal length (`computeAutoPrevRange`) unless the manual "기간 비교" toggle (`CMP`) is on, in which case that explicit second range is used instead.

**Metric toggle:** `METRIC` (`'uv'`/`'pv'`) is read by nearly every render function (`sumByCode`, table/chart builders) — it's global and applies everywhere at once, there's no per-card override.

**Settings modal** is now just a DB connection health check (`checkDbStatus()`, hits `/api/weeks`) plus a full-history backup download (`exportBackup()`) — no client-side storage config to manage anymore.
