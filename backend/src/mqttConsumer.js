'use strict';
/**
 * MQTT consumer — the ingestion path from robots into the backend.
 *
 * Subscribes to:
 *   fleet/robots/+/telemetry   QoS 1 — telemetry stream from every robot
 *   fleet/robots/+/status      QoS 1 — retained online/offline announcements
 *                                    (offline arrives via the robot's Last Will)
 *
 * Every accepted message is applied to FleetState (source of truth), fanned
 * out over WebSocket, and appended to the history store. mqtt.js reconnects
 * automatically with backoff if the broker bounces, and QoS 1 subscriptions
 * mean messages published while WE are briefly down are redelivered once the
 * session resumes (clean:false gives us a persistent session).
 */
const mqtt = require('mqtt');

class MqttConsumer {
  constructor({ url, fleetState, onEvent, history }) {
    this.url = url;
    this.fleetState = fleetState;
    this.onEvent = onEvent;   // (event) => void  -> ws fanout
    this.history = history;   // HistoryStore | null
    this.client = null;
  }

  connect() {
    this.client = mqtt.connect(this.url, {
      clientId: `fleet-backend-${Math.random().toString(16).slice(2, 8)}`,
      clean: false, // persistent session: broker queues QoS1 msgs while we restart
      reconnectPeriod: 2000,
      connectTimeout: 5000,
    });

    this.client.on('connect', () => {
      console.log('[mqtt] connected to', this.url);
      this.client.subscribe(['fleet/robots/+/telemetry', 'fleet/robots/+/status'], { qos: 1 }, (err) => {
        if (err) console.error('[mqtt] subscribe failed:', err.message);
        else console.log('[mqtt] subscribed to fleet/robots/+/telemetry and /status');
      });
    });

    this.client.on('reconnect', () => console.warn('[mqtt] reconnecting...'));
    this.client.on('error', (err) => console.warn('[mqtt] error:', err.message));

    this.client.on('message', async (topic, payload) => {
      let msg;
      try { msg = JSON.parse(payload.toString()); }
      catch { console.warn('[mqtt] dropping non-JSON message on', topic); return; }

      const parts = topic.split('/'); // fleet / robots / {id} / {kind}
      const robotId = parts[2];
      const kind = parts[3];

      if (kind === 'telemetry') {
        const result = this.fleetState.applyTelemetry({ ...msg, robot_id: msg.robot_id || robotId });
        if (!result) return; // invalid or stale — already counted
        if (this.history) await this.history.record(result.event);
        this.onEvent(result.event);
      } else if (kind === 'status') {
        const change = this.fleetState.setOnline(robotId, !!msg.online);
        if (change) this.onEvent(change.event);
      }
    });
  }

  close() {
    if (this.client) this.client.end();
  }
}

module.exports = { MqttConsumer };
