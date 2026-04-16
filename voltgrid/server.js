const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

const server = http.createServer(app);

// WebSocket server - noServer mode for reliable Windows support
const wss = new WebSocket.Server({ noServer: true });

// Handle WebSocket upgrade manually
server.on('upgrade', (req, socket, head) => {
  if (req.url.startsWith('/ocpp')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// ── DATABASE (PostgreSQL) ─────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function query(sql, params) {
  try {
    const result = await pool.query(sql, params);
    return result.rows;
  } catch (e) {
    console.error('[DB]', e.message);
    return [];
  }
}

async function run(sql, params) {
  try {
    await pool.query(sql, params);
  } catch (e) {
    console.error('[DB]', e.message);
  }
}

async function initDb() {
  await run(`CREATE TABLE IF NOT EXISTS chargers (id TEXT PRIMARY KEY, status TEXT DEFAULT 'Unavailable', power_kw REAL DEFAULT 0, last_seen TEXT, vendor TEXT, model TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS sessions (id SERIAL PRIMARY KEY, charger_id TEXT, transaction_id INTEGER, id_tag TEXT, start_time TEXT, end_time TEXT, energy_kwh REAL DEFAULT 0, status TEXT DEFAULT 'Active')`);
  await run(`CREATE TABLE IF NOT EXISTS meter_readings (id SERIAL PRIMARY KEY, charger_id TEXT, energy_wh REAL, power_w REAL, timestamp TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS ocpp_log (id SERIAL PRIMARY KEY, charger_id TEXT, action TEXT, payload TEXT, direction TEXT, timestamp TEXT)`);
  await run(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, username TEXT UNIQUE, password_hash TEXT, role TEXT DEFAULT 'operator', email TEXT)`);
  await run(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);

  // Seed default admin user — email comes from env var ADMIN_EMAIL
  const defaultHash = hashPassword('admin123');
  const adminEmail = process.env.ADMIN_EMAIL || '';
  await run(
    `INSERT INTO users (username, password_hash, role, email) VALUES ($1, $2, 'admin', $3) ON CONFLICT (username) DO NOTHING`,
    ['admin', defaultHash, adminEmail]
  );
  // Always sync admin email from ADMIN_EMAIL env var on startup
  if (adminEmail) {
    await run(`UPDATE users SET email = $1 WHERE username = 'admin'`, [adminEmail]);
  }

  console.log('[DB] Database ready');
}

// ── EMAIL (nodemailer) ────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: false,
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
  tls: { rejectUnauthorized: false },
});

// Verify SMTP connection on startup
if (process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter.verify((err) => {
    if (err) {
      console.error('[SMTP] Connection FAILED:', err.message);
    } else {
      console.log('[SMTP] Connection OK — ready to send emails');
    }
  });
}

async function sendOtpEmail(toEmail, otp) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[OTP] Email not configured. OTP for ${toEmail}: ${otp}`);
    return;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({
    from: `"VoltGrid" <${from}>`,
    to: toEmail,
    subject: 'Your VoltGrid login OTP',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#1877F2;">VoltGrid — One-Time Password</h2>
        <p>Use the code below to complete your sign-in. It expires in <strong>5 minutes</strong>.</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:10px;text-align:center;
                    background:#F0F2F5;border-radius:12px;padding:20px;margin:24px 0;color:#050505;">
          ${otp}
        </div>
        <p style="color:#65676B;font-size:13px;">If you did not request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}

async function sendResetEmail(toEmail, resetLink) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.log(`[RESET DEV] Password reset link for ${toEmail}: ${resetLink}`);
    return;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  await transporter.sendMail({
    from: `"VoltGrid" <${from}>`,
    to: toEmail,
    subject: 'Reset your VoltGrid password',
    html: `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
        <h2 style="color:#1877F2;">VoltGrid — Password Reset</h2>
        <p>We received a request to reset your password. Click the button below to set a new one.</p>
        <p>This link expires in <strong>15 minutes</strong>.</p>
        <div style="text-align:center;margin:28px 0;">
          <a href="${resetLink}" style="background:#1877F2;color:#fff;text-decoration:none;
             padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;display:inline-block;">
            Reset Password
          </a>
        </div>
        <p style="color:#65676B;font-size:13px;">If you did not request this, you can safely ignore this email. Your password will not change.</p>
        <p style="color:#65676B;font-size:12px;word-break:break-all;">Or copy this link: ${resetLink}</p>
      </div>
    `,
  });
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
const activeSessions = new Map();  // token → { username, role, createdAt }
const pendingOtps = new Map();     // username → { otp, expiresAt, email }
const resetTokens = new Map();     // token → { username, expiresAt }

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const token = header.slice(7);
  const session = activeSessions.get(token);
  if (!session) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = session;
  next();
}
// ─────────────────────────────────────────────────────────────────────────────

const connectedChargers = new Map();

wss.on('connection', async (ws, req) => {
  const chargerId = req.url.replace('/ocpp/', '').replace('/ocpp', '') || 'UNKNOWN';
  console.log('[OCPP] Connected:', chargerId);
  connectedChargers.set(chargerId, ws);

  await run(
    `INSERT INTO chargers (id, last_seen) VALUES ($1, NOW()) ON CONFLICT (id) DO UPDATE SET last_seen = NOW()`,
    [chargerId]
  );

  ws.on('message', async (rawMsg) => {
    let msg;
    try { msg = JSON.parse(rawMsg); } catch { return; }
    const [msgType, msgId, action, payload] = msg;
    if (msgType === 2) {
      console.log('[OCPP]', chargerId, '->', action);
      await run(
        `INSERT INTO ocpp_log (charger_id, action, payload, direction, timestamp) VALUES ($1, $2, $3, 'IN', NOW())`,
        [chargerId, action, JSON.stringify(payload)]
      );
      handle(ws, chargerId, msgId, action, payload);
    }
  });

  ws.on('close', async () => {
    console.log('[OCPP] Disconnected:', chargerId);
    connectedChargers.delete(chargerId);
    await run(`UPDATE chargers SET status = 'Offline' WHERE id = $1`, [chargerId]);
  });

  ws.on('error', (e) => console.error('[OCPP] Error:', e.message));
});

async function handle(ws, id, msgId, action, payload) {
  if (action === 'BootNotification') {
    await run(
      `UPDATE chargers SET vendor=$1, model=$2, status='Available', last_seen=NOW() WHERE id=$3`,
      [payload.chargePointVendor || '', payload.chargePointModel || '', id]
    );
    respond(ws, msgId, { status: 'Accepted', currentTime: new Date().toISOString(), interval: 30 });

  } else if (action === 'Heartbeat') {
    await run(`UPDATE chargers SET last_seen=NOW() WHERE id=$1`, [id]);
    respond(ws, msgId, { currentTime: new Date().toISOString() });

  } else if (action === 'StatusNotification') {
    await run(`UPDATE chargers SET status=$1, last_seen=NOW() WHERE id=$2`, [payload.status, id]);
    respond(ws, msgId, {});

  } else if (action === 'StartTransaction') {
    await run(
      `INSERT INTO sessions (charger_id, transaction_id, id_tag, start_time, status) VALUES ($1, $2, $3, NOW(), 'Active')`,
      [id, payload.transactionId || Date.now(), payload.idTag]
    );
    await run(`UPDATE chargers SET status='Charging' WHERE id=$1`, [id]);
    respond(ws, msgId, { transactionId: payload.transactionId || Date.now(), idTagInfo: { status: 'Accepted' } });

  } else if (action === 'StopTransaction') {
    await run(
      `UPDATE sessions SET end_time=NOW(), energy_kwh=$1, status='Completed' WHERE charger_id=$2 AND status='Active'`,
      [(payload.meterStop || 0) / 1000, id]
    );
    await run(`UPDATE chargers SET status='Available', power_kw=0 WHERE id=$1`, [id]);
    respond(ws, msgId, { idTagInfo: { status: 'Accepted' } });

  } else if (action === 'MeterValues') {
    const sv = payload.meterValue && payload.meterValue[0] && payload.meterValue[0].sampledValue;
    if (sv) {
      const energy = sv.find(v => v.measurand === 'Energy.Active.Import.Register');
      const power = sv.find(v => v.measurand === 'Power.Active.Import');
      if (energy) {
        await run(
          `INSERT INTO meter_readings (charger_id, energy_wh, power_w, timestamp) VALUES ($1, $2, $3, NOW())`,
          [id, parseFloat(energy.value), power ? parseFloat(power.value) : 0]
        );
        await run(`UPDATE chargers SET power_kw=$1 WHERE id=$2`, [power ? parseFloat(power.value) / 1000 : 0, id]);
      }
    }
    respond(ws, msgId, {});

  } else {
    respond(ws, msgId, {});
  }
}

function respond(ws, msgId, payload) {
  ws.send(JSON.stringify([3, msgId, payload]));
}

// ── AUTH ENDPOINTS ────────────────────────────────────────────────────────────

// Step 1 — validate credentials, send OTP to registered email
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const hash = hashPassword(password);
  const users = await query(`SELECT * FROM users WHERE username = $1 AND password_hash = $2`, [username, hash]);
  if (users.length === 0) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const user = users[0];

  if (!user.email) {
    return res.status(403).json({
      error: 'No email address on file for this account. Please contact your administrator.',
    });
  }

  const otp = generateOtp();
  pendingOtps.set(username, { otp, expiresAt: Date.now() + 5 * 60 * 1000, email: user.email });

  const smtpConfigured = !!(process.env.SMTP_USER && process.env.SMTP_PASS);

  if (smtpConfigured) {
    try {
      await sendOtpEmail(user.email, otp);
    } catch (e) {
      console.error('[OTP] Failed to send email:', e.message);
      return res.status(500).json({ error: 'Failed to send OTP email. Please try again.' });
    }
  } else {
    console.log(`[OTP DEV] OTP for ${username}: ${otp}`);
  }

  const [localPart, domain] = user.email.split('@');
  const masked = localPart.slice(0, 2) + '****@' + domain;

  res.json({
    otpRequired: true,
    maskedEmail: masked,
    username,
    devOtp: smtpConfigured ? undefined : otp,
  });
});

