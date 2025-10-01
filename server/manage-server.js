const http = require('http');
const fs = require('fs');
const path = require('path');

const { verifyToken, findUserById } = require('./lib/auth');

const PORT = Number(process.env.MANAGE_PORT || 8081);
const HOST = process.env.MANAGE_HOST || '0.0.0.0';

const webBuildDir = path.join(__dirname, '..', 'webapp', 'web-build');
const indexPath = path.join(webBuildDir, 'index.html');

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/manage' || url.pathname === '/manage/' || url.pathname === '/' ) {
      if (!fs.existsSync(indexPath)) {
        res.writeHead(404); res.end('not found'); return;
      }
      // Require token param or Authorization header
      let token = null;
      const authHeader = (req.headers['authorization'] || '') || '';
      const parts = authHeader.split(' ');
      if (parts.length === 2 && /^Bearer$/i.test(parts[0])) token = parts[1];
      if (!token) token = url.searchParams.get('token');
      if (!token) { res.writeHead(401); res.end('missing token'); return; }
      try {
        const claims = verifyToken(token);
        if (!claims) { res.writeHead(401); res.end('invalid token'); return; }
        const u = findUserById(claims.sub);
        if (!u) { res.writeHead(401); res.end('unauthorized'); return; }
        if (!(Number(u.is_admin) === 1 || u.role === 'manager')) { res.writeHead(403); res.end('forbidden'); return; }
      } catch (e) { res.writeHead(401); res.end('invalid token'); return; }

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(indexPath).pipe(res);
      return;
    }

    // Serve static assets under the web-build
    const rel = decodeURIComponent(url.pathname.replace(/^?\//, ''));
    const filePath = path.join(webBuildDir, rel);
    if (filePath.startsWith(webBuildDir) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404); res.end('not found');
  } catch (e) { res.writeHead(500); res.end('server error'); }
});

server.listen(PORT, HOST, () => console.log('manage-server listening on', HOST + ':' + PORT));

module.exports = server;
