#!/usr/bin/env node
/**
 * One mocked robot.
 *
 * Replays its own slice of events.jsonl, in order, onto MQTT — standing in
 * for what that physical robot would report live.
 *
 * Topics:
 *   fleet/robots/{id}/telemetry   QoS 1, retained=false — the event stream
 *   fleet/robots/{id}/status      QoS 1, retained=true  — "online"/"offline"
 *
 * Connection behaviour:
 *   - A Last-Will publishes "offline" (retained) if this robot's link drops
 *     ungracefully, so the backend learns about it even with nobody watching.
 *   - On boot it publishes "online" (retained) before the first telemetry.
 *   - If the broker is unreachable, mqtt.js buffers outbound packets and
 *     reconnects with backoff — the robot keeps "recording" and back-fills
 *     once the link heals, like store-and-forward on real hardware.
 *   - CHAOS=1 randomly severs the TCP link for 3-10s at a time to demo
 *     disconnect/reconnect and LWT handling end to end.
 *
 * Pacing: events carry their own timestamps `t` (seconds, 0..900). The robot
 * waits (t_next - t_prev) / REPLAY_SPEED between publishes, then loops the
 * log forever.
 */
'use strict';

const path = require('path');
const mqtt = require('mqtt');
const { loadEventsForRobot } = require('./logLoader');

const ROBOT_ID = process.env.ROBOT_ID;
const ROBOT_TYPE = process.env.ROBOT_TYPE || 'unknown';
const MQTT_URL = process.env.MQTT_URL || 'mqtt://localhost:1883';
const REPLAY_SPEED = Number(process.env.REPLAY_SPEED || '1');
const CHAOS = process.env.CHAOS === '1';
function resolveDataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const fs = require('fs');
  for (const candidate of [
    path.join(__dirname, '..', 'data'),
    path.join(__dirname, '..', '..', 'data'),
  ]) {
    if (fs.existsSync(path.join(candidate, 'robots.json'))) return candidate;
  }
  throw new Error('could not locate data/ directory (set DATA_DIR)');
}
const DATA_DIR = resolveDataDir();

if (!ROBOT_ID) {
  console.error('ROBOT_ID is required');
  process.exit(1);
}

const TELEMETRY_TOPIC = `fleet/robots/${ROBOT_ID}/telemetry`;
const STATUS_TOPIC = `fleet/robots/${ROBOT_ID}/status`;

async function loadMyEvents() {
  const events = await loadEventsForRobot(path.join(DATA_DIR, 'events.jsonl'), ROBOT_ID);
  if (events.length === 0) throw new Error(`no events found for ${ROBOT_ID}`);
  return events;
}

function publish(client, topic, payload, opts = {}) {
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1, ...opts }, (err) =>
      err ? reject(err) : resolve());
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const events = await loadMyEvents();
  console.log(`[${ROBOT_ID}] loaded ${events.length} recorded events (t=${events[0].t}..${events[events.length - 1].t})`);

  const client = mqtt.connect(MQTT_URL, {
    clientId: `robot-${ROBOT_ID}-${Math.random().toString(16).slice(2, 8)}`,
    clean: true,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
    queueQoSZero: true,
    // Last Will: broker publishes this for us if the TCP link dies silently.
    will: {
      topic: STATUS_TOPIC,
      payload: JSON.stringify({ robot_id: ROBOT_ID, online: false, ts: 0 }),
      qos: 1,
      retain: true,
    },
  });

  client.on('error', (err) => console.warn(`[${ROBOT_ID}] mqtt error: ${err.message}`));
  client.on('reconnect', () => console.warn(`[${ROBOT_ID}] reconnecting to broker...`));
  client.on('offline', () => console.warn(`[${ROBOT_ID}] link down, buffering telemetry`));
  client.on('connect', async () => {
    await publish(client, STATUS_TOPIC, { robot_id: ROBOT_ID, online: true, robot_type: ROBOT_TYPE, ts: Date.now() }, { retain: true });
    console.log(`[${ROBOT_ID}] connected, announced online`);
  });

  // optional chaos monkey: sever and restore the TCP link at random
  if (CHAOS) {
    const chaosLoop = async () => {
      for (;;) {
        await sleep(20000 + Math.random() * 40000);
        console.warn(`[${ROBOT_ID}] CHAOS: cutting link`);
        client.end(true); // hard close -> broker fires the Last Will
        await sleep(3000 + Math.random() * 7000);
        console.warn(`[${ROBOT_ID}] CHAOS: restoring link`);
        client.reconnect();
      }
    };
    chaosLoop().catch(() => {});
  }

  // replay loop (forever). `t` must keep counting up across laps: the
  // backend's stale-event guard (FleetState.applyTelemetry) rejects any `t`
  // older than what it already holds, so restarting the log at t=0 every lap
  // would get every robot's first lap-2 event dropped as stale -- and every
  // event after that, forever, since the guard never lets `t` go backwards.
  // lapOffset keeps `t` monotonic across laps so the guard doesn't fire.
  const LAP_PERIOD = events[events.length - 1].t + 1; // > any t within one lap
  let lapOffset = 0;
  for (;;) {
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (i > 0) {
        const dt = (evt.t - events[i - 1].t) * 1000;
        await sleep(Math.max(0, dt / REPLAY_SPEED));
      } else {
        await sleep(500);
      }
      const payload = {
        robot_id: evt.robot_id,
        t: evt.t + lapOffset,
        x: evt.x,
        y: evt.y,
        status: evt.status,
        battery: evt.battery,
        sent_at: Date.now(), // wall-clock stamp so the backend can measure staleness
      };
      if (evt.task_event) payload.task_event = evt.task_event;
      try {
        await publish(client, TELEMETRY_TOPIC, payload);
      } catch (err) {
        console.warn(`[${ROBOT_ID}] publish failed (will retry on next event): ${err.message}`);
      }
    }
    lapOffset += LAP_PERIOD;
    console.log(`[${ROBOT_ID}] log finished, looping (next lap starts at t=${lapOffset})`);
    await sleep(2000);
  }
}

process.on('SIGTERM', () => { console.log(`[${ROBOT_ID}] SIGTERM, exiting`); process.exit(0); });
process.on('SIGINT', () => process.exit(0));

main().catch((err) => {
  console.error(`[${ROBOT_ID}] fatal:`, err);
  process.exit(1);
});
