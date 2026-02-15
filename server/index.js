'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { SerialPort } = require('serialport');
const { FrameParser, CommandCodes, ResponseCodes, PushCodes, FRAME_INCOMING, FRAME_OUTGOING, FRAME_HEADER_LEN } = require('./frame-parser.js');
const weather = require('./weather.js');
const webpush = require('web-push');

// Response codes that are part of a multi-frame streaming sequence.
// Any code NOT in this set is treated as terminal (releases the queue lock).
const STREAMING_RESPONSE_CODES = new Set([
  ResponseCodes.ContactsStart,   // 2
  ResponseCodes.Contact,         // 3
  ResponseCodes.ContactMsgRecv,  // 7
  ResponseCodes.ChannelMsgRecv,  // 8
]);

// Load .env.local (check both __dirname and parent for native dev vs Docker)
const fs = require('fs');
const envLocal = [
  path.resolve(__dirname, '.env.local'),
  path.resolve(__dirname, '..', 'env.local'),
].find(p => fs.existsSync(p));
if (envLocal) {
  require('dotenv').config({ path: envLocal });
} else {
  require('dotenv').config();
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const SERIAL_PORT = process.env.SERIAL_PORT || '/dev/ttyACM0';
const SERIAL_BAUD = parseInt(process.env.SERIAL_BAUD, 10) || 115200;
const HTTP_PORT = parseInt(process.env.HTTP_PORT, 10) || 8080;
const WS_PORT = parseInt(process.env.WS_PORT, 10) || 3000;
const TCP_PORT = parseInt(process.env.TCP_PORT, 10) || 5000;
const PUSH_BUFFER_SIZE = parseInt(process.env.PUSH_BUFFER_SIZE, 10) || 1000;
const COMMAND_TIMEOUT_MS = parseInt(process.env.COMMAND_TIMEOUT_MS, 10) || 30000;

// ---------------------------------------------------------------------------
// VAPID keys for Web Push
// ---------------------------------------------------------------------------
const VAPID_KEYS_PATH = path.resolve(__dirname, '.vapid-keys.json');
let vapidKeys;
if (fs.existsSync(VAPID_KEYS_PATH)) {
  vapidKeys = JSON.parse(fs.readFileSync(VAPID_KEYS_PATH, 'utf8'));
} else {
  vapidKeys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_KEYS_PATH, JSON.stringify(vapidKeys, null, 2));
}
webpush.setVapidDetails(
  'mailto:meshcore@localhost',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

// Web Push subscriptions (in-memory, keyed by endpoint)
const pushSubscriptions = new Map();

// Push notification types worth notifying about
const NOTIFY_PUSH_CODES = new Set([PushCodes.MsgWaiting, PushCodes.RawData]);

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const log = {
  info: (...args) => console.log(new Date().toISOString(), '[INFO]', ...args),
  warn: (...args) => console.warn(new Date().toISOString(), '[WARN]', ...args),
  error: (...args) => console.error(new Date().toISOString(), '[ERROR]', ...args),
  debug: (...args) => {
    if (process.env.DEBUG) console.log(new Date().toISOString(), '[DEBUG]', ...args);
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let serial = null;
const frameParser = new FrameParser();
let wsClients = new Set();
let tcpClients = new Set();

// Push notification buffer for replay on WebSocket connect
// Persisted to disk so history survives server restarts.
const PUSH_HISTORY_PATH = path.resolve(__dirname, '.push-history.json');
const pushBuffer = loadPushHistory(); // Array of { frame: Buffer, timestamp: number }
let pushHistoryDirty = false;
let pushHistoryTimer = null;

function loadPushHistory() {
  try {
    if (fs.existsSync(PUSH_HISTORY_PATH)) {
      const entries = JSON.parse(fs.readFileSync(PUSH_HISTORY_PATH, 'utf8'));
      return entries.map(e => ({ frame: Buffer.from(e.frame, 'base64'), timestamp: e.timestamp }));
    }
  } catch (err) {
    // Corrupted file — start fresh
  }
  return [];
}

function savePushHistory() {
  pushHistoryDirty = false;
  try {
    const entries = pushBuffer.map(e => ({ frame: e.frame.toString('base64'), timestamp: e.timestamp }));
    fs.writeFileSync(PUSH_HISTORY_PATH, JSON.stringify(entries));
  } catch (err) {
    // Non-fatal — will retry on next buffer change
  }
}

function schedulePushHistorySave() {
  pushHistoryDirty = true;
  if (!pushHistoryTimer) {
    pushHistoryTimer = setTimeout(() => {
      pushHistoryTimer = null;
      if (pushHistoryDirty) savePushHistory();
    }, 5000);
  }
}

function bufferPushNotification(rawFrame) {
  pushBuffer.push({ frame: rawFrame, timestamp: Date.now() });
  while (pushBuffer.length > PUSH_BUFFER_SIZE) {
    pushBuffer.shift();
  }
  schedulePushHistorySave();
}

// Device info retrieved at startup
let deviceName = null;
let devicePublicKey = null;
let startupComplete = false;

// Pending startup responses
let pendingResolve = null;

// ---------------------------------------------------------------------------
// Command Queue — serializes access to the serial port
// ---------------------------------------------------------------------------
// The companion protocol has no request IDs, so we must send one command at a
// time and wait for the response before sending the next. Push notifications
// (code >= 0x80) are always broadcast to all clients regardless.
const commandQueue = [];
let currentCommand = null; // { data, source, timer }

function enqueueCommand(data, source) {
  commandQueue.push({ data, source });
  drainQueue();
}

function drainQueue() {
  if (!startupComplete) return;  // don't send client commands during startup
  if (currentCommand) return;    // already processing
  if (commandQueue.length === 0) return;
  if (!serial || !serial.isOpen) return;

  currentCommand = commandQueue.shift();
  currentCommand.timer = setTimeout(() => {
    // Response timeout — release the lock so the queue keeps moving
    log.debug('[QUEUE] Command timed out, moving on');
    currentCommand = null;
    drainQueue();
  }, COMMAND_TIMEOUT_MS);

  serial.write(currentCommand.data);
}

function resolveCurrentCommand() {
  if (!currentCommand) return;
  clearTimeout(currentCommand.timer);
  currentCommand = null;
  // Process next command on next tick to avoid re-entrancy
  setImmediate(drainQueue);
}

function resetCommandTimeout() {
  if (!currentCommand) return;
  clearTimeout(currentCommand.timer);
  currentCommand.timer = setTimeout(() => {
    log.debug('[QUEUE] Command timed out, moving on');
    currentCommand = null;
    drainQueue();
  }, COMMAND_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Serial Port
// ---------------------------------------------------------------------------
function resetState() {
  serial = null;
  startupComplete = false;
  frameParser.buffer = [];

  // Cancel any in-flight command
  if (currentCommand) {
    clearTimeout(currentCommand.timer);
    currentCommand = null;
  }

  // Clear pending startup resolve
  if (pendingResolve) {
    pendingResolve = null;
  }

  // Drop stale queued commands
  commandQueue.length = 0;
}

function openSerial() {
  log.info(`[SERIAL] Opening ${SERIAL_PORT} at ${SERIAL_BAUD} baud`);

  serial = new SerialPort({
    path: SERIAL_PORT,
    baudRate: SERIAL_BAUD,
    autoOpen: false,
  });

  serial.on('error', (err) => {
    log.error(`[SERIAL] Error: ${err.message}`);
  });

  serial.on('close', () => {
    log.warn('[SERIAL] Port closed, reconnecting in 5s...');
    resetState();
    setTimeout(openSerial, 5000);
  });

  serial.on('data', (data) => {
    const frames = frameParser.feed(data);
    for (const frame of frames) {
      handleIncomingFrame(frame);
    }
  });

  serial.open((err) => {
    if (err) {
      log.error(`[SERIAL] Failed to open: ${err.message}`);
      log.info('[SERIAL] Retrying in 5s...');
      setTimeout(openSerial, 5000);
      return;
    }
    log.info('[SERIAL] Port opened');
    startDeviceQuery();
  });
}

// ---------------------------------------------------------------------------
// Startup: query device for identity and keys
// ---------------------------------------------------------------------------
async function startDeviceQuery() {
  log.info('[STARTUP] Querying device...');

  // Small delay to let device stabilize
  await sleep(500);

  // Step 1: Send AppStart (command code 1) to get SelfInfo
  // Format: [cmd] [appVer] [6 reserved bytes] [appName string + null terminator]
  try {
    const appName = 'meshcore-station';
    const appStartPayload = Buffer.alloc(1 + 1 + 6 + appName.length);
    appStartPayload[0] = CommandCodes.AppStart;
    appStartPayload[1] = 1; // appVer
    // bytes 2-7 are reserved (zeros)
    appStartPayload.write(appName, 8, 'utf8');

    const selfInfo = await sendCommandAndWait(
      appStartPayload,
      ResponseCodes.SelfInfo,
      5000
    );
    if (selfInfo) {
      const info = FrameParser.parseSelfInfo(selfInfo);
      if (info) {
        devicePublicKey = info.publicKey;
        deviceName = info.name;
        log.info(`[STARTUP] Device name: ${deviceName}`);
        log.info(`[STARTUP] Public key: ${devicePublicKey}`);
      }
    }
  } catch (err) {
    log.error(`[STARTUP] Failed to get self info: ${err.message}`);
  }

  startupComplete = true;

  // Drain any commands that were queued while startup was in progress
  log.info(`[STARTUP] Complete — draining ${commandQueue.length} queued client commands`);
  drainQueue();
}

function sendCommandAndWait(commandPayload, expectedResponseCode, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResolve = null;
      reject(new Error('Timeout waiting for device response'));
    }, timeoutMs);

    pendingResolve = { expectedResponseCode, resolve: (payload) => {
      clearTimeout(timer);
      pendingResolve = null;
      resolve(payload);
    }};

    // Send the command via serial
    const frame = FrameParser.buildOutgoingFrame(commandPayload);
    if (serial && serial.isOpen) {
      serial.write(frame);
    } else {
      clearTimeout(timer);
      pendingResolve = null;
      reject(new Error('Serial port not open'));
    }
  });
}

// ---------------------------------------------------------------------------
// Frame handling
// ---------------------------------------------------------------------------
function handleIncomingFrame(frame) {
  if (frame.type !== FRAME_INCOMING) return;
  const payload = frame.payload;
  if (!payload || payload.length === 0) return;

  const responseCode = payload[0];
  const isPush = FrameParser.isPushNotification(payload);

  // During startup, check for pending command responses
  if (pendingResolve && responseCode === pendingResolve.expectedResponseCode) {
    pendingResolve.resolve(payload);
    return;
  }

  // Build the raw frame bytes
  const rawFrame = Buffer.alloc(FRAME_HEADER_LEN + payload.length);
  rawFrame[0] = FRAME_INCOMING;
  rawFrame[1] = payload.length & 0xff;
  rawFrame[2] = (payload.length >> 8) & 0xff;
  payload.copy(rawFrame, FRAME_HEADER_LEN);

  if (isPush) {
    // Push notifications: buffer and broadcast to ALL clients
    bufferPushNotification(rawFrame);
    broadcastToAll(rawFrame);
    log.debug(`[PUSH] code=0x${responseCode.toString(16)} (buffer: ${pushBuffer.length}/${PUSH_BUFFER_SIZE})`);

    // Send Web Push notification for interesting types
    if (NOTIFY_PUSH_CODES.has(responseCode) && pushSubscriptions.size > 0) {
      sendWebPush(payload);
    }
  } else {
    // Command response: send only to the client that sent the command
    if (currentCommand && currentCommand.source) {
      sendToClient(currentCommand.source, rawFrame);
    } else {
      // No tracked source (e.g. startup) — broadcast as fallback
      broadcastToAll(rawFrame);
    }
    if (STREAMING_RESPONSE_CODES.has(responseCode)) {
      resetCommandTimeout();
    } else {
      resolveCurrentCommand();
    }
  }
}

function broadcastToAll(rawFrame) {
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(rawFrame);
  }
  for (const sock of tcpClients) {
    if (!sock.destroyed) sock.write(rawFrame);
  }
}

