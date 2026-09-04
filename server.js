const express = require('express');
const path = require('path');

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

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'scheduling-performance.html'));
});

app.listen(PORT, () => {
  console.log(`BTV Scheduling Performance Dashboard running on port ${PORT}`);
});
