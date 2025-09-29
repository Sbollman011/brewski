const { spawnSync } = require('child_process');

function sendmailAvailable() {
  try {
    const which = spawnSync('which', ['sendmail']);
    return which.status === 0;
  } catch (e) { return false; }
}

function sendRawMail(from, to, subject, body) {
  // Compose simple RFC822 message and feed to sendmail -t
  const msg = [];
  msg.push(`From: ${from}`);
  msg.push(`To: ${to}`);
  msg.push(`Subject: ${subject}`);
  msg.push('MIME-Version: 1.0');
  msg.push('Content-Type: text/plain; charset="utf-8"');
  msg.push('');
  msg.push(body);
  const input = msg.join('\n');
  try {
    const p = spawnSync('sendmail', ['-t'], { input, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (p.error) {
      console.error('[mailer] sendmail error', p.error);
      return false;
    }
    if (p.status !== 0) {
      console.error('[mailer] sendmail exited with', p.status, p.stderr && p.stderr.toString());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[mailer] exception sending mail', e && e.stack ? e.stack : e);
    return false;
  }
}

function sendResetEmail(to, token) {
  const from = process.env.RESET_FROM || `no-reply@${process.env.PUBLIC_HOST || 'railbrewouse.com'}`;
  const subject = 'Brew Remote password reset instructions';
  const linkHost = process.env.PUBLIC_HOST || 'appli.railbrewouse.com';
  const link = `https://${linkHost}/portal/#/reset?token=${encodeURIComponent(token)}`;
  const body = `You have requested a password reset for your Brew Remote account.\n\n` +
    `Use the following link to reset your password (valid for 15 minutes):\n\n${link}\n\n` +
    `Or paste this token into the app:\n\n${token}\n\n` +
    `If you did not request this, you can ignore this message.`;

  if (sendmailAvailable()) {
    return sendRawMail(from, to, subject, body);
  }
  // Fallback: just log the token so operators can retrieve it. Don't fail.
  console.log('[mailer] sendmail not available, fallback logging token for', to, 'token=', token);
  return false;
}

module.exports = { sendResetEmail };
