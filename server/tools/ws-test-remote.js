#!/usr/bin/env node
// Simple WebSocket TLS tester for a remote WSS endpoint.
// Usage: node ws-test-remote.js [url]
// Example: node ws-test-remote.js wss://appli.railbrewouse.com/ws


const WebSocket = require('ws');
const dns = require('dns');
const { URL } = require('url');

// pick the first non-flag argument as URL (so `--ipv4` can be used)
const argv = process.argv.slice(2);
const rawArg = argv.find(a => !a.startsWith('-')) || 'wss://appli.railbrewouse.com/ws';
const preferIPv4 = argv.includes('--ipv4') || process.env.WS_TEST_IPV4 === '1';
// optional SNI and Host header overrides when connecting to an IP
const sniFlag = (() => {
  const m = argv.find(a => a.startsWith('--sni='));
  return m ? m.split('=')[1] : null;
})();
const hostHeaderFlag = (() => {
  const m = argv.find(a => a.startsWith('--host-header='));
  return m ? m.split('=')[1] : null;
})();

async function connect() {
  const parsed = new URL(rawArg);
  console.log('[ws-test] attempting connect to', rawArg, preferIPv4 ? '(forcing IPv4)' : '');

  const defaultOpts = {
    // Allow self-signed or proxied certs for initial diagnostics; change to false in production.
    rejectUnauthorized: false,
    handshakeTimeout: 5000,
    // set servername for SNI if we connect to an IP
    servername: parsed.hostname,
    headers: {
      Host: parsed.hostname,
    }
  };

  if (!preferIPv4) {
    // if sni/hostHeader overrides provided, apply them
    if (sniFlag) defaultOpts.servername = sniFlag;
    if (hostHeaderFlag) defaultOpts.headers.Host = hostHeaderFlag;
    const ws = new WebSocket(rawArg, defaultOpts);
    attachListeners(ws);
    return;
  }

  // resolve A record and connect to IPv4 address, preserving Host/SNI
  dns.lookup(parsed.hostname, { family: 4 }, (err, address, family) => {
    if (err) {
      console.error('[ws-test] dns.lookup error:', err && err.message);
      process.exit(2);
    }
  const hostUrl = `${parsed.protocol}//${address}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}${parsed.search}`;
  // ensure the ws constructor knows SNI and Host header
  const opts = Object.assign({}, defaultOpts, { servername: sniFlag || parsed.hostname });
  if (hostHeaderFlag) opts.headers = Object.assign({}, opts.headers, { Host: hostHeaderFlag });
  console.log('[ws-test] resolved IPv4', address, 'connecting to', hostUrl, 'with SNI', opts.servername, 'Host header', opts.headers && opts.headers.Host);
  const ws = new WebSocket(hostUrl, opts);
    attachListeners(ws);
  });
}

function attachListeners(ws) {
  ws.on('open', () => {
    console.log('[ws-test] open - connection established');
    try {
      ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));
      console.log('[ws-test] sent hello payload');
    } catch (e) {
      console.log('[ws-test] send error', e && e.message);
    }
  });

  ws.on('message', (data) => {
    console.log('[ws-test] message:', String(data).slice(0, 200));
  });

  ws.on('close', (code, reason) => {
    console.log('[ws-test] close', code, reason && reason.toString());
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('[ws-test] error:', err && err.message);
    if (err && err.stack) console.error(err.stack.split('\n').slice(0,6).join('\n'));
    process.exit(2);
  });
}

connect();

