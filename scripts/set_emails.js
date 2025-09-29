#!/usr/bin/env node
const path = require('path');
const { updateUserEmailByUsername } = require('../server/lib/auth');
const auth = require('../server/lib/auth');

function setEmail(user, email) {
  const ok = auth.updateUserEmailByUsername(user, email);
  console.log('Set email for', user, '=>', email, 'ok=', ok);
}

setEmail('steven', 'steven.bollman@hotmail.com');
setEmail('billy', 'billyjack000@gmail.com');
