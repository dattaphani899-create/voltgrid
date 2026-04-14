# VoltGrid — EV Charge Point Operator Platform

A complete CPO showcase built from scratch.

## Project structure

```
voltgrid/
├── index.html       ← Public marketing landing page
├── dashboard.html   ← Operator dashboard (live charger monitoring)
├── server.js        ← Node.js backend (OCPP WebSocket + REST API)
├── simulator.js     ← Simulates a real charger (for testing)
└── package.json
```

## How to run

### 1. Install dependencies
```bash
npm install
```

### 2. Start the backend server
```bash
node server.js
```
→ Server runs on http://localhost:3000
→ OCPP endpoint: ws://localhost:3000/ocpp/YOUR_CHARGER_ID

### 3. Open the dashboard
Open `dashboard.html` in your browser, or go to http://localhost:3000/dashboard.html

### 4. Simulate a charger (in a new terminal)
```bash
node simulator.js
```
Watch the OCPP log in your terminal and see the session appear in the dashboard.

## REST API endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | /api/chargers | List all chargers |
| GET | /api/chargers/:id | Get single charger |
| GET | /api/sessions | List sessions |
| GET | /api/energy/summary | Energy by hour |
| GET | /api/status | Server status |
| POST | /api/chargers/:id/command | Send remote command |

### Example: Remote reset a charger
```bash
curl -X POST http://localhost:3000/api/chargers/CP-001/command \
  -H "Content-Type: application/json" \
  -d '{"action": "Reset", "payload": {"type": "Soft"}}'
```

## Connecting real hardware
Point your charger's OCPP URL to:
```
ws://your-server-ip:3000/ocpp/YOUR_CHARGER_ID
```
Any OCPP 1.6 compatible charger will work — Wallbox, ABB, Easee, Alfen, etc.

## Tech stack
- **Frontend**: Plain HTML, CSS, JavaScript (no framework needed)
- **Backend**: Node.js + Express
- **Protocol**: OCPP 1.6 over WebSocket
- **Database**: SQLite (file-based, zero setup)
