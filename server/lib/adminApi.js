const fs = require('fs');
// Small helper to safely write a response only if headers haven't been sent yet.
function safeSend(res, status, body, contentType) {
  try {
    if (!res || res.headersSent || res.writableEnded) return;
    const headers = {};
    if (contentType) headers['Content-Type'] = contentType;
    else headers['Content-Type'] = (typeof body === 'string') ? 'text/plain' : 'application/json';
    res.writeHead(status, headers);
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  } catch (e) {
    try { console.error('safeSend error', e && e.message); } catch (e) {}
  }
}
const { createUser, findUserByUsername, verifyPassword, signToken, verifyToken, findUserById, updateUserById, updateUserFieldsByUsername } = require('./auth');

function parseBodyJson(req, res, cb) {
  let body = '';
  let called = false;
  const done = (err, obj) => {
    if (called) return;
    called = true;
    try { cb(err, obj); } catch (e) { /* swallow callback errors to avoid crashing outer handler */ }
  };
  req.on('data', c => { try { body += c; } catch (e) {} });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}');
      done(null, parsed);
    } catch (e) {
      done(new Error('bad_json'));
    }
  });
  req.on('error', err => done(err));
}

function effectiveBridgeToken() {
  if (process.env.DISABLE_BRIDGE_TOKEN === '1') return null;
  return process.env.BRIDGE_TOKEN || null;
}

function extractBearerToken(req, url) {
  const authHeader = (req.headers && (req.headers['authorization'] || '')) || '';
  const parts = authHeader.split(' ');
  if (parts.length === 2 && /^Bearer$/i.test(parts[0])) return parts[1];
  // fallback to query param
  try { return url.searchParams && url.searchParams.get('token'); } catch(e) { return null; }
}