function sendToClient(source, rawFrame) {
  // source is either a WebSocket or a TCP socket
  if (source._isWebSocket) {
    if (source.readyState === 1) source.send(rawFrame);
  } else {
    if (!source.destroyed) source.write(rawFrame);
  }
}

function sendWebPush(payload) {
  const parsed = FrameParser.parsePushNotification(payload);
  if (!parsed) return;

  const pushPayload = JSON.stringify({
    title: 'MeshCore',
    body: formatPushBody(parsed),
    data: { type: parsed.type },
  });

  for (const [endpoint, sub] of pushSubscriptions) {
    webpush.sendNotification(sub, pushPayload).catch((err) => {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired or invalid — remove it
        pushSubscriptions.delete(endpoint);
        log.info(`[PUSH] Removed expired subscription (${pushSubscriptions.size} remaining)`);
      } else {
        log.error(`[PUSH] Web Push error: ${err.message}`);
      }
    });
  }
}

function formatPushBody(parsed) {
  switch (parsed.type) {
    case 'msg_waiting':
      return 'New message waiting';
    case 'raw_data':
      return `Raw data received (SNR: ${parsed.snr}, RSSI: ${parsed.rssi})`;
    default:
      return `Mesh event: ${parsed.type}`;
  }
}

// ---------------------------------------------------------------------------
// WebSocket Server
// ---------------------------------------------------------------------------
function startWebSocketServer() {
  const wss = new WebSocketServer({ port: WS_PORT });

  wss.on('listening', () => {
    log.info(`[WS] WebSocket server listening on :${WS_PORT}`);
  });

  wss.on('connection', (ws, req) => {
    const addr = req.socket.remoteAddress;
    log.info(`[WS] Client connected from ${addr}`);

    ws._isWebSocket = true; // Tag for sendToClient
    ws._replayDone = false;
    wsClients.add(ws);

    ws.on('message', (data) => {
      enqueueCommand(Buffer.from(data), ws);

      // Replay push buffer after the client's first command — the app needs
      // time to initialize (AppStart → SelfInfo, load contacts, etc.) before
      // it can process historical push notifications.
      if (!ws._replayDone && pushBuffer.length > 0) {
        ws._replayDone = true;
        setTimeout(() => {
          if (ws.readyState !== 1) return;
          log.info(`[WS] Replaying ${pushBuffer.length} buffered push notifications`);
          for (const entry of pushBuffer) {
            if (ws.readyState === 1) ws.send(entry.frame);
          }
        }, 3000);
      }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      log.info(`[WS] Client disconnected (${wsClients.size} remaining)`);
    });

    ws.on('error', (err) => {
      log.error(`[WS] Client error: ${err.message}`);
      wsClients.delete(ws);
    });
  });

  wss.on('error', (err) => {
    log.error(`[WS] Server error: ${err.message}`);
  });

  return wss;
}

