// Server statis lokal untuk menguji folder docs/ (hasil build) tanpa dependensi:
//     node tools\serve-docs.js            -> http://127.0.0.1:8765/
// Hanya untuk uji lokal; produksi tetap GitHub Pages.
var http = require('http'), fs = require('fs'), path = require('path');
var root = path.join(__dirname, '..', 'docs');
var port = Number(process.argv[2]) || 8765;
var types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/plain; charset=utf-8' };
http.createServer(function (req, res) {
  var p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  var f = path.normalize(path.join(root, p));
  if (f.indexOf(root) !== 0) { res.writeHead(403); return res.end(); }
  fs.readFile(f, function (err, data) {
    if (err) { res.writeHead(404); return res.end('404 ' + p); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', function () { console.log('docs/ dilayani di http://127.0.0.1:' + port + '/'); });
