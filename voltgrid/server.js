const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const DB_FILE = path.join(__dirname, 'voltgrid.db');
let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS chargers (id TEXT PRIMARY KEY, status TEXT DEFAULT 'Unavailable', power_kw REAL DEFAULT 0, last_seen TEXT, vendor TEXT, model TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, charger_id TEXT, transaction_id INTEGER, id_tag TEXT, start_time TEXT, end_time TEXT, energy_kwh REAL DEFAULT 0, status TEXT DEFAULT 'Active');`);
  db.run(`CREATE TABLE IF NOT EXISTS meter_readings (id INTEGER PRIMARY KEY AUTOINCREMENT, charger_id TEXT, energy_wh REAL, power_w REAL, timestamp TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS ocpp_log (id INTEGER PRIMARY KEY AUTOINCREMENT, charger_id TEXT, action TEXT, payload TEXT, direction TEXT, timestamp TEXT);`);
  db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password_hash TEXT, role TEXT DEFAULT 'operator');`);
  // Seed default admin user (admin / admin123) — change password after first login
  const defaultHash = hashPassword('admin123');
  db.run(`INSERT OR IGNORE INTO users (username, password_hash, role) VALUES ('admin', '${defaultHash}', 'admin');`);
  saveDb();
  console.log('[DB] Database ready');
}

function saveDb() {
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

function query(sql, params) {
  try {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch (e) {
    console.error('[DB]', e.message);
    return [];
  }
}

function run(sql, params) {
  try {
    db.run(sql, params);
    saveDb();
  } catch (e) {
    console.error('[DB]', e.message);
  }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────
const activeSessions = new Map(); // token → { username, role, createdAt }

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
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

wss.on('connection', (ws, req) => {
  const chargerId = req.url.replace('/ocpp/', '').replace('/ocpp', '') || 'UNKNOWN';
  console.log('[OCPP] Connected:', chargerId);
  connectedChargers.set(chargerId, ws);

  run(`INSERT INTO chargers (id, last_seen) VALUES (?, datetime('now')) ON CONFLICT(id) DO UPDATE SET last_seen = datetime('now')`, [chargerId]);

  ws.on('message', (rawMsg) => {
    let msg;
    try { msg = JSON.parse(rawMsg); } catch { return; }
    const [msgType, msgId, action, payload] = msg;
    if (msgType === 2) {
      console.log('[OCPP]', chargerId, '->', action);
      run(`INSERT INTO ocpp_log (charger_id, action, payload, direction, timestamp) VALUES (?, ?, ?, 'IN', datetime('now'))`, [chargerId, action, JSON.stringify(payload)]);
      handle(ws, chargerId, msgId, action, payload);
    }
  });

  ws.on('close', () => {
    console.log('[OCPP] Disconnected:', chargerId);
    connectedChargers.delete(chargerId);
    run(`UPDATE chargers SET status = 'Offline' WHERE id = ?`, [chargerId]);
  });

  ws.on('error', (e) => console.error('[OCPP] Error:', e.message));
});

function handle(ws, id, msgId, action, payload) {
  if (action === 'BootNotification') {
    run(`UPDATE chargers SET vendor=?, model=?, status='Available', last_seen=datetime('now') WHERE id=?`, [payload.chargePointVendor || '', payload.chargePointModel || '', id]);
    respond(ws, msgId, { status: 'Accepted', currentTime: new Date().toISOString(), interval: 30 });

  } else if (action === 'Heartbeat') {
    run(`UPDATE chargers SET last_seen=datetime('now') WHERE id=?`, [id]);
    respond(ws, msgId, { currentTime: new Date().toISOString() });

  } else if (action === 'StatusNotification') {
    run(`UPDATE chargers SET status=?, last_seen=datetime('now') WHERE id=?`, [payload.status, id]);
    respond(ws, msgId, {});

  } else if (action === 'StartTransaction') {
    run(`INSERT INTO sessions (charger_id, transaction_id, id_tag, start_time, status) VALUES (?, ?, ?, datetime('now'), 'Active')`, [id, payload.transactionId || Date.now(), payload.idTag]);
    run(`UPDATE chargers SET status='Charging' WHERE id=?`, [id]);
    respond(ws, msgId, { transactionId: payload.transactionId || Date.now(), idTagInfo: { status: 'Accepted' } });

  } else if (action === 'StopTransaction') {
    run(`UPDATE sessions SET end_time=datetime('now'), energy_kwh=?, status='Completed' WHERE charger_id=? AND status='Active'`, [(payload.meterStop || 0) / 1000, id]);
    run(`UPDATE chargers SET status='Available', power_kw=0 WHERE id=?`, [id]);
    respond(ws, msgId, { idTagInfo: { status: 'Accepted' } });

  } else if (action === 'MeterValues') {
    const sv = payload.meterValue && payload.meterValue[0] && payload.meterValue[0].sampledValue;
    if (sv) {
      const energy = sv.find(v => v.measurand === 'Energy.Active.Import.Register');
      const power = sv.find(v => v.measurand === 'Power.Active.Import');
      if (energy) {
        run(`INSERT INTO meter_readings (charger_id, energy_wh, power_w, timestamp) VALUES (?, ?, ?, datetime('now'))`, [id, parseFloat(energy.value), power ? parseFloat(power.value) : 0]);
        run(`UPDATE chargers SET power_kw=? WHERE id=?`, [power ? parseFloat(power.value) / 1000 : 0, id]);
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
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  const hash = hashPassword(password);
  const users = query(`SELECT * FROM users WHERE username = ? AND password_hash = ?`, [username, hash]);
  if (users.length === 0) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const user = users[0];
  const token = generateToken();
  activeSessions.set(token, { username: user.username, role: user.role, createdAt: Date.now() });
  res.json({ token, username: user.username, role: user.role });
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
app.get('/api/chargers', requireAuth, (_req, res) => res.json(query(`SELECT * FROM chargers ORDER BY id`)));
app.get('/api/sessions', requireAuth, (_req, res) => res.json(query(`SELECT * FROM sessions ORDER BY start_time DESC LIMIT 100`)));
app.get('/api/log', requireAuth, (_req, res) => res.json(query(`SELECT * FROM ocpp_log ORDER BY timestamp DESC LIMIT 100`)));
app.get('/api/status', requireAuth, (_req, res) => res.json({
  connected: [...connectedChargers.keys()],
  chargers: (query(`SELECT COUNT(*) as c FROM chargers`)[0] || {}).c || 0,
  sessions: (query(`SELECT COUNT(*) as c FROM sessions WHERE status='Active'`)[0] || {}).c || 0,
  time: new Date().toISOString()
}));
app.post('/api/chargers/:id/command', requireAuth, (req, res) => {
  const ws = connectedChargers.get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'Not connected' });
  ws.send(JSON.stringify([2, 'cmd-' + Date.now(), req.body.action, req.body.payload || {}]));
  res.json({ sent: true });
});

initDb().then(() => {
  server.listen(3000, () => {
    console.log(`
  +-----------------------------------------+
  |  VoltGrid Backend running!              |
  |  Dashboard: http://localhost:3000/      |
  |  OCPP:      ws://localhost:3000/ocpp    |
  +-----------------------------------------+
    `);
  });
});