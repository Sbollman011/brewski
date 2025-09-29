const fs = require('fs');
const path = require('path');

const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAn0B9h3RK1MAAAAASUVORK5CYII=';
const buf = Buffer.from(b64, 'base64');
const assets = ['icon.png','adaptive-icon.png','favicon.png'];
const dir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
assets.forEach(f => {
  const p = path.join(dir, f);
  try { fs.writeFileSync(p, buf); console.log('Wrote', p); } catch (e) { console.error('Failed to write', p, e.message); }
});

console.log('Done');
