#!/usr/bin/env node
/*
  migrate_db.js
  Safe migration tool for evolving brewski.sqlite3 to multi-tenant schema.

  Usage:
    node migrate_db.js --dry-run        # show planned SQL and actions (default)
    node migrate_db.js --apply          # perform the migration (will backup DB first)
    node migrate_db.js --help

  The script is intentionally conservative: by default it only prints the steps.
  Use --apply to make changes. Backups are created in the backups/ folder.
*/

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const argv = process.argv.slice(2);
const DO_APPLY = argv.includes('--apply');
const WIPE = argv.includes('--wipe');
const SHOW_HELP = argv.includes('--help') || argv.includes('-h');

if (SHOW_HELP) {
  console.log('Usage: node migrate_db.js [--dry-run|--apply]');
  process.exit(0);
}

const DB_PATH = process.env.BREWSKI_DB_FILE || process.env.BREWSKI_DB_PATH || path.join(__dirname, '..', 'brewski.sqlite3');
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

const bcrypt = require('bcrypt');

function ensureBackupDir() {
  try { fs.mkdirSync(BACKUP_DIR, { recursive: true }); } catch (e) {}
}

function backupDb() {
  ensureBackupDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `brewski.sqlite3.${ts}.bak`);
  fs.copyFileSync(DB_PATH, dest);
  return dest;
}

