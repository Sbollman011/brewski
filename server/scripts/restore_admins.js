#!/usr/bin/env node
// restore_admins.js
// Ensure default customer exists and restore two admin users (billy, steven)

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');

function ensureDbExists() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('DB not found at', DB_PATH);
    process.exit(1);
  }
}

function ensureUsersColumns(db) {
  const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!cols.includes('customer_id')) {
    try { db.exec("ALTER TABLE users ADD COLUMN customer_id INTEGER DEFAULT NULL"); } catch (e) { /* ignore */ }
  }
  if (!cols.includes('role')) {
    try { db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'"); } catch (e) { /* ignore */ }
  }
  if (!cols.includes('is_admin')) {
    try { db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0"); } catch (e) { /* ignore */ }
  }
}

function ensureDefaultCustomer(db) {
  const now = Date.now();
  const row = db.prepare('SELECT id FROM customers WHERE slug = ?').get('default');
  if (row && row.id) return row.id;
  const info = db.prepare('INSERT INTO customers (slug, name, created_at) VALUES (?, ?, ?)').run('default', 'Default Customer', now);
  return info.lastInsertRowid;
}

function upsertAdmin(db, username, email, plainPassword, customerId) {
  const now = Date.now();
  const hash = bcrypt.hashSync(plainPassword, 10);
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing && existing.id) {
    db.prepare('UPDATE users SET password_hash = ?, email = ?, customer_id = ?, role = ?, is_admin = ?, updated_at = ? WHERE id = ?')
      .run(hash, email, customerId, 'admin', 1, now, existing.id);
    console.log(`Updated user ${username}`);
  } else {
    db.prepare('INSERT INTO users (username, password_hash, email, customer_id, role, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(username, hash, email, customerId, 'admin', 1, now);
    console.log(`Inserted user ${username}`);
  }
}

function main() {
  ensureDbExists();
  const db = new Database(DB_PATH);
  try {
    db.pragma('foreign_keys = ON');
    ensureUsersColumns(db);
    const cid = ensureDefaultCustomer(db);
    upsertAdmin(db, 'billy', 'billyjack000@gmail.com', 'ilov3b33r', cid);
    upsertAdmin(db, 'steven', 'steven.bollman@hotmail.com', 'ilov3b33r', cid);
    console.log('Done.');
  } catch (e) {
    console.error('Error restoring admins:', e && e.stack ? e.stack : e);
  } finally {
    try { db.close(); } catch (e) {}
  }
}

if (require.main === module) main();

module.exports = { main };
