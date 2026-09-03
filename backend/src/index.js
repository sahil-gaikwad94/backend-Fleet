'use strict';
/**
 * Backend entrypoint.
 *
 * Wires the four pieces together:
 *   MqttConsumer  -> ingests robot telemetry from the broker
 *   FleetState    -> single source of truth for current fleet state
 *   WsHub         -> pushes every state change to WebSocket clients
 *   Express REST  -> serves the same state to polling clients
 *   HistoryStore  -> (stretch) persists every event to MongoDB
 *
 * Plus a watchdog sweep that marks silent robots offline even if the
 * broker's Last-Will never had a chance to fire.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

const { FleetState } = require('./fleetState');
const { HistoryStore } = require('./history');
const { WsHub } = require('./wsHub');
const { MqttConsumer } = require('./mqttConsumer');
const { buildRouter } = require('./routes');

const PORT = Number(process.env.PORT || 8080);
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/fleet';
const STALE_MS = Number(process.env.STALE_MS || 15000);
const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 5000);
// data/ is copied next to the service in Docker (./data); when running from
// the source tree it lives one level higher (../../data). Resolve either.
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  for (const candidate of [
    path.join(__dirname, '..', 'data'),
    path.join(__dirname, '..', '..', 'data'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'robots.json'))) return candidate;
  }
  throw new Error('could not locate data/ directory (set DATA_DIR)');
}
const DATA_DIR = resolveDataDir();

async function main() {
  const roster = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'robots.json'), 'utf8'));
  const fleetState = new FleetState(roster);

  // history store is optional at runtime: connect in the BACKGROUND so a slow
  // or missing Mongo never delays the REST/WS server coming up. Live state and
  // both APIs work regardless; history endpoints 503 until the store is ready.
  const history = new HistoryStore(MONGO_URI);
  (async function connectHistory() {
    for (;;) {
      try {
        await history.connect();
        console.log('[history] connected to MongoDB');
        return;
      } catch (err) {
        console.warn('[history] MongoDB unavailable, retrying in 5s:', err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { // permissive CORS: this is a demo API
    res.set('Access-Control-Allow-Origin', '*');
    next();
  });
  app.use('/api', buildRouter({ fleetState, history }));
  // also mount at root so both /robots and /api/robots work
  app.use(buildRouter({ fleetState, history }));

  const server = http.createServer(app);
  const wsHub = new WsHub(server, fleetState);
  app.set('wsHub', wsHub);

  const consumer = new MqttConsumer({
    url: MQTT_URL,
    fleetState,
    history,
    onEvent: (event) => wsHub.broadcast(event),
  });
  consumer.connect();

  const sweepTimer = setInterval(() => {
    for (const change of fleetState.sweepStale(STALE_MS)) {
      console.log(`[watchdog] ${change.robot_id} silent for >${STALE_MS}ms -> offline`);
      wsHub.broadcast(change);
    }
  }, SWEEP_INTERVAL_MS);

  server.listen(PORT, () => {
    console.log(`[server] REST + WebSocket listening on :${PORT}`);
    console.log(`[server]   GET  /robots                 fleet snapshot (poll)`);
    console.log(`[server]   GET  /robots/:id             one robot + event tail`);
    console.log(`[server]   GET  /robots/history/:id     persisted history (stretch)`);
    console.log(`[server]   WS   /ws                     live stream (snapshot + updates)`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down`);
    clearInterval(sweepTimer);
    consumer.close();
    wsHub.close();
    await history.close().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('fatal startup error:', err);
  process.exit(1);
});
