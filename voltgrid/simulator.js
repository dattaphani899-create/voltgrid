/**
 * VoltGrid — OCPP Charger Simulator (Fixed)
 * Run this while server.js is running to simulate a real charger.
 *
 * HOW TO RUN:
 *   node simulator.js
 */

const WebSocket = require('ws');

const CHARGER_ID = 'SIM-001';
const SERVER_URL = `ws://localhost:3000/ocpp/${CHARGER_ID}`;

let msgCounter = 1;
let transactionId = null;
let energyWh = 0;
let meterInterval = null;

function getMsgId() {
  return `msg-${msgCounter++}`;
}

console.log(`[SIM] Connecting to ${SERVER_URL} ...`);

const ws = new WebSocket(SERVER_URL, 'ocpp1.6', {
  rejectUnauthorized: false,
  headers: {
    'Sec-WebSocket-Protocol': 'ocpp1.6'
  }
});

ws.on('open', () => {
  console.log(`[SIM] ✅ Connected to VoltGrid server as ${CHARGER_ID}`);

  // Step 1: Boot notification
  sendCall('BootNotification', {
    chargePointVendor: 'VoltGrid-Sim',
    chargePointModel: 'Simulator-22kW',
    chargePointSerialNumber: 'SIM-SN-001',
    firmwareVersion: '1.0.0'
  });
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const [type, id, payload] = msg;

  if (type === 3) {
    // Response from server
    console.log(`[SIM] ← Server response:`, JSON.stringify(payload));

    // After BootNotification accepted → go Available → then start charging
    if (payload && payload.status === 'Accepted' && payload.interval) {
      console.log('[SIM] Boot accepted! Setting status to Available...');

      setTimeout(() => {
        sendCall('StatusNotification', {
          connectorId: 1,
          status: 'Available',
          errorCode: 'NoError',
          timestamp: new Date().toISOString()
        });

        // Wait 3 seconds then simulate a car plugging in
        setTimeout(() => {
          startSession();
        }, 3000);

      }, 1000);
    }
  }
});

function startSession() {
  transactionId = Date.now();
  energyWh = 0;
  console.log('\n[SIM] 🚗 Car plugged in! Starting charging session...');

  sendCall('StartTransaction', {
    connectorId: 1,
    idTag: 'RFID-SIM-001',
    meterStart: 0,
    transactionId: transactionId,
    timestamp: new Date().toISOString()
  });

  sendCall('StatusNotification', {
    connectorId: 1,
    status: 'Charging',
    errorCode: 'NoError',
    timestamp: new Date().toISOString()
  });

  console.log('[SIM] ⚡ Charging at 22kW — sending meter values every 10 seconds...');

  // Send meter values every 10 seconds
  meterInterval = setInterval(() => {
    energyWh += 367; // 22kW over 10 seconds = ~367 Wh

    console.log(`[SIM] 📊 Meter reading: ${(energyWh/1000).toFixed(2)} kWh`);

    sendCall('MeterValues', {
      connectorId: 1,
      transactionId: transactionId,
      meterValue: [{
        timestamp: new Date().toISOString(),
        sampledValue: [
          {
            value: String(energyWh),
            measurand: 'Energy.Active.Import.Register',
            unit: 'Wh',
            context: 'Sample.Periodic'
          },
          {
            value: '22000',
            measurand: 'Power.Active.Import',
            unit: 'W',
            context: 'Sample.Periodic'
          },
          {
            value: '230',
            measurand: 'Voltage',
            unit: 'V'
          },
          {
            value: '32',
            measurand: 'Current.Import',
            unit: 'A'
          }
        ]
      }]
    });

    // Stop after ~6 kWh (about 60 meter readings of 10s each = ~10 min demo)
    if (energyWh >= 6000) {
      clearInterval(meterInterval);
      stopSession();
    }

  }, 10000);
}

function stopSession() {
  console.log('\n[SIM] 🔌 Car unplugged — stopping session...');

  sendCall('StopTransaction', {
    transactionId: transactionId,
    meterStop: energyWh,
    timestamp: new Date().toISOString(),
    reason: 'EVDisconnected',
    idTag: 'RFID-SIM-001'
  });

  sendCall('StatusNotification', {
    connectorId: 1,
    status: 'Available',
    errorCode: 'NoError',
    timestamp: new Date().toISOString()
  });

  console.log(`[SIM] ✅ Session complete! ${(energyWh/1000).toFixed(2)} kWh delivered.`);
  console.log('[SIM] Sending heartbeats every 30 seconds...\n');

  // Keep sending heartbeats to stay connected
  setInterval(() => {
    console.log('[SIM] 💓 Heartbeat sent');
    sendCall('Heartbeat', {});
  }, 30000);
}

function sendCall(action, payload) {
  const id = getMsgId();
  const msg = JSON.stringify([2, id, action, payload]);
  console.log(`[SIM] → ${action}`);
  ws.send(msg);
}

ws.on('error', (err) => {
  console.error('\n[SIM] ❌ Connection error:', err.message);
  console.error('[SIM]    Make sure server.js is running in Terminal 1!\n');
});

ws.on('close', () => {
  console.log('[SIM] Disconnected from server');
  if (meterInterval) clearInterval(meterInterval);
});

// Send heartbeat every 30s to keep connection alive
setInterval(() => {}, 1000);
