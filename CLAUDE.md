# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two standalone, single-file BTV analytics dashboards. No frontend framework, no bundler, no build step — each is one `.html` file with inline `<style>`/`<script>`, plus a couple of local vendor JS libraries.

- **`index.html`** — "홈 이용 지표 통합 대시보드" (home usage KPI dashboard). Pulls data live from a published Google Sheet (`gviz/tq?tqx=out:csv`) each time it loads. Stable/legacy; not under active development.
- **`scheduling-performance.html`** — "편성 실적 대시보드" (BTV Scheduling Performance dashboard). The active project. Users upload weekly Excel exports; the app parses, aggregates, and accumulates data client-side (IndexedDB), with optional sync to a shared OneDrive-synced folder. This is what most work in this repo touches.

## Running it

No build/test/lint tooling exists in this repo — it's plain HTML/CSS/JS, edited and reloaded directly.

```bash
npm install && npm start        # Express static server (server.js), serves the whole repo root on $PORT (default 3000)
# or, for a quick local check without Node:
python3 -m http.server 8099     # then open http://localhost:8099/scheduling-performance.html
```

`server.js` exists only so the app can be deployed on the internal "SK Broadband playground" PaaS, which requires an Express template (`Diyfile.yaml` — kept in the deployment repo, see below — pins `entrypoint: node server.js`, `port: 3000`). It does nothing but `express.static(__dirname)` plus a `/` → `scheduling-performance.html` route; there is no other backend logic anywhere in this project.

`vendor/` holds `xlsx.full.min.js` (SheetJS) and `chart.umd.js` (Chart.js), copied in from npm rather than loaded from a CDN — the sandbox this was built in blocks cdnjs/jsdelivr outbound, and vendoring also makes the dashboard work offline on a locked-down corporate network. Keep loading these from `vendor/`, not a CDN, when touching the `<script src>` tags.

**Deployment note:** the internal deploy target is a separate GitLab mirror (`team-btv-curation-performance/btv-curation-performance`), not this GitHub repo — pushes here don't auto-deploy. That GitLab repo's `main` also carries platform-specific files this repo doesn't have (`Diyfile.yaml`, `README.md`, `public/stylesheets/`) from an earlier, unrelated app on the same platform slot — preserve those on merge, they're deploy config, not dashboard code.

## `scheduling-performance.html` architecture

Everything lives in one file (~1500 lines): styles, markup, and a single `<script>` block. Reading it top-to-bottom roughly follows this pipeline:

**1. Excel ingest.** `parseExcelFile()` reads the uploaded workbook (SheetJS), auto-detects the header row (looks for `기준일자`), and maps fixed column positions: date, GNB, 1depth, 2depth, 3depth, content ID, content name, event code, event name, UV, PV, revenue. Event codes (`MNIN`/`CTSEL`/`SNSSIN`/`CTPL`/`BUY`/etc., see `LOG_MAP`) form a funnel: 메뉴진입 → 클릭 → 시놉진입 → 재생 → 구매 (`FUNNEL_STEPS`).

**2. Aggregation & storage (`aggregateByWeek`, `upsertWeeks`).** Raw rows are grouped by ISO week (`getWL()`) into two granularities per week:
- `content` — keyed by date+gnb+d1+d2+d3+cid+logcode (keeps content names, used for content ranking / title comparisons)
- `menu` — keyed by date+gnb+d1+d2+d3+logcode (no content names, used for everything else — much smaller)

Both are stored in IndexedDB (`weeksContent`, `weeksMenu`, `meta` object stores — see `openDB()`). Uploading the same week again **overwrites** matching rows (`mergeRows()` — last upload wins), so re-uploading a week to fix bad data is safe and expected. This two-granularity split exists because content-level data for a full year of real traffic would be too large to keep entirely — see the git history / conversation record for the sizing math if that trade-off ever needs revisiting.

**3. Menu tree & the 홈 special case (`effPath`, `buildMenuTree`, `renderMenuTree`).** `effPath(row)` is the single source of truth for "where does this row live in the sidebar tree" — every filter, tree-build, and drill-down table calls it, so it's the one place to change if the tree structure needs to change. For every GNB **except** 홈 it's simply `[gnb, d1, d2]` (skipping `'#'`/empty segments). For **홈**, the raw 1depth is far too fragmented (60+ block names) to browse directly, so `effPath` reclassifies it into 5 fixed sections via `classifyHomeSection()` (keyword rules against the raw d1 string) instead of using the raw value: `Today B tv`, `오늘 핫한 콘텐츠`, `일반 콘텐츠 블록`, `RACE 블록`, `배너 블록` (order fixed in `HOME_SECTIONS`). Within "일반 콘텐츠 블록", MY-family blocks get a small "MY" badge (`isHomeMY()`) rather than their own section. `renderMenuTree()` walks `MENU_TREE` generically/recursively (max depth 3) using `effPath`'s shape, so it needs no GNB-specific branching itself.

GNB display order in the sidebar follows the real product nav (`GNB_ORDER`/`sortGnbKeys()`), not alphabetical.

**4. Navigation model.** The sidebar is a plain clickable tree (no checkboxes) — clicking a label calls `drillInto(path)`, which sets `DRILL_KEY` and `SELECTED_MENU` to that single path and re-renders everything scoped to it; `resetDrill()` (also the "🏠 메인" row) clears back to the overall summary. `filterByMenu()` is the scoping filter everything else composes with — it matches a row if its `effPath` join equals or is a descendant of the current `DRILL_KEY`.

The main (undrilled) view and a drilled-into-a-menu view render different card sets — cross-GNB comparison cards (`#mainOnlySection`: GNB perf table, GNB bar chart, GNB trend chart) only make sense at the top level and are hidden once drilled in; the block-detail table(s) (`renderBlockTable`) only make sense once drilled in, and render 1 or 2 tables depending on how deep the current drill is (down to the 2depth level — deeper than that is a leaf, no further table).

**5. Period selection.** Four modes (`PERIOD_MODE`: day/week/month/custom) all funnel into the same `#dtStart`/`#dtEnd` inputs that `applyFilters()` reads — day and month use native `<input type=date|month>`, week picks from actually-uploaded weeks (`populatePeriodPickers`) and uses that week's real min/max dates rather than computed ISO week boundaries. Every KPI card shows a WoW-style delta automatically, computed against the immediately preceding period of equal length (`computeAutoPrevRange`) unless the manual "기간 비교" toggle (`CMP`) is on, in which case that explicit second range is used instead.

**6. OneDrive folder sync (optional, all in the Settings-modal section of the script).** Uses the File System Access API (`showDirectoryPicker`, Chrome/Edge only — `fsaSupported()` gates everything) to connect a local OneDrive-synced folder. On connect and on every upload, per-week JSON files are written to `content/<week>.json` and `menu/<week>.json` in that folder (`writeWeekToFolder`); on load/reconnect, those files are read back and merged into IndexedDB (`syncFromFolder`). This lets teammates who connect the same OneDrive folder share accumulated data without any backend — IndexedDB stays the single query interface for the rest of the app, the folder is just a sync mirror underneath it. There is no GitHub/GitLab-based sync path in this app; that direction was explored and dropped in favor of OneDrive.

**Metric toggle:** `METRIC` (`'uv'`/`'pv'`) is read by nearly every render function (`sumByCode`, table/chart builders) — it's global and applies everywhere at once, there's no per-card override.
