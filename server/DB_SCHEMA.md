# BrewSki Database Schema

This document describes the multi-tenant schema used by BrewSki server and how to migrate/inspect the database.

Location: server/brewski.sqlite3 (default)

Overview
--------
This schema supports multiple customers, each with one or more controllers (Raspberry Pis), per-customer users, sensors, and telemetry time-series data.

Tables
------
- customers
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - slug TEXT UNIQUE NOT NULL
  - name TEXT NOT NULL
  - controller_ip TEXT
  - controller_port INTEGER
  - metadata TEXT (JSON as TEXT)
  - created_at INTEGER (epoch ms)
  - updated_at INTEGER (epoch ms)

- controllers
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE
  - name TEXT
  - ip TEXT NOT NULL
  - port INTEGER
  - last_seen INTEGER
  - metadata TEXT
  - created_at INTEGER

- users
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - username TEXT UNIQUE NOT NULL
  - password_hash TEXT NOT NULL
  - email TEXT
  - customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE
  - role TEXT DEFAULT 'user'
  - is_admin INTEGER DEFAULT 0
  - created_at INTEGER
  - updated_at INTEGER

- sensors
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE
  - controller_id INTEGER REFERENCES controllers(id) ON DELETE SET NULL
  - name TEXT
  - key TEXT
  - topic_key TEXT  (normalized canonical topic or base identifier; future proofing)
  - type TEXT
  - unit TEXT
  - last_value REAL        (cached latest numeric value for instant snapshot)
  - last_ts INTEGER        (epoch ms when last_value was observed)
  - last_raw TEXT          (raw JSON/string payload slice associated with last_value)
  - created_at INTEGER

- telemetry
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - sensor_id INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE
  - ts INTEGER NOT NULL  -- epoch ms of measurement
  - value REAL
  - raw TEXT
  - created_at INTEGER

Indexes
-------
- idx_users_customer ON users(customer_id)
- idx_controllers_customer ON controllers(customer_id)
- idx_sensors_customer ON sensors(customer_id)
- idx_telemetry_sensor_ts ON telemetry(sensor_id, ts)
- (recommended) CREATE UNIQUE INDEX IF NOT EXISTS idx_sensors_customer_key ON sensors(customer_id, key);

Latest Value Caching
--------------------
To support fast dashboard hydration without waiting for a live MQTT publish, the `sensors` table carries cached latest fields (last_value, last_ts, last_raw). Ingestion logic should:
1. Resolve (or create) a sensor row for the incoming topic/metric (by customer_id + key or topic_key).
2. Decide whether to insert a telemetry row (apply write throttling: minimum interval + minimum delta, configurable via env, e.g. TELEMETRY_MIN_INTERVAL_MS / TELEMETRY_MIN_DELTA).
3. Always update the cached columns if the reading is newer (ts greater than existing last_ts) or if last_ts is NULL.

Example upsert (SQLite syntax):
```
INSERT INTO sensors (customer_id, key, topic_key, type, unit, created_at, last_value, last_ts, last_raw)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(customer_id, key) DO UPDATE SET
  last_value=excluded.last_value,
  last_ts=excluded.last_ts,
  last_raw=excluded.last_raw;
```

Snapshot API (`/api/latest`)
----------------------------
The planned endpoint will SELECT the latest cached values for a customer:
```
SELECT id, key, topic_key, type, unit, last_value, last_ts, last_raw
FROM sensors
WHERE customer_id = ? AND last_ts IS NOT NULL;
```
Optionally filter by controller or key prefix. The response is then transformed to the structure the dashboard expects (mapping topic base to value/metadata) prior to WebSocket connection.

Power / Switch State
--------------------
If persistent relay / POWER states are needed, a small `power_states` table can mirror the pattern:
```
CREATE TABLE power_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  device_key TEXT NOT NULL,
  channel INTEGER NOT NULL DEFAULT 1,
  state INTEGER NOT NULL,              -- 0/1
  updated_at INTEGER NOT NULL,
  UNIQUE(customer_id, device_key, channel)
);
```
This is optional; initial implementation may rely on querying live MQTT retained STATE/RESULT topics.

Notes and rationale
-------------------
- Users are scoped to a customer via `customer_id`. Username uniqueness remains global in this version; if you want per-customer uniqueness we can change that later.
- `is_admin` is an integer flag (0/1) to indicate administrative users.
- Telemetry storage in SQLite is appropriate for moderate volumes. For high-frequency telemetry, consider moving telemetry to a time-series database.
- `metadata` columns are stored as JSON text to allow flexible settings without schema changes.

Migration
---------
Use `server/scripts/migrate_db.js` to migrate or recreate the database. The script supports:

- Dry-run (default): shows planned SQL and actions.
  node server/scripts/migrate_db.js

- Apply migration (non-destructive): creates new tables and adds columns where possible, and assigns existing users to a `default` customer.
  node server/scripts/migrate_db.js --apply

- Wipe and recreate (destructive): BACKS UP the existing DB, recreates the schema from scratch, and inserts two admin users (billy, steven) as requested.
  node server/scripts/migrate_db.js --apply --wipe

The script places backups in `server/backups/` before making changes.

Rollbacks
---------
- To revert a migration, stop the server and restore the backup file from `server/backups/`:
  cp server/backups/brewski.sqlite3.<timestamp>.bak server/brewski.sqlite3

Security
--------
- Passwords are stored as bcrypt hashes. Keep `BREWSKI_JWT_SECRET` (or `BREWSKI_JWT_SECRET`) secure.
- Backups may contain secrets; protect `server/backups` with appropriate filesystem permissions.

Examples
--------
- List users for a customer (replace 1 with customer id):
  SELECT id, username, email, role, is_admin FROM users WHERE customer_id = 1;

- Query latest telemetry for a sensor:
  SELECT value, ts FROM telemetry WHERE sensor_id = 123 ORDER BY ts DESC LIMIT 1;

Contact
-------
If you want changes to the schema (per-customer username uniqueness, multiple roles, or external telemetry storage) I can update the migration and code accordingly.
