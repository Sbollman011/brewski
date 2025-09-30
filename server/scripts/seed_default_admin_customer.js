#!/usr/bin/env node
const path = require('path');
const Database = require('better-sqlite3');
const { createUser, findUserByUsername } = require('../lib/auth');

const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
const db = new Database(DB_PATH);

function ensureCustomersTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      controller_ip TEXT,
      controller_port INTEGER,
      metadata TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);
}

function ensureSensorsTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sensors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      sensor_key TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER
    );
  `);
}

function createDefaultAdminCustomer() {
  ensureCustomersTable();
  ensureSensorsTable();
  const existing = db.prepare('SELECT id FROM customers WHERE slug = ?').get('brew-remote-admin');
  let cid;
  if (existing) cid = existing.id;
  else {
    const now = Date.now();
    const info = db.prepare('INSERT INTO customers (slug, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('brew-remote-admin', 'Brew Remote Admin', now, now);
    cid = info.lastInsertRowid;
  }
  // Create users billy and steven if missing
  const admins = [ { username: 'billy', password: 'ilov3b33r', email: 'billyjack000@gmail.com' }, { username: 'steven', password: 'ilov3b33r', email: 'steven.bollman@hotmail.com' } ];
  for (const a of admins) {
    try {
      const exists = findUserByUsername(a.username);
      if (!exists) {
        createUser(a.username, a.password, { email: a.email, name: a.username, is_admin: 1, customer_id: cid });
        console.log('Created admin user', a.username);
      } else {
        console.log('User exists, skipping', a.username);
      }
    } catch (e) { console.error('Failed creating user', a.username, e && e.message); }
  }
  console.log('Default admin customer ensured, id=', cid);
}

if (require.main === module) {
  createDefaultAdminCustomer();
}

module.exports = { createDefaultAdminCustomer };
