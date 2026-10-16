// Small static server with HTTP Range support, for previewing the portfolio locally.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const port = +(process.argv[3] || 5395);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.json': 'application/json', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); }
  catch { res.writeHead(400); return res.end(); }
  if (rel.includes('\0')) { res.writeHead(400); return res.end(); }
  const file = path.resolve(root, '.' + (rel === '/' ? '/index.html' : rel));
  const relative = path.relative(root, file);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    const type = types[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    const send = (status, extra, start, end) => {
      res.writeHead(status, { ...headers, ...extra });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file, { start, end });
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    };
    if (range) {
      const start = range[1] ? +range[1] : Math.max(0, st.size - +range[2]);
      const end = range[1] && range[2] ? Math.min(+range[2], st.size - 1) : st.size - 1;
      if ((!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= st.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` }); return res.end();
      }
      send(206, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 }, start, end);
    } else {
      send(200, { 'Content-Length': st.size });
    }
  });
}).listen(port, () => console.log('serving', root, 'on', port));
