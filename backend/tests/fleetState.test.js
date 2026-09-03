'use strict';
/**
 * Tests for FleetState — the part of the system I found trickiest, because
 * every correctness property of both APIs (REST poll + WebSocket stream)
 * reduces to "did this Map get updated correctly, exactly once, in order?".
 *
 * Covered here:
 *   1. happy-path telemetry application
 *   2. out-of-order / late updates must not rewind state
 *   3. malformed updates are rejected and counted
 *   4. online/offline transitions emit events exactly once
 *   5. the watchdog sweep flags silent robots, and only silent ones
 *   6. REST snapshot and WS-style reads are served from the same object
 */
const { FleetState } = require('../src/fleetState');

const ROSTER = [
  { robot_id: 'r1', robot_type: 'picker', start: { x: 569.9, y: 33.0 } },
  { robot_id: 'r2', robot_type: 'hauler', start: { x: 787.3, y: 65.2 } },
];

const evt = (over) => ({ robot_id: 'r1', t: 5, x: 10, y: 20, status: 'active', battery: 90, ...over });

describe('FleetState telemetry ingestion', () => {
  test('applies a valid telemetry event and stamps seq/online/timestamps', () => {
    const fs = new FleetState(ROSTER);
    const before = Date.now();
    const result = fs.applyTelemetry(evt());

    expect(result).not.toBeNull();
    const robot = fs.getRobot('r1');
    expect(robot.x).toBe(10);
    expect(robot.y).toBe(20);
    expect(robot.status).toBe('active');
    expect(robot.battery).toBe(90);
    expect(robot.online).toBe(true);
    expect(robot.seq).toBe(1);
    expect(robot.updated_at).toBeGreaterThanOrEqual(before);
    expect(fs.counters.ingested).toBe(1);
    // the event handed to the WS fanout carries the same fields
    expect(result.event).toMatchObject({ robot_id: 'r1', x: 10, seq: 1, online: true });
  });

  test('late/out-of-order events never rewind the state', () => {
    const fs = new FleetState(ROSTER);
    fs.applyTelemetry(evt({ t: 50, x: 500, battery: 50 }));
    const stale = fs.applyTelemetry(evt({ t: 10, x: 1, battery: 1 })); // arrived late
    expect(stale).toBeNull();

    const robot = fs.getRobot('r1');
    expect(robot.x).toBe(500);       // unchanged
    expect(robot.battery).toBe(50);  // unchanged
    expect(fs.counters.dropped_stale).toBe(1);
    expect(fs.counters.ingested).toBe(1);
  });

  test('same-t updates (QoS1 redelivery duplicates) still apply idempotently', () => {
    const fs = new FleetState(ROSTER);
    const a = fs.applyTelemetry(evt({ t: 5, x: 10 }));
    const b = fs.applyTelemetry(evt({ t: 5, x: 10 }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull(); // equal-t is not "stale"; the duplicate just re-stamps the same values
    expect(fs.getRobot('r1').x).toBe(10);
  });

  test('malformed payloads are rejected and counted, not applied', () => {
    const fs = new FleetState(ROSTER);
    expect(fs.applyTelemetry(null)).toBeNull();
    expect(fs.applyTelemetry({ robot_id: 42 })).toBeNull();
    expect(fs.applyTelemetry({ robot_id: 'r1', x: 'NaN-ish', y: 0, battery: 1 })).toBeNull();
    expect(fs.applyTelemetry({ robot_id: 'r1', x: 0, y: 0 })).toBeNull(); // missing battery
    expect(fs.counters.dropped_invalid).toBe(4);
    expect(fs.getRobot('r1').x).toBe(569.9); // roster start position untouched
  });

  test('unknown robots get registered rather than silently dropped', () => {
    const fs = new FleetState(ROSTER);
    const res = fs.applyTelemetry(evt({ robot_id: 'r99' }));
    expect(res).not.toBeNull();
    expect(fs.getRobot('r99')).toMatchObject({ robot_id: 'r99', robot_type: 'unknown' });
  });

  test('history tail keeps at most 20 events, newest last', () => {
    const fs = new FleetState(ROSTER);
    for (let i = 0; i < 30; i++) fs.applyTelemetry(evt({ t: i * 5 }));
    const tail = fs.getRobot('r1').recent_events;
    expect(tail).toHaveLength(20);
    expect(tail[tail.length - 1].t).toBe(145);
    expect(tail[0].t).toBe(50);
  });
});

describe('FleetState link-state and watchdog', () => {
  test('online transitions emit an event exactly once per change', () => {
    const fs = new FleetState(ROSTER);
    fs.applyTelemetry(evt()); // -> online true
    expect(fs.setOnline('r1', false)).not.toBeNull();  // first drop: event
    expect(fs.setOnline('r1', false)).toBeNull();      // already offline: no event
    expect(fs.setOnline('r1', true)).not.toBeNull();   // back online: event
    expect(fs.setOnline('r1', true)).toBeNull();       // no duplicate
  });

  test('sweep flags only robots silent past the threshold', () => {
    const fs = new FleetState(ROSTER);
    fs.applyTelemetry(evt({ robot_id: 'r1' }));
    fs.applyTelemetry(evt({ robot_id: 'r2', x: 1, y: 1 }));
    // rewind r1's last_seen into the past, leave r2 fresh
    fs.robots.get('r1').last_seen = Date.now() - 20000;

    const changes = fs.sweepStale(15000);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ robot_id: 'r1', online: false, reason: 'silence_timeout' });
    expect(fs.getRobot('r2').online).toBe(true);

    // a second sweep must not re-flag (no duplicate WS noise)
    expect(fs.sweepStale(15000)).toHaveLength(0);
  });

  test('robots that never reported are left alone by the sweep (no last_seen)', () => {
    const fs = new FleetState(ROSTER);
    expect(fs.sweepStale(1)).toHaveLength(0); // last_seen === null -> not flagged
  });
});

describe('FleetState snapshot consistency (REST vs WS)', () => {
  test('snapshot and getRobot read the same underlying values', () => {
    const fs = new FleetState(ROSTER);
    fs.applyTelemetry(evt({ t: 5, x: 42, battery: 77 }));

    const snap = fs.snapshot();
    const one = fs.getRobot('r1');
    const inSnap = snap.robots.find((r) => r.robot_id === 'r1');

    // a polling client (REST snapshot) and a streaming client (WS updates
    // built from the same record) must agree field-for-field
    for (const k of ['robot_id', 'robot_type', 'x', 'y', 'status', 'battery', 't', 'seq', 'online', 'updated_at']) {
      expect(inSnap[k]).toEqual(one[k]);
    }
    expect(inSnap.x).toBe(42);
    expect(snap.counters.ingested).toBe(1);
    // the internal tail must not leak into the bulk snapshot
    expect(inSnap.history_tail).toBeUndefined();
  });
});
