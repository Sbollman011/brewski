#!/usr/bin/env node
/*
  Minimal smoke test:
   1. Starts the composed server on an ephemeral port (override QUICK_MQTT_WS_PORT)
   2. Hits /health
   3. Registers a test user (if not already) and logs in
   4. Opens a WebSocket (no auth or using BRIDGE_TOKEN/JWT if available)
   5. Prints a small summary then exits
*/

const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

(async () => {
  const testPort = 19080 + Math.floor(Math.random() * 1000);
  // Force plain HTTP for local smoke by providing non-existent cert paths
  const env = { ...process.env, QUICK_MQTT_WS_PORT: String(testPort), QUICK_MQTT_CERT: '/nonexistent-cert.pem', QUICK_MQTT_KEY: '/nonexistent-key.pem' };
  const serverPath = path.join(__dirname, '..', 'bin', 'server.js');
  const child = spawn(process.execPath, [serverPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = false;
  child.stdout.on('data', d => {
    const line = d.toString();
    process.stdout.write('[server] ' + line);
    if (!ready && line.includes('http-server listening')) {
      ready = true;
      run();
    }
  });
  child.stderr.on('data', d => process.stderr.write('[server-err] ' + d.toString()));

  function wait(ms){ return new Promise(r=>setTimeout(r,ms)); }

  async function fetchJson(pathname, opts={}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: testPort, path: pathname, method: opts.method||'GET', headers: opts.headers||{} }, res => {
        let body=''; res.on('data',c=>body+=c); res.on('end',()=>{ try { resolve({ status: res.statusCode, json: JSON.parse(body||'{}') }); } catch(e){ resolve({ status: res.statusCode, body }); } });
      });
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  async function run() {
    try {
      const health = await fetchJson('/health');
      console.log('[smoke] /health =>', health.status, health.json || health.body);

      const uname = 'testuser_' + Date.now();
      const reg = await fetchJson('/admin/api/register', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ username: uname, password: 'testpass123' }) });
      console.log('[smoke] register =>', reg.status);

      const login = await fetchJson('/admin/api/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ username: uname, password: 'testpass123' }) });
      console.log('[smoke] login =>', login.status, login.json && login.json.token ? 'token received' : 'no token');
      const jwt = login.json && login.json.token;

      await wait(300);
      const wsUrl = `ws://127.0.0.1:${testPort}`;
      const headers = jwt ? { Authorization: 'Bearer ' + jwt } : {};
      const ws = new WebSocket(wsUrl, { headers });
      let first = true;
      ws.on('message', data => {
        if (first) {
          console.log('[smoke] first WS frame length', data.length);
          first = false;
          ws.close();
        }
      });
      ws.on('open', () => console.log('[smoke] ws open'));
      ws.on('close', () => {
        console.log('[smoke] ws closed');
        shutdown(0);
      });
      ws.on('error', err => { console.error('[smoke] ws error', err && err.message); shutdown(1); });
      setTimeout(()=>{ if (first) { console.log('[smoke] no WS frame received in time'); shutdown(1); } }, 4000);
    } catch (e) {
      console.error('[smoke] error', e);
      shutdown(1);
    }
  }

  function shutdown(code){ try { child.kill(); } catch(e){} setTimeout(()=>process.exit(code), 200); }
})();