function plannedSteps() {
  return [
    "PRAGMA foreign_keys = OFF;",
    // Create customers table
    `CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      controller_host1 TEXT,
      controller_host2 TEXT,
      controller_ip TEXT,
      controller_port INTEGER,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );`,

    // Create controllers
    `CREATE TABLE IF NOT EXISTS controllers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      name TEXT,
      ip TEXT NOT NULL,
      port INTEGER,
      last_seen INTEGER,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );`,

  // Add customer_id and role columns to users if not present
  '-- ALTER TABLE users ADD COLUMN customer_id INTEGER DEFAULT NULL;',
  "-- ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';",

    // Create sensors
    `CREATE TABLE IF NOT EXISTS sensors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      controller_id INTEGER,
      name TEXT,
      key TEXT,
      type TEXT,
      unit TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(controller_id) REFERENCES controllers(id) ON DELETE SET NULL
    );`,

    // Telemetry
    `CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      value REAL,
      raw TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(sensor_id) REFERENCES sensors(id) ON DELETE CASCADE
    );`,

    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_users_customer ON users(customer_id);`,
    `CREATE INDEX IF NOT EXISTS idx_controllers_customer ON controllers(customer_id);`,
    `CREATE INDEX IF NOT EXISTS idx_sensors_customer ON sensors(customer_id);`,
    `CREATE INDEX IF NOT EXISTS idx_telemetry_sensor_ts ON telemetry(sensor_id, ts);`,
    `PRAGMA foreign_keys = ON;`
  ];
}

function columnExists(db, table, column) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    return cols.some(c => c && c.name === column);
  } catch (e) { return false; }
}

function runMigration() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('DB file not found at', DB_PATH);
    if (!DO_APPLY) process.exit(1);
  }

  if (DO_APPLY) {
    console.log('Creating backup...');
    const b = backupDb();
    console.log('Backup created at', b);
  } else {
    console.log('DRY RUN: no changes will be made. Use --apply to actually run migration.');
  }

  // If wipe requested, remove DB file after backup and recreate
  if (WIPE && DO_APPLY) {
    try {
      console.log('Wipe requested: removing DB file', DB_PATH);
      fs.unlinkSync(DB_PATH);
    } catch (e) { /* ignore */ }
  }

  const db = new Database(DB_PATH);

  try {
    db.pragma('foreign_keys = OFF');

    const doExec = (sql) => {
      if (DO_APPLY) {
        db.exec(sql);
      } else {
        console.log('SQL:', sql.split('\n').slice(0,30).join('\n'));
      }
    };

    // If wipe/apply: create a fresh schema including users table
    if (WIPE && DO_APPLY) {
      console.log('Creating fresh schema (wipe mode)');
      db.exec(`
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          slug TEXT UNIQUE NOT NULL,
          name TEXT NOT NULL,
          controller_host1 TEXT,
          controller_host2 TEXT,
          controller_ip TEXT,
          controller_port INTEGER,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS controllers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL,
          name TEXT,
          ip TEXT NOT NULL,
          port INTEGER,
          last_seen INTEGER,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          email TEXT DEFAULT NULL,
          customer_id INTEGER NOT NULL,
          role TEXT DEFAULT 'user',
          is_admin INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER,
          FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS sensors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL,
          controller_id INTEGER,
          name TEXT,
          key TEXT,
          type TEXT,
          unit TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
          FOREIGN KEY(controller_id) REFERENCES controllers(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS telemetry (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sensor_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          value REAL,
          raw TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY(sensor_id) REFERENCES sensors(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_users_customer ON users(customer_id);
        CREATE INDEX IF NOT EXISTS idx_controllers_customer ON controllers(customer_id);
        CREATE INDEX IF NOT EXISTS idx_sensors_customer ON sensors(customer_id);
        CREATE INDEX IF NOT EXISTS idx_telemetry_sensor_ts ON telemetry(sensor_id, ts);
      `);

      // Create default customer
      const now = Date.now();
      const info = db.prepare('INSERT INTO customers (slug, name, created_at) VALUES (?, ?, ?)').run('default', 'Default Customer', now);
      const defaultCustomerId = info.lastInsertRowid;

      // Insert initial admin users
      const insertUser = db.prepare('INSERT INTO users (username, password_hash, email, customer_id, role, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const pw1 = 'ilov3b33r';
      const pw2 = 'ilov3b33r';
      const hash1 = bcrypt.hashSync(pw1, 10);
      const hash2 = bcrypt.hashSync(pw2, 10);
      insertUser.run('billy', hash1, 'billyjack000@gmail.com', defaultCustomerId, 'admin', 1, now);
      insertUser.run('steven', hash2, 'steven.bollman@hotmail.com', defaultCustomerId, 'admin', 1, now);
      console.log('Inserted default customer and initial admin users (billy, steven)');

      db.pragma('foreign_keys = ON');
      console.log('Wipe/apply completed');
      db.close();
      return;
    }

    // Create customers and controllers, sensors, telemetry
    doExec(`CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      controller_host1 TEXT,
      controller_host2 TEXT,
      controller_ip TEXT,
      controller_port INTEGER,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );`);

    doExec(`CREATE TABLE IF NOT EXISTS controllers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      name TEXT,
      ip TEXT NOT NULL,
      port INTEGER,
      last_seen INTEGER,
      metadata TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE
    );`);

    // Add columns to users if missing
    if (!columnExists(db, 'users', 'customer_id')) {
      console.log('Will add users.customer_id column');
      if (DO_APPLY) db.exec("ALTER TABLE users ADD COLUMN customer_id INTEGER DEFAULT NULL");
    } else {
      console.log('users.customer_id already exists');
    }

    if (!columnExists(db, 'users', 'role')) {
      console.log('Will add users.role column');
      if (DO_APPLY) db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
    } else {
      console.log('users.role already exists');
    }

    // Ensure customers table has controller_host1/controller_host2 columns for new hosts support
    if (!columnExists(db, 'customers', 'controller_host1')) {
      console.log('Will add customers.controller_host1 column');
      if (DO_APPLY) {
        try { db.exec("ALTER TABLE customers ADD COLUMN controller_host1 TEXT"); } catch (e) { console.error('Failed to add controller_host1:', e && e.message); }
      }
    } else {
      console.log('customers.controller_host1 already exists');
    }

    if (!columnExists(db, 'customers', 'controller_host2')) {
      console.log('Will add customers.controller_host2 column');
      if (DO_APPLY) {
        try { db.exec("ALTER TABLE customers ADD COLUMN controller_host2 TEXT"); } catch (e) { console.error('Failed to add controller_host2:', e && e.message); }
      }
    } else {
      console.log('customers.controller_host2 already exists');
    }

    doExec(`CREATE TABLE IF NOT EXISTS sensors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      controller_id INTEGER,
      name TEXT,
      key TEXT,
      topic_key TEXT,
      type TEXT,
      unit TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE CASCADE,
      FOREIGN KEY(controller_id) REFERENCES controllers(id) ON DELETE SET NULL
    );`);

    doExec(`CREATE TABLE IF NOT EXISTS telemetry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sensor_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      value REAL,
      raw TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(sensor_id) REFERENCES sensors(id) ON DELETE CASCADE
    );`);

    // Indexes
    doExec(`CREATE INDEX IF NOT EXISTS idx_users_customer ON users(customer_id);`);
    doExec(`CREATE INDEX IF NOT EXISTS idx_controllers_customer ON controllers(customer_id);`);
    doExec(`CREATE INDEX IF NOT EXISTS idx_sensors_customer ON sensors(customer_id);`);
    doExec(`CREATE INDEX IF NOT EXISTS idx_telemetry_sensor_ts ON telemetry(sensor_id, ts);`);

    // Ensure default customer exists and migrate existing users into it if they lack customer_id
    const now = Date.now();
    const defaultSlug = 'default';
    const defaultName = 'Default Customer';

    let defaultCustomerId = null;
    const existing = db.prepare('SELECT id FROM customers WHERE slug = ?').get(defaultSlug);
    if (existing && existing.id) {
      defaultCustomerId = existing.id;
      console.log('Default customer already exists id=', defaultCustomerId);
    } else {
      console.log('Default customer does not exist; will create one');
      if (DO_APPLY) {
        const info = db.prepare('INSERT INTO customers (slug, name, created_at) VALUES (?, ?, ?)').run(defaultSlug, defaultName, now);
        defaultCustomerId = info.lastInsertRowid;
        console.log('Created default customer id=', defaultCustomerId);
      }
    }

    // Migrate existing users to default customer
    if (defaultCustomerId !== null) {
      const missing = db.prepare('SELECT COUNT(*) AS c FROM users WHERE customer_id IS NULL OR customer_id = 0').get();
      const countMissing = missing ? missing.c : 0;
      console.log(`Users missing customer_id: ${countMissing}`);
      if (countMissing > 0) {
        if (DO_APPLY) {
          const upd = db.prepare('UPDATE users SET customer_id = ? WHERE customer_id IS NULL OR customer_id = 0');
          const info = upd.run(defaultCustomerId);
          console.log('Assigned customer_id to users, changes=', info.changes);
        } else {
          console.log('DRY RUN: would assign customer_id to existing users');
        }
      }
    }

    // Re-enable foreign keys
    db.pragma('foreign_keys = ON');

    // Populate topic_key from existing columns if missing (idempotent)
    try {
      if (DO_APPLY) {
        if (columnExists(db, 'sensors', 'topic_key')) {
          console.log('Ensuring topic_key values exist where possible');
          // If topic_key is NULL, try to copy from sensor_key or key
          if (columnExists(db, 'sensors', 'sensor_key')) {
            const info = db.prepare('UPDATE sensors SET topic_key = sensor_key WHERE topic_key IS NULL AND sensor_key IS NOT NULL').run();
            console.log('Copied sensor_key -> topic_key rows=', info.changes);
          }
          if (columnExists(db, 'sensors', 'key')) {
            const info2 = db.prepare('UPDATE sensors SET topic_key = `key` WHERE topic_key IS NULL AND `key` IS NOT NULL').run();
            console.log('Copied key -> topic_key rows=', info2.changes);
          }
        }
      } else {
        console.log('DRY RUN: would populate topic_key from sensor_key/key where missing');
      }
    } catch (e) { console.error('topic_key population failed', e && e.message); }

    if (DO_APPLY) console.log('Migration applied successfully');
    else console.log('Dry run complete. No changes were applied.');
  } catch (e) {
    console.error('Migration failed:', e && e.stack ? e.stack : e);
  } finally {
    try { db.close(); } catch (e) {}
  }
}

if (require.main === module) runMigration();

module.exports = { runMigration };
