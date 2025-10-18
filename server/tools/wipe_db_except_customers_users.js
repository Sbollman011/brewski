#!/usr/bin/env node
// Wipe DB except customers and users
// Usage: ALLOW_WIPE=1 node wipe_db_except_customers_users.js --db /path/to/brewski.sqlite3 --yes
// Options:
//   --dry-run        Show which tables and row counts would be deleted, but don't modify the DB
//   --preserve a,b   Comma-separated additional table names to preserve (in addition to customers,users)

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function usageAndExit(msg) {
  if (msg) console.error(msg);
  console.log('This script will BACKUP the database file and then DELETE all rows from every table except `customers` and `users`.');
  console.log('REQUIREMENTS: set environment variable ALLOW_WIPE=1 and pass --yes to confirm.');
  console.log('Options: --db /absolute/path/to/db   (optional, defaults to server/brewski.sqlite3)');
  console.log('Example: ALLOW_WIPE=1 node wipe_db_except_customers_users.js --db ./server/brewski.sqlite3 --yes');
  process.exit(msg ? 1 : 0);
}

(async () => {
  try {
    if (process.env.ALLOW_WIPE !== '1') {
      usageAndExit('Refusing to run: ALLOW_WIPE is not set to 1.');
    }

    const args = process.argv.slice(2);
  let dbPath = path.join(__dirname, '..', 'brewski.sqlite3');
  let yes = false;
  let dryRun = false;
  let preserveExtra = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--db' && args[i+1]) { dbPath = path.resolve(args[i+1]); i++; }
      else if (a === '--yes') yes = true;
      else if (a === '--dry-run') dryRun = true;
      else if (a === '--preserve' && args[i+1]) { preserveExtra = String(args[i+1]).split(',').map(s=>s.trim()).filter(Boolean); i++; }
    }

  if (!yes && !dryRun) usageAndExit('Need --yes to actually perform the wipe. Use --dry-run to preview without --yes.');
    if (!fs.existsSync(dbPath)) usageAndExit('DB file not found: ' + dbPath);

    const backupPath = dbPath + '.bak.' + Date.now();
    fs.copyFileSync(dbPath, backupPath);
    console.log('Backup created at', backupPath);

    const db = new Database(dbPath, { readonly: dryRun });
    // Get list of tables
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name);
    console.log('Found tables:', tables.join(', '));

    const preserve = new Set(['customers','users']);
    for (const p of preserveExtra) if (p) preserve.add(p);
    const toTruncate = tables.filter(t => !preserve.has(t));
    if (toTruncate.length === 0) {
      console.log('No tables to truncate. Exiting.');
      process.exit(0);
    }

    // Show estimated row counts for preview
    try {
      console.log('\nRow counts (preview):');
      for (const t of toTruncate) {
        try {
          const row = db.prepare(`SELECT COUNT(1) as c FROM \"${t}\"`).get();
          console.log(`  ${t}: ${row && row.c !== undefined ? row.c : 'unknown'}`);
        } catch (e) {
          console.log(`  ${t}: (error counting rows: ${e && e.message ? e.message : e})`);
        }
      }
    } catch (e) {}

    console.log('\nPreserving tables:', Array.from(preserve).join(', '));
    console.log('Will truncate tables:', toTruncate.join(', '));
    if (dryRun) {
      console.log('\nDry-run mode: no changes will be made. Backup was still created.');
      db.close();
      process.exit(0);
    }

    console.log('Proceeding with deletion...');

    const writeDb = new Database(dbPath);
    const trx = writeDb.transaction((tbls) => {
      for (const t of tbls) {
        try {
          // Use DELETE FROM rather than DROP so schema remains intact
          writeDb.prepare(`DELETE FROM \"${t}\"`).run();
          // Reset sqlite_sequence for AUTOINCREMENT tables
          try { writeDb.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(t); } catch (e) {}
        } catch (e) {
          console.warn('Failed to truncate', t, e && e.message ? e.message : e);
        }
      }
    });

    trx(toTruncate);
    console.log('Truncate transaction committed.');
    writeDb.close();
    console.log('Done. Backup left at', backupPath);
  } catch (e) {
    console.error('Error during wipe:', e && e.message ? e.message : e);
    process.exit(2);
  }
})();
