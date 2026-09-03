'use strict';
/**
 * WebSocket hub — pushes fleet updates to any number of connected clients.
 *
 * Protocol (JSON, one message per line of logic):
 *   server -> client  { type: "snapshot", data: <full fleet snapshot> }   (on connect, and on {type:"snapshot"} request)
 *   server -> client  { type: "update",   data: <single robot event> }   (every ingested telemetry / online change)
 *   server -> client  { type: "pong",     ts }                           (answer to {type:"ping"})
 *   client -> server  { type: "ping" } | { type: "snapshot" }
 *
 * Flaky-client handling:
 *   - server-side ping every 30s; clients that miss two pongs are terminated.
 *   - slow clients: if a socket's bufferedAmount grows past a threshold we
 *     drop the client rather than let one bad consumer stall the fanout loop.
 */
const { WebSocketServer } = require('ws');

const PING_INTERVAL_MS = 30000;
const MAX_BUFFERED_BYTES = 1 << 20; // 1 MiB

class WsHub {
  constructor(server, fleetState) {
    this.fleetState = fleetState;
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws, req) => {
      ws.isAlive = true;
      console.log(`[ws] client connected (${req.socket.remoteAddress}), total=${this.wss.clients.size}`);

      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg.type === 'ping') this.send(ws, { type: 'pong', ts: Date.now() });
        else if (msg.type === 'snapshot') this.send(ws, { type: 'snapshot', data: this.fleetState.snapshot() });
      });
      ws.on('close', () => console.log(`[ws] client disconnected, total=${this.wss.clients.size}`));

      // every new client gets the full current state immediately, then deltas
      this.send(ws, { type: 'snapshot', data: this.fleetState.snapshot() });
    });

    this.pingTimer = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) { ws.terminate(); continue; }
        ws.isAlive = false;
        try { ws.ping(); } catch { /* closing */ }
      }
    }, PING_INTERVAL_MS);
  }

  send(ws, msg) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      console.warn('[ws] slow client exceeded buffer, terminating');
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(msg));
  }

  /** Fan one fleet event out to every live client. */
  broadcast(event) {
    const msg = JSON.stringify({ type: 'update', data: event });
    for (const ws of this.wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { ws.terminate(); continue; }
      ws.send(msg);
    }
  }

  clientCount() { return this.wss.clients.size; }

  close() {
    clearInterval(this.pingTimer);
    this.wss.close();
  }
}

module.exports = { WsHub };