// Canonicalize incoming topic strings into SITE/DEVICE/STATE
// - strip leading tele/ or stat/
// - remove any trailing STATE token(s)
// - default site to BREW when omitted
// - uppercase site/device
function canonicalizeTopic(raw) {
  try {
    if (!raw) return raw;
    let s = String(raw).trim();
    s = s.replace(/^(tele|stat)\//i, '');
    const parts = s.split('/').filter(Boolean).map(p => String(p).toUpperCase());
    // remove trailing STATE tokens if present
    while (parts.length && parts[parts.length - 1] === 'STATE') parts.pop();
    if (parts.length === 0) return raw;
    // Do not default to BREW. Require explicit site. Single-segment topics are legacy and considered invalid here.
    let site = null;
    let device = '';
    if (parts.length === 1) {
      // No explicit site provided; treat as unscoped/invalid for canonicalization
      return null;
    } else {
      site = parts[0] || null;
      device = parts[1] || '';
    }
    site = site ? String(site).toUpperCase() : null;
    device = String(device).toUpperCase();
    if (!site) return null;
    return `${site}/${device}/STATE`;
  } catch (e) { return raw; }
}

function handleAdminApi(req, res, url) {
  // url is a URL instance
  try {
    if (url.pathname === '/admin/api/register' && req.method === 'POST') {
      parseBodyJson(req, res, (err, obj) => {
        if (err) { res.writeHead(500); res.end('server error'); return; }
        if (!obj.username || !obj.password) { res.writeHead(400); res.end('username,password required'); return; }
        const existing = findUserByUsername(obj.username);
        if (existing) { res.writeHead(409); res.end('username exists'); return; }
        const u = createUser(obj.username, obj.password);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, user: { id: u.id, username: u.username } }));
      });
      return true;
    }

    if (url.pathname === '/admin/api/login' && req.method === 'POST') {
      parseBodyJson(req, res, (err, obj) => {
        if (err) { res.writeHead(500); res.end('server error'); return; }
        if (!obj.username || !obj.password) { res.writeHead(400); res.end('username,password required'); return; }
        const user = findUserByUsername(obj.username);
        if (!user || !verifyPassword(user, obj.password)) { res.writeHead(401); res.end('invalid'); return; }
        const token = signToken({ sub: user.id, username: user.username });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, token }));
      });
      return true;
    }

    // Forgot password: POST { email } (accepts email OR username if username is an email address)
    if (url.pathname === '/admin/api/forgot' && req.method === 'POST') {
      parseBodyJson(req, res, async (err, obj) => {
        if (err) { res.writeHead(400); res.end('bad json'); return; }
        const raw = (obj && (obj.email || obj.username)) ? String(obj.email || obj.username).trim() : '';
        if (!raw) { res.writeHead(400); res.end('email required'); return; }
        console.log('[password-reset] forgot requested for identifier=', raw);

        const { findUserByEmail, findUserByUsername, updateUserEmailByUsername, signToken } = require('./auth');
        let user = findUserByEmail(raw);
        let targetEmail = raw;

        // If no user by email, try interpreting the value as a username.
        if (!user) {
          const u2 = findUserByUsername(raw);
            if (u2) {
              user = u2;
              // If the provided identifier looks like an email and the user record lacks an email, persist it for future resets.
              if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) {
                try { updateUserEmailByUsername(u2.username, raw); console.log('[password-reset] persisted email for user', u2.username); } catch (e) {}
              }
            }
        }

        if (user) {
          try {
            const token = signToken({ sub: user.id, username: user.username, purpose: 'reset' }, { expiresIn: '15m' });
            const { sendResetEmail } = require('./mailer');
            let ok = false;
            try {
              ok = await sendResetEmail(user.email || targetEmail, token);
            } catch (e) {
              console.error('[password-reset] sendResetEmail threw', e && e.stack ? e.stack : e);
            }
            if (!ok) {
              console.log('[password-reset] (fallback) token for', targetEmail, '->', token);
            }
            // Append to local log for auditing / manual resend
            try {
              const logPath = process.env.RESET_LOG_PATH || '/tmp/brewski-reset.log';
              const line = `${new Date().toISOString()} ${String(targetEmail)} ${String(token)}\n`;
              fs.appendFileSync(logPath, line, { encoding: 'utf8' });
              console.log('[password-reset] appended token to', logPath);
            } catch (e) {
              console.error('[password-reset] failed to write token log', e && e.stack ? e.stack : e);
            }
          } catch (e) {
            console.error('[password-reset] unexpected error building token', e && e.stack ? e.stack : e);
          }
        } else {
          // Still log that a non-matching identifier attempted a reset (without revealing existence to client)
          console.log('[password-reset] no matching user for identifier');
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return true;
    }

    // Reset password: POST { token, newPassword }
    if (url.pathname === '/admin/api/reset' && req.method === 'POST') {
      parseBodyJson(req, res, (err, obj) => {
        if (err) { res.writeHead(400); res.end('bad json'); return; }
        const token = (obj && obj.token) ? String(obj.token) : '';
        const newPassword = (obj && obj.newPassword) ? String(obj.newPassword) : '';
        if (!token || !newPassword) { res.writeHead(400); res.end('token and newPassword required'); return; }
        const { verifyToken, updateUserPasswordById } = require('./auth');
        const claims = verifyToken(token);
        if (!claims || claims.purpose !== 'reset') { res.writeHead(400); res.end('invalid or expired token'); return; }
        const ok = updateUserPasswordById(claims.sub, newPassword);
        if (!ok) { res.writeHead(500); res.end('could not update password'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      });
      return true;
    }

    // For other /admin/api/* endpoints, enforce JWT auth for sensitive operations.
    // Register and login endpoints above remain public.
    const sensitivePaths = ['/admin/api/thresholds/update', '/admin/api/push/direct', '/admin/api/publish', '/admin/api/register-push', '/admin/api/push/test'];
    // If request matches one of the sensitive paths or any other admin API, require a valid JWT.
    const needsAuth = url.pathname.startsWith('/admin/api/') && url.pathname !== '/admin/api/register' && url.pathname !== '/admin/api/login';
    if (needsAuth) {
      const token = extractBearerToken(req, url);
      // allow legacy BRIDGE_TOKEN for compatibility (treat it as equivalent to a JWT)
      if (!token) {
        // no token provided
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing_token' }));
        return true;
      }
      // If token equals the BRIDGE_TOKEN env var, accept it as privileged
      const BRIDGE = effectiveBridgeToken();
      if (BRIDGE && token === BRIDGE) {
        req.user = { id: 'bridge', username: 'bridge-token' };
        return false; // allow handling to continue in main server
      }
      const claims = verifyToken(token);
      if (!claims) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return true;
      }
      req.user = { id: claims.sub, username: claims.username };
    }

    // --- POWER LABELS ENDPOINTS ---
    // GET /admin/api/power-labels?topic=...&customer_id=...  (list labels, admins can specify customer_id or see all)
    if (url.pathname === '/admin/api/power-labels' && req.method === 'GET') {
      try {
        const { findUserById } = require('./auth');
        const me = findUserById(req.user.id);
        if (!me) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
        const Database = require('better-sqlite3');
        const path = require('path');
        const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
        const db = new Database(DB_PATH);
        const topic = url.searchParams.get('topic');
        const requestedCustomerId = url.searchParams.get('customer_id');
        
        let rows;
        const isAdmin = Number(me.is_admin) === 1;
        
        if (isAdmin && !requestedCustomerId) {
          // Admin requesting all labels across all customers
          if (topic) {
            rows = db.prepare('SELECT id, customer_id, topic, power_key, label, created_at, updated_at FROM power_labels WHERE topic = ? ORDER BY customer_id, topic, power_key').all(topic);
          } else {
            rows = db.prepare('SELECT id, customer_id, topic, power_key, label, created_at, updated_at FROM power_labels ORDER BY customer_id, topic, power_key').all();
          }
        } else if (isAdmin && requestedCustomerId) {
          // Admin requesting labels for specific customer
          const customerId = Number(requestedCustomerId);
          if (topic) {
            rows = db.prepare('SELECT id, customer_id, topic, power_key, label, created_at, updated_at FROM power_labels WHERE customer_id = ? AND topic = ? ORDER BY topic, power_key').all(customerId, topic);
          } else {
            rows = db.prepare('SELECT id, customer_id, topic, power_key, label, created_at, updated_at FROM power_labels WHERE customer_id = ? ORDER BY topic, power_key').all(customerId);
          }
        } else {
          // Regular user - only their own customer's labels
          if (!me.customer_id) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
          if (topic) {
            rows = db.prepare('SELECT id, customer_id, topic, power_key, label, created_at, updated_at FROM power_labels WHERE customer_id = ? AND topic = ? ORDER BY topic, power_key').all(me.customer_id, topic);
          } else {
            rows = db.prepare('SELECT id, customer_id, topic, power_key, label, created_at, updated_at FROM power_labels WHERE customer_id = ? ORDER BY topic, power_key').all(me.customer_id);
          }
        }
        // Normalize topics and dedupe by customer/topic/power_key in-memory so clients
        // receive a single canonical mapping per customer/topic/power_key even if the
        // DB contains legacy or duplicate variants.
        // use canonicalizeTopic helper

        const dedupeMap = new Map();
        for (const r of rows) {
          try {
            const canon = canonicalizeTopic(r.topic);
            const pk = String(r.power_key || '').toUpperCase();
            const cid = Number(r.customer_id) || 0;
            const key = `${cid}|${canon}|${pk}`;
            const existing = dedupeMap.get(key);
            if (!existing) dedupeMap.set(key, Object.assign({}, r, { topic: canon, power_key: pk }));
            else {
              // prefer the most recently-updated row
              const exUpdated = Number(existing.updated_at) || 0;
              const curUpdated = Number(r.updated_at) || 0;
              if (curUpdated > exUpdated) dedupeMap.set(key, Object.assign({}, r, { topic: canon, power_key: pk }));
            }
          } catch (e) { /* ignore per-row errors */ }
        }
        const out = Array.from(dedupeMap.values());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, labels: out }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
      return true;
    }

    // POST /admin/api/power-labels  (create or update a label)
    if (url.pathname === '/admin/api/power-labels' && req.method === 'POST') {
      parseBodyJson(req, res, (err, obj) => {
        if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_json' })); return; }
        let { topic, power_key, label, customer_id } = obj || {};
        if (!topic || !power_key) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing_fields' })); return; }
        // Normalize incoming topic to a canonical stored form to avoid duplicates and
        // make client lookups reliable. Rules (best-effort):
        //  - strip leading tele/ or stat/ prefixes
        //  - ensure stored format is SITE/DEVICE/STATE
        //  - if incoming topic lacks site, default to BREW
          // canonicalize incoming topic using helper
          try { topic = canonicalizeTopic(topic); } catch (e) { /* fallback: leave original */ }
        try {
          // Lightweight diagnostic logging to help correlate client-side failures
          // with proxy/origin logs. Avoid logging full request bodies or tokens.
          try {
            const originHdr = req.headers && (req.headers.origin || req.headers.referer) ? (req.headers.origin || req.headers.referer) : '<none>';
            const remote = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '<unknown>';
            console.log('[admin-api] POST /admin/api/power-labels ARRIVAL origin=', originHdr, 'remote=', remote, 'body_customer_id=', customer_id ? customer_id : '<none>', 'topic=', topic, 'power_key=', power_key);
          } catch (e) { /* ignore logging errors */ }
          const { findUserById } = require('./auth');
          const me = findUserById(req.user.id);
          if (!me) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
          const Database = require('better-sqlite3');
          const path = require('path');
          const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
          const db = new Database(DB_PATH);
          const now = Date.now();
          
          // Determine target customer ID
          let targetCustomerId;
          if (Number(me.is_admin) === 1 && customer_id) {
            // Admin can specify customer_id
            targetCustomerId = Number(customer_id);
          } else {
            // Regular users use their own customer_id
            if (!me.customer_id) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
            targetCustomerId = me.customer_id;
          }
          
          // Upsert (insert or update) using the canonicalized topic
          // Guard: if the incoming label is blank/whitespace and an existing non-empty
          // label already exists for an equivalent canonical topic for this customer
          // and power_key, avoid overwriting it. We consider topic variants (tele/..,
          // BREW vs org-slug) equivalent by canonicalizing stored topics and comparing
          // to the incoming canonical topic.
          const incomingLabel = (label || '') + '';
          const isIncomingBlank = incomingLabel.trim().length === 0;
          if (isIncomingBlank) {
            try {
              // Fetch candidate rows for this customer and power_key (case-insensitive)
              const candidates = db.prepare('SELECT id, topic, power_key, label FROM power_labels WHERE customer_id = ? AND UPPER(power_key) = UPPER(?)').all(targetCustomerId, power_key);
              if (Array.isArray(candidates) && candidates.length) {
                // Compare canonical forms rather than raw topic strings to detect
                // equivalent variants stored under different prefixes.
                const incomingCanon = topic;
                // Helper: extract device segment from a canonical topic like SITE/DEVICE[/...]
                const deviceFromCanon = (canon) => {
                  try {
                    if (!canon) return null;
                    const parts = String(canon).split('/').filter(Boolean);
                    if (!parts.length) return null;
                    // If canonical includes SITE/DEVICE[/...], device is second segment
                    if (parts.length >= 2) return String(parts[1]).toUpperCase();
                    // Otherwise single-token topic, treat that as device
                    return String(parts[0]).toUpperCase();
                  } catch (e) { return null; }
                };

                const incomingDevice = deviceFromCanon(incomingCanon);

                for (const r of candidates) {
                  try {
                    const storedCanon = canonicalizeTopic(r.topic);
                    if (!storedCanon) continue;
                    // Exact canonical match (same SITE/DEVICE/STATE) — previous behavior
                    if (String(storedCanon).toUpperCase() === String(incomingCanon).toUpperCase()) {
                      if (r.label && String(r.label).trim().length > 0) {
                        try { console.log('[admin-api] SKIP blank label upsert due to existing canonical match with non-empty label user=', me && me.username ? me.username : me && me.id ? me.id : '<unknown>', 'customer=', targetCustomerId, 'topic=', topic, 'power_key=', power_key, 'stored_id=', r.id); } catch (e) {}
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true, skipped: true }));
                        try { db.close && db.close(); } catch (e) {}
                        return;
                      }
                    }

                    // If canonical differs only by SITE (e.g., BREW vs RAIL) but the device
                    // segment is the same and an existing non-empty label exists, skip to
                    // avoid overwriting user-set labels stored under site-variant topics.
                    try {
                      const storedDevice = deviceFromCanon(storedCanon);
                      // Also consider site tokens — avoid matching when either site is the legacy NOSITE
                      const storedSite = (String(storedCanon || '').split('/')[0] || '').toUpperCase();
                      const incomingSiteToken = (String(incomingCanon || '').split('/')[0] || '').toUpperCase();
                      const bothSitesKnown = storedSite && incomingSiteToken && storedSite !== 'NOSITE' && incomingSiteToken !== 'NOSITE';
                      if (incomingDevice && storedDevice && incomingDevice === storedDevice && bothSitesKnown) {
                        if (r.label && String(r.label).trim().length > 0) {
                          try { console.log('[admin-api] SKIP blank label upsert due to existing per-device match with non-empty label user=', me && me.username ? me.username : me && me.id ? me.id : '<unknown>', 'customer=', targetCustomerId, 'topic=', topic, 'power_key=', power_key, 'stored_id=', r.id, 'stored_topic=', r.topic); } catch (e) {}
                          res.writeHead(200, { 'Content-Type': 'application/json' });
                          res.end(JSON.stringify({ ok: true, skipped: true }));
                          try { db.close && db.close(); } catch (e) {}
                          return;
                        }
                      }
                    } catch (e) { /* non-fatal per-row */ }
                  } catch (e) { /* per-row error non-fatal */ }
                }
              }
            } catch (e) {
              try { console.error('[admin-api] error checking existing labels before blank-upsert guard', e && e.message); } catch (e) {}
              // Fall through to normal upsert if the check fails
            }
          }

          const info = db.prepare('INSERT INTO power_labels (customer_id, topic, power_key, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(customer_id, topic, power_key) DO UPDATE SET label=excluded.label, updated_at=excluded.updated_at').run(targetCustomerId, topic, power_key, label, now, now);
          // Log successful persistence for correlation with proxy/tunnel logs
          try {
            const remote = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '<unknown>';
            console.log('[admin-api] POST /admin/api/power-labels PERSISTED user=', me && me.username ? me.username : me && me.id ? me.id : '<unknown>', 'target_customer=', targetCustomerId, 'topic=', topic, 'power_key=', power_key, 'changes=', info && info.changes ? info.changes : 0, 'remote=', remote);
          } catch (e) { /* ignore logging errors */ }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
      });
      return true;
    }

    // DELETE /admin/api/power-labels  (delete a label mapping)
    if (url.pathname === '/admin/api/power-labels' && req.method === 'DELETE') {
      parseBodyJson(req, res, (err, obj) => {
        if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_json' })); return; }
        let { topic, power_key, customer_id, customer_slug } = obj || {};
        if (!topic || !power_key) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing_fields' })); return; }
        try {
          const { findUserById } = require('./auth');
          const me = findUserById(req.user.id);
          if (!me) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
          const Database = require('better-sqlite3');
          const path = require('path');
          const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
          const db = new Database(DB_PATH);

          // Normalize incoming topic to the canonical stored form (same rules as POST)
          const canonicalTopic = canonicalizeTopic(topic);

          // Determine target customer id. Admins may provide customer_id or customer_slug
          let targetCustomerId = null;
          if (Number(me.is_admin) === 1) {
            if (customer_id) targetCustomerId = Number(customer_id);
            else if (customer_slug) {
              const row = db.prepare('SELECT id FROM customers WHERE slug = ? LIMIT 1').get(String(customer_slug));
              if (row && row.id) targetCustomerId = Number(row.id);
            }
          }
          if (!targetCustomerId) {
            // fallback to requester's customer (managers/users)
            if (!me.customer_id) {
              res.writeHead(401, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'unauthorized' }));
              return;
            }
            targetCustomerId = Number(me.customer_id);
          }

          // Delete any rows for this customer where the normalized/canonical topic equals the requested canonical topic
          const pkUp = String(power_key).toUpperCase();
          // Fetch candidate rows for this customer and power_key (match case-insensitive)
          const candidates = db.prepare('SELECT id, topic, power_key FROM power_labels WHERE customer_id = ?').all(targetCustomerId);
          // reuse canonicalizeTopic for per-row normalization
          // Consider equivalent canonical topics where site token may differ
          const swapSite = (t) => {
            try {
              if (!t || typeof t !== 'string') return t;
              if (t.startsWith('BREW/')) return t.replace(/^BREW\//, 'RAIL/');
              if (t.startsWith('RAIL/')) return t.replace(/^RAIL\//, 'BREW/');
              return t;
            } catch (e) { return t; }
          };

          const targets = new Set();
          targets.add(String(canonicalTopic));
          try { targets.add(String(swapSite(canonicalTopic))); } catch (e) {}

          let deletedCount = 0;
          for (const row of candidates) {
            try {
              const rowPkUp = String(row.power_key || '').toUpperCase();
              if (rowPkUp !== pkUp) continue;
              const norm = canonicalizeTopic(row.topic);
              if (targets.has(String(norm))) {
                const info = db.prepare('DELETE FROM power_labels WHERE id = ?').run(row.id);
                if (info && info.changes) deletedCount += Number(info.changes);
              }
            } catch (e) { /* ignore per-row errors */ }
          }
          // Log deletion count for diagnostics
          try { console.log('[admin-api] DELETE /admin/api/power-labels deleted_count=', deletedCount, 'customer=', targetCustomerId, 'canonical_topic=', canonicalTopic, 'power_key=', pkUp); } catch (e) {}
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
      });
      return true;
    }

      // If the route is /admin/api/me return current user info
      if (url.pathname === '/admin/api/me' && req.method === 'GET') {
        try {
          const { findUserById } = require('./auth');
          const u = findUserById(req.user.id);
          if (!u) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, user: { id: u.id, username: u.username, email: u.email, customer_id: u.customer_id, role: u.role, is_admin: u.is_admin } }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' })); }
        return true;
      }

      // Admin-only: create customer
      if (url.pathname === '/admin/api/customers' && req.method === 'POST') {
        parseBodyJson(req, res, (err, obj) => {
          if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_json' })); return; }
          // require admin
          try {
            const { findUserById } = require('./auth');
            const me = findUserById(req.user.id);
            if (!me || Number(me.is_admin) !== 1) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
          } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' })); return; }

          const slug = (obj && obj.slug) ? String(obj.slug).trim() : '';
          const name = (obj && obj.name) ? String(obj.name).trim() : '';
          // support new host fields while preserving backward compatibility
          const controller_host1 = (obj && (obj.controller_host1 || obj.host1)) ? String(obj.controller_host1 || obj.host1).trim() : null;
          const controller_host2 = (obj && (obj.controller_host2 || obj.host2)) ? String(obj.controller_host2 || obj.host2).trim() : null;
          const controller_ip = (obj && obj.controller_ip) ? String(obj.controller_ip).trim() : null;
          const controller_port = (obj && obj.controller_port) ? Number(obj.controller_port) : null;
          let metadata = (obj && obj.metadata) ? String(obj.metadata) : null;
          if (!slug || !name) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing_fields' })); return; }
          // slug must be alphanumeric, dashes only
          if (!/^[a-z0-9-]+$/i.test(slug)) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_slug' })); return; }
          // validate metadata if present
          if (metadata) {
            try { JSON.parse(metadata); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_metadata', detail: String(e && e.message) })); return; }
          }
          try {
            const Database = require('better-sqlite3');
            const path = require('path');
            const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
            const db = new Database(DB_PATH);
            const now = Date.now();
            // Determine if the customers table has host1/host2 columns; prefer storing host1/host2
            const colInfo = db.prepare("PRAGMA table_info(customers)").all();
            const hasHost1 = colInfo.some(c => c && c.name === 'controller_host1');
            const hasHost2 = colInfo.some(c => c && c.name === 'controller_host2');
            let info;
            if (hasHost1) {
              // include host2 if present in schema
              if (hasHost2) {
                const stmt = db.prepare('INSERT INTO customers (slug, name, controller_host1, controller_host2, controller_ip, controller_port, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
                info = stmt.run(slug, name, controller_host1, controller_host2, controller_ip, controller_port, metadata, now, now);
              } else {
                const stmt = db.prepare('INSERT INTO customers (slug, name, controller_host1, controller_ip, controller_port, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
                info = stmt.run(slug, name, controller_host1, controller_ip, controller_port, metadata, now, now);
              }
            } else {
              // fallback to legacy controller_ip-only schema
              const stmt = db.prepare('INSERT INTO customers (slug, name, controller_ip, controller_port, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
              info = stmt.run(slug, name, controller_ip, controller_port, metadata, now, now);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, customer: { id: info.lastInsertRowid, slug, name } }));
          } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
        });
        return true;
      }

        // Admin-only: list or create users for a customer
        // GET /admin/api/customers/:id/users  -> list users for customer
        // POST /admin/api/customers/:id/users -> create user under customer
        if (url.pathname.match(/^\/admin\/api\/customers\/\d+\/users$/) && (req.method === 'GET' || req.method === 'POST')) {
          const parts = url.pathname.split('/').filter(Boolean);
          const cid = Number(parts[parts.length - 2]);
          if (!cid) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_customer_id' })); return true; }
          let me;
          try {
            me = findUserById(req.user.id);
            if (!me) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
          } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' })); return true; }

          // GET list of users: admin-only
            if (req.method === 'GET') {
              try {
                const isAdmin = Number(me.is_admin) === 1;
                const isManagerForCustomer = (me.role === 'manager' && Number(me.customer_id) === cid);
                if (!isAdmin && !isManagerForCustomer) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
                const Database = require('better-sqlite3');
                const path = require('path');
                const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
                const db = new Database(DB_PATH);
                const rows = db.prepare('SELECT id, username, email, name, role, is_admin, customer_id, created_at, updated_at FROM users WHERE customer_id = ? ORDER BY id').all(cid);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, users: rows }));
              } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
              return true;
          }

          // POST -> create user under this customer
          // Allow admins to create users anywhere; allow 'privileged' role users to create users only for their own customer (and with limited privileges)
          if (req.method === 'POST') {
            try {
              // Allow admins anywhere; allow managers to create users only for their own customer
              const allowedForManager = (me.role === 'manager' && Number(me.customer_id) === cid);
              if (!(Number(me.is_admin) === 1 || allowedForManager)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' })); return true; }

            parseBodyJson(req, res, (err, obj) => {
              if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_json' })); return; }
              const username = obj && obj.username ? String(obj.username).trim() : '';
              const password = obj && obj.password ? String(obj.password) : '';
              const email = obj && obj.email ? String(obj.email).trim() : null;
              const name = obj && obj.name ? String(obj.name).trim() : null;
              // Creator-specified role is accepted; is_admin will be derived from the role
              let role = obj && obj.role ? String(obj.role).trim() : null;
              let is_admin = (role === 'admin') ? 1 : 0;
              if (!username || !password) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing_fields' })); return; }
              try {
                const existing = findUserByUsername(username);
                if (existing) { res.writeHead(409); res.end(JSON.stringify({ error: 'username_exists' })); return; }
                // If creator is not full admin (i.e. manager), they cannot create admin users
                if (Number(me.is_admin) !== 1) {
                  is_admin = 0;
                  // force role to 'user' for manager-created accounts
                  role = 'user';
                }
                const u = createUser(username, password, { email, name, role, is_admin, customer_id: cid });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, user: { id: u.id, username: u.username } }));
              } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
            });
            return true;
          }
        }

      // Admin-only: list customers (supports ?limit=&offset=)
      if (url.pathname === '/admin/api/customers' && req.method === 'GET') {
        try {
          const { findUserById } = require('./auth');
          const me = findUserById(req.user.id);
          if (!me || Number(me.is_admin) !== 1) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
          const Database = require('better-sqlite3');
          const path = require('path');
          const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
          const db = new Database(DB_PATH);
          const limit = Number(url.searchParams.get('limit')) || 0;
          const offset = Number(url.searchParams.get('offset')) || 0;
          const totalRow = db.prepare('SELECT COUNT(1) as c FROM customers').get();
          const total = totalRow ? Number(totalRow.c) : 0;
          let rows = [];
          // Include controller_host1/controller_host2 when present; otherwise return legacy controller_ip
          const colInfo = db.prepare("PRAGMA table_info(customers)").all();
          const hasHost1 = colInfo.some(c => c && c.name === 'controller_host1');
          const hasHost2 = colInfo.some(c => c && c.name === 'controller_host2');
          if (limit > 0) {
            if (hasHost1) {
              if (hasHost2) rows = db.prepare('SELECT id, slug, name, controller_host1, controller_host2, controller_ip, controller_port, metadata, created_at, updated_at FROM customers ORDER BY id LIMIT ? OFFSET ?').all(limit, offset);
              else rows = db.prepare('SELECT id, slug, name, controller_host1, controller_ip, controller_port, metadata, created_at, updated_at FROM customers ORDER BY id LIMIT ? OFFSET ?').all(limit, offset);
            } else {
              rows = db.prepare('SELECT id, slug, name, controller_ip, controller_port, metadata, created_at, updated_at FROM customers ORDER BY id LIMIT ? OFFSET ?').all(limit, offset);
            }
          } else {
            if (hasHost1) {
              if (hasHost2) rows = db.prepare('SELECT id, slug, name, controller_host1, controller_host2, controller_ip, controller_port, metadata, created_at, updated_at FROM customers ORDER BY id').all();
              else rows = db.prepare('SELECT id, slug, name, controller_host1, controller_ip, controller_port, metadata, created_at, updated_at FROM customers ORDER BY id').all();
            } else {
              rows = db.prepare('SELECT id, slug, name, controller_ip, controller_port, metadata, created_at, updated_at FROM customers ORDER BY id').all();
            }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, customers: rows, total }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
        return true;
      }

      // GET single customer (admin OR manager for own customer)
      if (url.pathname.match(/^\/admin\/api\/customers\/\d+$/) && req.method === 'GET') {
        const id = Number(url.pathname.split('/').pop());
        if (!id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad_id' })); return true; }
        try {
          const { findUserById } = require('./auth');
          const me = findUserById(req.user.id);
          if (!me) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
          const isAdmin = Number(me.is_admin) === 1;
          const isManagerOwn = (me.role === 'manager' && Number(me.customer_id) === id);
          if (!isAdmin && !isManagerOwn) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
          const Database = require('better-sqlite3');
          const path = require('path');
          const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
          const db = new Database(DB_PATH);
          const colInfo = db.prepare("PRAGMA table_info(customers)").all();
          const hasHost1 = colInfo.some(c => c && c.name === 'controller_host1');
          const hasHost2 = colInfo.some(c => c && c.name === 'controller_host2');
          let row;
          if (hasHost1) {
            if (hasHost2) row = db.prepare('SELECT id, slug, name, controller_host1, controller_host2, controller_ip, controller_port, metadata, created_at, updated_at FROM customers WHERE id = ?').get(id);
            else row = db.prepare('SELECT id, slug, name, controller_host1, controller_ip, controller_port, metadata, created_at, updated_at FROM customers WHERE id = ?').get(id);
          } else {
            row = db.prepare('SELECT id, slug, name, controller_ip, controller_port, metadata, created_at, updated_at FROM customers WHERE id = ?').get(id);
          }
          if (!row) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return true; }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, customer: row }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
        return true;
      }

      // Admin-only: update customer
      if (url.pathname.startsWith('/admin/api/customers/') && (req.method === 'PUT' || req.method === 'POST')) {
        // path /admin/api/customers/<id>
        const parts = url.pathname.split('/').filter(Boolean);
        const id = Number(parts[parts.length - 1]);
        if (!id) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_id' })); return true; }
        parseBodyJson(req, res, (err, obj) => {
          if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_json' })); return; }
          try {
            const { findUserById } = require('./auth');
            const me = findUserById(req.user.id);
            if (!me || Number(me.is_admin) !== 1) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
          } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' })); return; }
          try {
            const Database = require('better-sqlite3');
            const path = require('path');
            const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
            const db = new Database(DB_PATH);
            const updates = [];
            const params = [];
            // accept host1/host2 fields in addition to legacy controller_ip
            ['slug','name','controller_host1','controller_host2','controller_ip','controller_port','metadata'].forEach(k => {
              if (obj && Object.prototype.hasOwnProperty.call(obj, k)) { updates.push(`${k} = ?`); params.push(obj[k]); }
            });
            // additional validation: slug and metadata if present
            if (obj && Object.prototype.hasOwnProperty.call(obj, 'slug')) {
              if (!/^[a-z0-9-]+$/i.test(String(obj.slug))) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_slug' })); return; }
            }
            if (obj && Object.prototype.hasOwnProperty.call(obj, 'metadata') && obj.metadata) {
              try { JSON.parse(String(obj.metadata)); } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_metadata', detail: String(e && e.message) })); return; }
            }
            if (!updates.length) { res.writeHead(400); res.end(JSON.stringify({ error: 'nothing_to_update' })); return; }
            params.push(id);
            const sql = `UPDATE customers SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`;
            // ensure updated_at param
            params.splice(params.length-1, 0, Date.now());
            const stmt = db.prepare(sql);
            const info = stmt.run(...params);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, changes: info.changes }));
          } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
        });
        return true;
      }

      // Admin-only: delete customer (and cascade related rows)
      if (url.pathname.match(/^\/admin\/api\/customers\/\d+$/) && req.method === 'DELETE') {
        const parts = url.pathname.split('/').filter(Boolean);
        const cid = Number(parts[parts.length - 1]);
        if (!cid) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_id' })); return true; }
        try {
          const { findUserById } = require('./auth');
          const me = findUserById(req.user.id);
          if (!me || Number(me.is_admin) !== 1) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' })); return true; }
        // Prevent an admin from deleting the customer they are currently signed into,
        // which would remove their own user record and cause an immediate 401 on
        // subsequent requests. Require logging in as a different admin to delete.
        try {
          const reqUser = require('./auth').findUserById(req.user.id);
          if (reqUser && Number(reqUser.customer_id) === cid) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'cannot_delete_own_customer', detail: 'Cannot delete the customer you are signed into. Log in with a different admin before deleting.' }));
            return true;
          }
        } catch (e) { /* ignore and proceed defensively */ }

        try {
          const Database = require('better-sqlite3');
          const path = require('path');
          const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
          const db = new Database(DB_PATH);
          // Try to perform deletes defensively in case foreign keys are not enabled
          const delUsers = db.prepare('DELETE FROM users WHERE customer_id = ?').run(cid);
          const delSensors = db.prepare('DELETE FROM sensors WHERE customer_id = ?').run(cid);
          const delCust = db.prepare('DELETE FROM customers WHERE id = ?').run(cid);
          if (delCust.changes === 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return true; }
          res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return true;
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'delete_failed', message: String(e && e.message) })); return true; }
      }

        // Admin-only: user CRUD
        if (url.pathname.startsWith('/admin/api/users') && (req.method === 'GET' || req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE')) {
          // /admin/api/users/:id  or /admin/api/users (POST -> create global user)
          const parts = url.pathname.split('/').filter(Boolean);
          const last = parts[parts.length - 1];
          // require admin
          try {
            const me = findUserById(req.user.id);
            if (!me || Number(me.is_admin) !== 1) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
          } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' })); return true; }

          // GET /admin/api/users/:id -> get user
          if (url.pathname.match(/^\/admin\/api\/users\/\d+$/) && req.method === 'GET') {
            const uid = Number(url.pathname.split('/').pop());
            try {
              const Database = require('better-sqlite3');
              const path = require('path');
              const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
              const db = new Database(DB_PATH);
              const userRow = db.prepare('SELECT id, username, email, name, role, is_admin, customer_id, created_at, updated_at FROM users WHERE id = ?').get(uid);
              if (!userRow) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return true; }
              res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, user: userRow }));
              return true;
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); return true; }
          }

          // PUT /admin/api/users/:id -> update user fields
          if (url.pathname.match(/^\/admin\/api\/users\/\d+$/) && req.method === 'PUT') {
            parseBodyJson(req, res, (err, body) => {
              if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid_json' })); return; }
              const uid = Number(url.pathname.split('/').pop());
              try {
                const ok = updateUserById(uid, body || {});
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
                return;
              } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'update_failed', message: e && e.message })); return; }
            });
            return true;
          }

          // DELETE /admin/api/users/:id -> delete user
          if (url.pathname.match(/^\/admin\/api\/users\/\d+$/) && req.method === 'DELETE') {
            try {
              const uid = Number(url.pathname.split('/').pop());
              const Database = require('better-sqlite3');
              const path = require('path');
              const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
              const db = new Database(DB_PATH);
              // Determine requesting user privileges
              const me = findUserById(req.user.id);
              if (!me) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
              const target = db.prepare('SELECT id, is_admin, customer_id FROM users WHERE id = ?').get(uid);
              if (!target) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return true; }
              // Admins can delete anyone; managers can delete non-admins in their own customer
              if (Number(me.is_admin) === 1) {
                const info = db.prepare('DELETE FROM users WHERE id = ?').run(uid);
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return true;
              }
              if (me.role === 'manager' && Number(me.customer_id) === Number(target.customer_id)) {
                if (Number(target.is_admin) === 1) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'forbidden' })); return true; }
                const info = db.prepare('DELETE FROM users WHERE id = ?').run(uid);
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return true;
              }
              // otherwise unauthorized
              res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true;
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'delete_failed', message: e && e.message })); return true; }
          }

          // POST -> create global user (admin only)
          if (req.method === 'POST' && (!last || isNaN(Number(last)))) {
            parseBodyJson(req, res, (err, obj) => {
              if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_json' })); return; }
              const username = obj && obj.username ? String(obj.username).trim() : '';
              const password = obj && obj.password ? String(obj.password) : '';
              const email = obj && obj.email ? String(obj.email).trim() : null;
              const name = obj && obj.name ? String(obj.name).trim() : null;
              const role = obj && obj.role ? String(obj.role).trim() : null;
              const is_admin = obj && (obj.is_admin === true || obj.is_admin === 1) ? 1 : 0;
              const customer_id = obj && obj.customer_id ? Number(obj.customer_id) : null;
              if (!username || !password) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing_fields' })); return; }
              try {
                const existing = findUserByUsername(username);
                if (existing) { res.writeHead(409); res.end(JSON.stringify({ error: 'username_exists' })); return; }
                const u = createUser(username, password, { email, name, role, is_admin, customer_id });
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, user: { id: u.id, username: u.username } }));
              } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
            });
            return true;
          }
        }

        // Admin-only: sensors/topics under customer
        // Keep sensors handlers for backward compatibility but expose Topics endpoints
        if (url.pathname.match(/^\/admin\/api\/customers\/\d+\/(sensors|topics)/)) {
          const parts = url.pathname.split('/').filter(Boolean);
          // Robustly find the numeric customer id after the 'customers' segment
          const custIdx = parts.indexOf('customers');
          const cid = (custIdx !== -1 && parts.length > custIdx + 1) ? Number(parts[custIdx + 1]) : NaN;
          if (!cid || Number.isNaN(cid)) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_customer_id' })); return true; }
          try {
            const me = findUserById(req.user.id);
            if (!me || Number(me.is_admin) !== 1) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return true; }
          } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error' })); return true; }

          // GET list sensors
          if (req.method === 'GET') {
            try {
              const Database = require('better-sqlite3');
              const path = require('path');
              const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
              const db = new Database(DB_PATH);
              // Some DBs may use `sensor_key` column while older ones used `key`.
              // Inspect table schema and select the appropriate column to avoid
              // referencing a non-existent column which causes SQLite errors.
              const colInfo = db.prepare("PRAGMA table_info(sensors)").all();
              const hasSensorKey = colInfo.some(c => c && c.name === 'sensor_key');
              const hasKey = colInfo.some(c => c && c.name === 'key');
              const hasTopicKey = colInfo.some(c => c && c.name === 'topic_key');
              const hasMetadata = colInfo.some(c => c && c.name === 'metadata');
              let rows = [];
              // Prefer topic_key if present (new schema), otherwise sensor_key, otherwise key
              if (hasTopicKey) {
                if (hasMetadata) rows = db.prepare('SELECT id, customer_id, topic_key, metadata, created_at FROM sensors WHERE customer_id = ? ORDER BY id').all(cid);
                else rows = db.prepare('SELECT id, customer_id, topic_key, NULL AS metadata, created_at FROM sensors WHERE customer_id = ? ORDER BY id').all(cid);
              } else if (hasSensorKey) {
                if (hasMetadata) rows = db.prepare('SELECT id, customer_id, sensor_key AS topic_key, metadata, created_at FROM sensors WHERE customer_id = ? ORDER BY id').all(cid);
                else rows = db.prepare('SELECT id, customer_id, sensor_key AS topic_key, NULL AS metadata, created_at FROM sensors WHERE customer_id = ? ORDER BY id').all(cid);
              } else if (hasKey) {
                if (hasMetadata) rows = db.prepare('SELECT id, customer_id, `key` AS topic_key, metadata, created_at FROM sensors WHERE customer_id = ? ORDER BY id').all(cid);
                else rows = db.prepare('SELECT id, customer_id, `key` AS topic_key, NULL AS metadata, created_at FROM sensors WHERE customer_id = ? ORDER BY id').all(cid);
              } else {
                // No suitable column found; respond with explicit error
                res.writeHead(500);
                res.end(JSON.stringify({ error: 'server_error', detail: 'sensors table missing topic_key/sensor_key/key column' }));
                return true;
              }
              // Normalize shape to include topic_key
              const out = rows.map(r => ({ id: r.id, customer_id: r.customer_id, topic_key: r.topic_key, metadata: r.metadata, created_at: r.created_at }));
              res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, topics: out }));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
            return true;
          }

          // POST create sensor
          if (req.method === 'POST') {
            parseBodyJson(req, res, (err, obj) => {
              if (err) { res.writeHead(400); res.end(JSON.stringify({ error: 'bad_json' })); return; }
              // Accept topic_key, sensor_key, or key in the body
              const topic_key = obj && (obj.topic_key || obj.sensor_key || obj.key) ? String(obj.topic_key || obj.sensor_key || obj.key).trim() : '';
              const metadata = obj && obj.metadata ? String(obj.metadata) : null;
              if (!topic_key) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing_fields' })); return; }
              try {
                const Database = require('better-sqlite3');
                const path = require('path');
                const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
                const db = new Database(DB_PATH);
                const now = Date.now();
                // Insert into either `sensor_key` or `key` depending on which column exists.
                // Prefer `sensor_key` if present; otherwise fallback to `key`.
                const colInfo = db.prepare("PRAGMA table_info(sensors)").all();
                const hasTopicKey = colInfo.some(c => c && c.name === 'topic_key');
                const hasSensorKey = colInfo.some(c => c && c.name === 'sensor_key');
                const hasKey = colInfo.some(c => c && c.name === 'key');
                const hasMetadata = colInfo.some(c => c && c.name === 'metadata');
                let info;
                if (hasTopicKey) {
                  if (hasMetadata) info = db.prepare('INSERT INTO sensors (customer_id, topic_key, metadata, created_at) VALUES (?, ?, ?, ?)').run(cid, topic_key, metadata, now);
                  else info = db.prepare('INSERT INTO sensors (customer_id, topic_key, created_at) VALUES (?, ?, ?)').run(cid, topic_key, now);
                } else if (hasSensorKey) {
                  if (hasMetadata) info = db.prepare('INSERT INTO sensors (customer_id, sensor_key, metadata, created_at) VALUES (?, ?, ?, ?)').run(cid, topic_key, metadata, now);
                  else info = db.prepare('INSERT INTO sensors (customer_id, sensor_key, created_at) VALUES (?, ?, ?)').run(cid, topic_key, now);
                } else if (hasKey) {
                  if (hasMetadata) info = db.prepare('INSERT INTO sensors (customer_id, `key`, metadata, created_at) VALUES (?, ?, ?, ?)').run(cid, topic_key, metadata, now);
                  else info = db.prepare('INSERT INTO sensors (customer_id, `key`, created_at) VALUES (?, ?, ?)').run(cid, topic_key, now);
                } else {
                  // No suitable column found; return an explicit error
                  res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: 'sensors table missing topic_key/sensor_key/key column' })); return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, topic: { id: info.lastInsertRowid, topic_key } }));
              } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'server_error', detail: String(e && e.message) })); }
            });
            return true;
          }

          // DELETE /admin/api/customers/:id/sensors/:sid -> delete sensor
          if (url.pathname.match(/^\/admin\/api\/customers\/\d+\/(sensors|topics)\/\d+$/) && req.method === 'DELETE') {
            try {
              const parts = url.pathname.split('/').filter(Boolean);
              const cid2 = Number(parts[parts.length - 3]); // customers/<id>/sensors/<sid>
              const sid = Number(parts[parts.length - 1]);
              const Database = require('better-sqlite3');
              const path = require('path');
              const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
              const db = new Database(DB_PATH);
              const info = db.prepare('DELETE FROM sensors WHERE id = ? AND customer_id = ?').run(sid, cid2);
              if (info.changes === 0) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found' })); return true; }
              res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return true;
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: 'delete_failed', message: e && e.message })); return true; }
          }
        }

      return false; // not handled here
  } catch (e) {
    // Defensive: avoid throwing ERR_HTTP_HEADERS_SENT if some handler already
    // wrote a response. Use safeSend which checks headersSent/writableEnded.
    safeSend(res, 500, 'server error', 'text/plain');
    return true;
  }
}

module.exports = { handleAdminApi };