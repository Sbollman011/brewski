
const { spawnSync } = require('child_process');
const nodemailer = (() => {
  try {
    return require('nodemailer');
  } catch (e) {
    return null;
  }
})();
const sendgridMail = (() => {
  try {
    return require('@sendgrid/mail');
  } catch (e) {
    return null;
  }
})();
async function sendSendgridMail(from, to, subject, body) {
  if (!sendgridMail || !process.env.SENDGRID_API_KEY) {
    console.error('[mailer] SendGrid not configured or not installed');
    return false;
  }
  try {
    sendgridMail.setApiKey(process.env.SENDGRID_API_KEY);
    const msg = {
      to,
      from,
      subject,
      text: body,
    };
    await sendgridMail.send(msg);
    console.log('[mailer] SendGrid mail sent to', to);
    return true;
  } catch (e) {
    console.error('[mailer] SendGrid send error', e && e.response ? e.response.body : e);
    return false;
  }
}

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

async function sendSmtpMail(from, to, subject, body) {
  // Prefer nodemailer SMTP when configured via env vars
  if (!nodemailer) {
    console.error('[mailer] nodemailer not installed, cannot send via SMTP');
    return false;
  }
  const host = process.env.SMTP_HOST;
  if (!host) return false;
  const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
  const secure = process.env.SMTP_SECURE === '1' || process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER || null;
  const pass = process.env.SMTP_PASS || null;

  try {
    const transporter = nodemailer.createTransport({ host, port, secure, auth: user ? { user, pass } : undefined });
    const info = await transporter.sendMail({ from, to, subject, text: body });
    console.log('[mailer] smtp send result', info && info.messageId ? info.messageId : info);
    return true;
  } catch (e) {
    console.error('[mailer] smtp send error', e && e.stack ? e.stack : e);
    return false;
  }
}

async function sendResetEmail(to, token) {
  const from = process.env.RESET_FROM || `no-reply@${process.env.PUBLIC_HOST || 'brewingremote.com'}`;
  const subject = 'Brew Remote password reset instructions';
  const linkHost = process.env.PUBLIC_HOST || 'brewingremote.com';
  const link = `https://${linkHost}/portal/#/reset?token=${encodeURIComponent(token)}`;
  const body = `You have requested a password reset for your Brew Remote account.\n\n` +
    `Use the following link to reset your password (valid for 15 minutes):\n\n${link}\n\n` +
    `Or paste this token into the app:\n\n${token}\n\n` +
    `If you did not request this, you can ignore this message.`;

  // Try SendGrid first if configured
  if (process.env.SENDGRID_API_KEY && sendgridMail) {
    const ok = await sendSendgridMail(from, to, subject, body);
    if (ok) return true;
    // Fall through to SMTP if SendGrid failed
  }

  // Try SMTP if configured
  if (process.env.SMTP_HOST && nodemailer) {
    const ok = await sendSmtpMail(from, to, subject, body);
    if (ok) return true;
    // Fall through to sendmail if SMTP failed
  }

  // Try sendmail if available
  if (sendmailAvailable()) {
    const ok = sendRawMail(from, to, subject, body);
    if (ok) return true;
  }

  // Final fallback: log the token for operators to retrieve
  console.log('[mailer] sendmail/smtp/sendgrid not available or all failed, fallback logging token for', to, 'token=', token);
  return false;
}

module.exports = { sendResetEmail };
