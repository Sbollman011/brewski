const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

// Minimal, safe auth module (single copy)
const _DB_FILE_ = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
const _JWT_SECRET_ = process.env.BREWSKI_JWT_SECRET || process.env.JWT_SECRET || process.env.BRIDGE_TOKEN || 'dev-secret-change-me';

try { fs.mkdirSync(path.dirname(_DB_FILE_), { recursive: true }); } catch (e) {}
const _db_ = new Database(_DB_FILE_);
_db_.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Add email column if older DB lacks it
try {
  const cols = _db_.prepare("PRAGMA table_info(users)").all();
  const hasEmail = cols.some(c => c && c.name === 'email');
  if (!hasEmail) {
    try { _db_.prepare('ALTER TABLE users ADD COLUMN email TEXT').run(); } catch (e) { /* ignore alter errors */ }
  }
} catch (e) { /* ignore */ }

// Ensure additional columns exist for multi-tenant schema
try {
  const cols = _db_.prepare("PRAGMA table_info(users)").all();
  const names = cols.map(c => c && c.name).filter(Boolean);
  if (!names.includes('customer_id')) {
    try { _db_.prepare('ALTER TABLE users ADD COLUMN customer_id INTEGER').run(); } catch (e) {}
  }
  if (!names.includes('name')) {
    try { _db_.prepare("ALTER TABLE users ADD COLUMN name TEXT").run(); } catch (e) {}
  }
  if (!names.includes('role')) {
    try { _db_.prepare("ALTER TABLE users ADD COLUMN role TEXT").run(); } catch (e) {}
  }
  if (!names.includes('is_admin')) {
    try { _db_.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0").run(); } catch (e) {}
  }
  if (!names.includes('updated_at')) {
    try { _db_.prepare('ALTER TABLE users ADD COLUMN updated_at INTEGER').run(); } catch (e) {}
  }
} catch (e) { /* ignore */ }

function createUser(username, password, opts = {}) {
  const hash = bcrypt.hashSync(String(password), 10);
  const stmt = _db_.prepare('INSERT INTO users (username, password_hash, email, name, customer_id, role, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const info = stmt.run(
    username,
    hash,
    opts.email || null,
    opts.name || null,
    opts.customer_id || null,
    opts.role || null,
    opts.is_admin ? 1 : 0,
    Date.now(),
    Date.now()
  );
  return { id: info.lastInsertRowid, username };
}

function findUserByUsername(username) {
  const stmt = _db_.prepare(`
    SELECT u.id, u.username, u.password_hash, u.email, u.customer_id, u.role, u.is_admin, 
           c.slug as customer_slug, c.name as customer_name
    FROM users u 
    LEFT JOIN customers c ON u.customer_id = c.id 
    WHERE u.username = ?
  `);
  return stmt.get(username);
}

function findUserByEmail(email) {
  if (!email) return null;
  const stmt = _db_.prepare(`
    SELECT u.id, u.username, u.password_hash, u.email, u.customer_id, u.role, u.is_admin,
           c.slug as customer_slug, c.name as customer_name
    FROM users u 
    LEFT JOIN customers c ON u.customer_id = c.id 
    WHERE u.email = ?
  `);
  return stmt.get(email);
}

function findUserById(id) {
  if (!id) return null;
  const stmt = _db_.prepare(`
    SELECT u.id, u.username, u.password_hash, u.email, u.customer_id, u.role, u.is_admin,
           c.slug as customer_slug, c.name as customer_name
    FROM users u 
    LEFT JOIN customers c ON u.customer_id = c.id 
    WHERE u.id = ?
  `);
  return stmt.get(id);
}

function verifyPassword(userOrUsername, password) {
  if (!userOrUsername) return false;
  let user = null;
  if (typeof userOrUsername === 'string') user = findUserByUsername(userOrUsername);
  else user = userOrUsername;
  if (!user) return false;
  return bcrypt.compareSync(String(password), user.password_hash);
}

function updateUserPasswordById(id, newPassword) {
  if (!id || !newPassword) return false;
  const hash = bcrypt.hashSync(String(newPassword), 10);
  const stmt = _db_.prepare('UPDATE users SET password_hash = ? WHERE id = ?');
  const info = stmt.run(hash, id);
  return info.changes === 1;
}

function updateUserById(id, fields = {}) {
  if (!id || !fields || typeof fields !== 'object') return false;
  const allowed = ['email', 'name', 'role', 'customer_id', 'is_admin', 'password_hash'];
  const sets = [];
  const vals = [];
  for (const k of Object.keys(fields)) {
    if (!allowed.includes(k)) continue;
    sets.push(`${k} = ?`);
    vals.push(fields[k]);
  }
  if (!sets.length) return false;
  vals.push(Date.now());
  const sql = `UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`;
  vals.push(id);
  const stmt = _db_.prepare(sql);
  const info = stmt.run(...vals);
  return info.changes >= 1;
}

function updateUserFieldsByUsername(username, fields = {}) {
  if (!username) return false;
  const user = findUserByUsername(username);
  if (!user) return false;
  return updateUserById(user.id, fields);
}

function findCustomerBySlug(slug) {
  if (!slug) return null;
  const stmt = _db_.prepare('SELECT id, slug, name FROM customers WHERE slug = ?');
  return stmt.get(slug);
}

function updateUserEmailByUsername(username, email) {
  if (!username || !email) return false;
  const stmt = _db_.prepare('UPDATE users SET email = ? WHERE username = ?');
  const info = stmt.run(email, username);
  return info.changes === 1;
}

function signToken(payload, opts) {
  return jwt.sign(payload, _JWT_SECRET_, Object.assign({ expiresIn: '7d' }, opts || {}));
}

function verifyToken(token) {
  try { return jwt.verify(token, _JWT_SECRET_); } catch (e) { return null; }
}

module.exports = { createUser, findUserByUsername, findUserByEmail, findUserById, verifyPassword, updateUserPasswordById, updateUserEmailByUsername, signToken, verifyToken, findCustomerBySlug, DB_FILE: _DB_FILE_ };