// ---------------------------------------------------------------------------
// TCP Server (companion protocol for meshcore-ha and other TCP clients)
// ---------------------------------------------------------------------------
const net = require('net');

function startTCPServer() {
  const server = net.createServer((socket) => {
    const addr = socket.remoteAddress + ':' + socket.remotePort;
    log.info(`[TCP] Client connected from ${addr}`);

    if (tcpClients.size > 0) {
      log.warn('[TCP] Multiple TCP clients connected — command interleaving may occur');
    }

    tcpClients.add(socket);

    // TCP data arrives as a stream — may contain partial or multiple frames.
    // Buffer and parse into individual frames before queuing.
    const tcpParser = new FrameParser();
    socket.on('data', (data) => {
      const frames = tcpParser.feed(data);
      for (const frame of frames) {
        // Re-frame and enqueue
        const raw = FrameParser.buildFrame(frame.type, frame.payload);
        enqueueCommand(raw, socket);
      }
    });

    socket.on('close', () => {
      tcpClients.delete(socket);
      log.info(`[TCP] Client disconnected (${tcpClients.size} remaining)`);
    });

    socket.on('error', (err) => {
      log.error(`[TCP] Client error: ${err.message}`);
      tcpClients.delete(socket);
    });
  });

  server.listen(TCP_PORT, () => {
    log.info(`[TCP] Companion protocol server listening on :${TCP_PORT}`);
  });

  server.on('error', (err) => {
    log.error(`[TCP] Server error: ${err.message}`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP Server — reverse proxy for app.meshcore.nz with WebSerial polyfill
// ---------------------------------------------------------------------------
const https = require('https');

const UPSTREAM = 'https://app.meshcore.nz';
const POLYFILL_PATH = path.resolve(__dirname, 'webserial-polyfill.js');
const PUSH_WORKER_PATH = path.resolve(__dirname, 'push-worker.js');

function startHTTPServer() {
  const app = express();

  // Serve the polyfill script directly
  app.get('/__polyfill.js', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(POLYFILL_PATH);
  });

  // Serve the push service worker (must be at root scope for SW scope rules)
  app.get('/__push-worker.js', (_req, res) => {
    res.type('application/javascript');
    res.sendFile(PUSH_WORKER_PATH);
  });

  // Push notification API routes
  app.get('/__push/vapid-key', (_req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  app.post('/__push/subscribe', express.json(), (req, res) => {
    const sub = req.body;
    if (!sub || !sub.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    pushSubscriptions.set(sub.endpoint, sub);
    log.info(`[PUSH] Subscription added (${pushSubscriptions.size} total)`);
    res.json({ ok: true });
  });

  app.post('/__push/unsubscribe', express.json(), (req, res) => {
    const sub = req.body;
    if (sub && sub.endpoint) {
      pushSubscriptions.delete(sub.endpoint);
      log.info(`[PUSH] Subscription removed (${pushSubscriptions.size} total)`);
    }
    res.json({ ok: true });
  });

  // Proxy everything else to app.meshcore.nz, injecting polyfill into HTML
  app.get('*', (req, res) => {
    const url = UPSTREAM + req.url;

    https.get(url, { headers: { 'Accept-Encoding': 'identity' } }, (upstream) => {
      // If redirected, follow
      if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
        const loc = upstream.headers.location.replace(UPSTREAM, '');
        res.redirect(upstream.statusCode, loc);
        return;
      }

      const contentType = upstream.headers['content-type'] || '';
      const isHTML = contentType.includes('text/html');

      // Forward headers (skip encoding/length since we may modify body)
      for (const [key, val] of Object.entries(upstream.headers)) {
        if (['content-length', 'content-encoding', 'transfer-encoding', 'content-security-policy'].includes(key)) continue;
        res.setHeader(key, val);
      }
      res.status(upstream.statusCode);

      if (isHTML) {
        // Collect body, inject polyfill before </head> or at top of <body>
        const chunks = [];
        upstream.on('data', (c) => chunks.push(c));
        upstream.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8');
          const polyfillTag = '<script src="/__polyfill.js"></script>';

          if (body.includes('<head>')) {
            body = body.replace('<head>', '<head>' + polyfillTag);
          } else if (body.includes('<body')) {
            body = body.replace(/<body[^>]*>/, (m) => m + polyfillTag);
          } else {
            body = polyfillTag + body;
          }

          res.send(body);
        });
      } else {
        // Stream non-HTML resources as-is
        upstream.pipe(res);
      }
    }).on('error', (err) => {
      log.error(`[PROXY] Error fetching ${url}: ${err.message}`);
      res.status(502).send('Upstream error');
    });
  });

  const server = http.createServer(app);
  server.listen(HTTP_PORT, () => {
    log.info(`[HTTP] Proxying app.meshcore.nz on :${HTTP_PORT} (with WebSerial polyfill)`);
  });

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
let stopWeather = () => {};

function shutdown() {
  log.info('Shutting down...');
  stopWeather();
  if (pushHistoryDirty) savePushHistory();
  if (serial && serial.isOpen) {
    serial.close();
  }
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
log.info('=== MeshCore Station ===');
log.info(`Serial: ${SERIAL_PORT} @ ${SERIAL_BAUD}`);
log.info(`HTTP:   :${HTTP_PORT}`);
log.info(`WS:     :${WS_PORT}`);
log.info(`TCP:    :${TCP_PORT}`);
log.info(`Push buffer: ${PUSH_BUFFER_SIZE} max, ${pushBuffer.length} loaded from disk`);
log.info(`Cmd timeout: ${COMMAND_TIMEOUT_MS}ms`);
log.info(`VAPID public key: ${vapidKeys.publicKey}`);

startHTTPServer();
startWebSocketServer();
startTCPServer();
openSerial();

stopWeather = weather.start({
  enqueueCommand,
  buildOutgoingFrame: FrameParser.buildOutgoingFrame,
  isReady: () => startupComplete && serial && serial.isOpen,
  log,
});
