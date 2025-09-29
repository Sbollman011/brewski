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
    created_at INTEGER NOT NULL
  );
`);

function createUser(username, password) {
  const hash = bcrypt.hashSync(String(password), 10);
  const stmt = _db_.prepare('INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)');
  const info = stmt.run(username, hash, Date.now());
  return { id: info.lastInsertRowid, username };
}

function findUserByUsername(username) {
  const stmt = _db_.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');
  return stmt.get(username);
}

function verifyPassword(userOrUsername, password) {
  if (!userOrUsername) return false;
  let user = null;
  if (typeof userOrUsername === 'string') user = findUserByUsername(userOrUsername);
  else user = userOrUsername;
  if (!user) return false;
  return bcrypt.compareSync(String(password), user.password_hash);
}

function signToken(payload, opts) {
  return jwt.sign(payload, _JWT_SECRET_, Object.assign({ expiresIn: '7d' }, opts || {}));
}

function verifyToken(token) {
  try { return jwt.verify(token, _JWT_SECRET_); } catch (e) { return null; }
}

module.exports = { createUser, findUserByUsername, verifyPassword, signToken, verifyToken, DB_FILE: _DB_FILE_ };
