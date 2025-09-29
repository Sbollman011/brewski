SQLite database for Brewski

Location
- The default SQLite file is at: server/brewski.sqlite3 (relative to the project root).
- You can override by setting the environment variable BREWSKI_DB_FILE or BREWSKI_DB_PATH.

Schema (users)
- Table: users
  - id INTEGER PRIMARY KEY AUTOINCREMENT
  - username TEXT UNIQUE NOT NULL
  - password_hash TEXT NOT NULL
  - created_at INTEGER NOT NULL (ms since epoch)

Common tasks
- Inspect the DB:
  sqlite3 server/brewski.sqlite3
  sqlite> .tables
  sqlite> SELECT id, username, created_at FROM users;

- Reset a user's password (generate bcrypt hash with node):
  // from project root
  node -e "const b=require('bcrypt');console.log(b.hashSync('newpassword',10));"
  // then in sqlite:
  UPDATE users SET password_hash='<PASTE_HASH>' WHERE username='alice';

- Add a user from the node REPL (uses same auth helper):
  node -e "const a=require('./server/lib/auth');console.log(a.createUser('alice','secret'))"

Env variables
- BREWSKI_DB_FILE or BREWSKI_DB_PATH — path to the sqlite file
- BREWSKI_JWT_SECRET (or JWT_SECRET) — secret used to sign/verify JWT tokens
- BRIDGE_TOKEN — legacy token accepted for the WebSocket bridge and admin API (if set)

Security notes
- Keep BREWSKI_JWT_SECRET and BRIDGE_TOKEN secret and do not store them in version control.
- The database file contains password hashes (bcrypt) but not plaintext passwords.

Backup
- Copy the sqlite file while the server is stopped, or use sqlite3's .backup command.
  sqlite3 server/brewski.sqlite3 ".backup 'brewski-backup.sqlite3'"