// Step 2 — verify OTP and issue session token
app.post('/api/verify-otp', async (req, res) => {
  const { username, otp } = req.body;
  if (!username || !otp) {
    return res.status(400).json({ error: 'Username and OTP are required' });
  }

  const pending = pendingOtps.get(username);
  if (!pending) {
    return res.status(400).json({ error: 'No OTP requested for this account. Please sign in again.' });
  }
  if (Date.now() > pending.expiresAt) {
    pendingOtps.delete(username);
    return res.status(400).json({ error: 'OTP has expired. Please sign in again.' });
  }
  if (otp.trim() !== pending.otp) {
    return res.status(401).json({ error: 'Incorrect OTP. Please try again.' });
  }

  pendingOtps.delete(username);

  const users = await query(`SELECT * FROM users WHERE username = $1`, [username]);
  if (users.length === 0) {
    return res.status(401).json({ error: 'User not found.' });
  }
  const user = users[0];
  const token = generateToken();
  activeSessions.set(token, { username: user.username, role: user.role, createdAt: Date.now() });
  res.json({ token, username: user.username, role: user.role });
});

// Register new user
app.post('/api/register', async (req, res) => {
  const { username, password, email } = req.body;
  if (!username || !password || !email) {
    return res.status(400).json({ error: 'Username, email and password are required' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'Username must be at least 3 characters' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  const existingUser = await query(`SELECT id FROM users WHERE username = $1`, [username]);
  if (existingUser.length > 0) {
    return res.status(409).json({ error: 'Username already taken' });
  }
  const existingEmail = await query(`SELECT id FROM users WHERE email = $1`, [email]);
  if (existingEmail.length > 0) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const hash = hashPassword(password);
  await run(`INSERT INTO users (username, password_hash, role, email) VALUES ($1, $2, 'operator', $3)`, [username, hash, email]);
  res.status(201).json({ ok: true, message: 'Account created. You can now sign in.' });
});

// Forgot password — send reset link to email
app.post('/api/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const users = await query(`SELECT * FROM users WHERE email = $1`, [email]);
  // Always respond with success to prevent email enumeration
  if (users.length === 0) {
    return res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
  }

  const user = users[0];
  const token = generateToken();
  resetTokens.set(token, { username: user.username, expiresAt: Date.now() + 15 * 60 * 1000 });

  const baseUrl = (process.env.BASE_URL || 'https://voltgrid-api-q2sf.onrender.com').replace(/\/$/, '');
  const resetLink = `${baseUrl}/reset-password.html?token=${token}`;
  console.log(`[RESET] Link generated for ${user.username}: ${resetLink}`);

  try {
    await sendResetEmail(email, resetLink);
    console.log(`[RESET] Email sent successfully to ${email}`);
  } catch (e) {
    console.error('[RESET] Failed to send email:', e.message);
    console.error('[RESET] Full error:', e);
    resetTokens.delete(token);
    return res.status(500).json({ error: `Failed to send reset email: ${e.message}` });
  }

  res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
});

// Reset password — validate token and set new password
app.post('/api/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const pending = resetTokens.get(token);
  if (!pending) return res.status(400).json({ error: 'Invalid or already used reset link.' });
  if (Date.now() > pending.expiresAt) {
    resetTokens.delete(token);
    return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' });
  }

  const hash = hashPassword(password);
  await run(`UPDATE users SET password_hash = $1 WHERE username = $2`, [hash, pending.username]);
  resetTokens.delete(token);

  // Invalidate all active sessions for this user
  for (const [t, s] of activeSessions) {
    if (s.username === pending.username) activeSessions.delete(t);
  }

  res.json({ ok: true, message: 'Password updated successfully. You can now sign in.' });
});

app.post('/api/logout', requireAuth, (req, res) => {
  const token = req.headers['authorization'].slice(7);
  activeSessions.delete(token);
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

// ── PROTECTED REST API ────────────────────────────────────────────────────────
app.get('/api/chargers', requireAuth, async (_req, res) => res.json(await query(`SELECT * FROM chargers ORDER BY id`)));
app.get('/api/sessions', requireAuth, async (_req, res) => res.json(await query(`SELECT * FROM sessions ORDER BY start_time DESC LIMIT 100`)));
app.get('/api/log', requireAuth, async (_req, res) => res.json(await query(`SELECT * FROM ocpp_log ORDER BY timestamp DESC LIMIT 100`)));
app.get('/api/status', requireAuth, async (_req, res) => res.json({
  connected: [...connectedChargers.keys()],
  chargers: ((await query(`SELECT COUNT(*) as c FROM chargers`))[0] || {}).c || 0,
  sessions: ((await query(`SELECT COUNT(*) as c FROM sessions WHERE status='Active'`))[0] || {}).c || 0,
  time: new Date().toISOString()
}));
app.post('/api/chargers/:id/command', requireAuth, (req, res) => {
  const ws = connectedChargers.get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Not connected' });
  ws.send(JSON.stringify([2, 'cmd-' + Date.now(), req.body.action, req.body.payload || {}]));
  res.json({ sent: true });
});

initDb().then(() => {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`
  +-----------------------------------------+
  |  VoltGrid Backend running!              |
  |  Dashboard: http://localhost:${PORT}/      |
  |  OCPP:      ws://localhost:${PORT}/ocpp    |
  +-----------------------------------------+
    `);
  });
});
