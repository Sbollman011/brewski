#!/usr/bin/env node
const auth = require('../server/lib/auth');

async function run() {
  try {
    const user = auth.findUserByUsername('billy');
    if (!user) {
      console.error('User "billy" not found in DB.');
      process.exit(2);
    }
    const ok = auth.updateUserPasswordById(user.id, 'ilov3b33r');
    console.log('User:', user.username, 'id=', user.id, 'passwordUpdated=', ok);
    process.exit(ok ? 0 : 3);
  } catch (e) {
    console.error('Error updating password:', e && e.message ? e.message : String(e));
    process.exit(1);
  }
}

run();
