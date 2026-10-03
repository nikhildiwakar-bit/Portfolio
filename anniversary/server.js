// Local test server: static files + mock Nucleus API. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const types = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'};

// Mock Nucleus data (empId -> photo + years)
const employees = {
  '101': { photoUrl: '/mock-photo.svg?n=A', years: 5 },
  '102': { photoUrl: '/mock-photo.svg?n=B', years: 10 }
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/employee') {
    const e = employees[url.searchParams.get('empId')];
    res.writeHead(e ? 200 : 404, {'Content-Type':'application/json'});
    return res.end(JSON.stringify(e || {error:'not found'}));
  }
  if (url.pathname === '/mock-photo.svg') {
    const n = url.searchParams.get('n') || '?';
    res.writeHead(200, {'Content-Type':'image/svg+xml'});
    return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#0C54A0"/><text x="100" y="125" font-size="90" fill="#fff" text-anchor="middle" font-family="sans-serif">${n}</text></svg>`);
  }
  const file = path.join(__dirname, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, {'Content-Type': types[path.extname(file)] || 'application/octet-stream'});
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}/?empId=101`));
