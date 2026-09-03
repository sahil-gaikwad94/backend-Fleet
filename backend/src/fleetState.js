'use strict';
/**
 * FleetState — the single source of truth for "what is the fleet doing NOW".
 *
 * Shape: a Map keyed by robot_id, values are flat records:
 *   {
 *     robot_id, robot_type,                    // from the roster
 *     x, y, status, battery, t,                // latest reported telemetry
 *     seq,                                     // monotonically increasing per robot
 *     online,                                  // link state (LWT / announce / watchdog)
 *     updated_at, last_seen,                   // wall-clock ms
 *     history_tail: [ ...last 20 events ]      // small ring for reconnecting clients
 *   }
 *
 * Why this shape: both the WebSocket fanout and the REST polling endpoint read
 * the SAME Map, so they can never disagree. Updates are O(1), snapshots are
 * O(n) over 8 (or a few hundred) robots, and the flat record serialises
 * straight to JSON for either transport without a transform layer.
 *
 * Ordering / dedup: every update gets a per-robot seq. Updates that arrive
 * with a stale `t` (older than what we already hold) are counted and dropped
 * — a late packet can never rewind a robot's position.
 */

const TAIL_LEN = 20;

class FleetState {
  constructor(roster = []) {
    this.robots = new Map();
    this.seq = 0;
    this.startedAt = Date.now();
    this.counters = { ingested: 0, dropped_stale: 0, dropped_invalid: 0 };
    for (const r of roster) {
      this.robots.set(r.robot_id, {
        robot_id: r.robot_id,
        robot_type: r.robot_type || 'unknown',
        x: r.start?.x ?? null,
        y: r.start?.y ?? null,
        status: 'unknown',
        battery: null,
        t: null,
        seq: 0,
        online: false,
        updated_at: null,
        last_seen: null,
        history_tail: [],
      });
    }
  }

  /** Validate + apply one telemetry event. Returns { robot, event } or null. */
  applyTelemetry(evt) {
    if (!evt || typeof evt.robot_id !== 'string') { this.counters.dropped_invalid++; return null; }
    if (!Number.isFinite(evt.x) || !Number.isFinite(evt.y) || !Number.isFinite(evt.battery)) {
      this.counters.dropped_invalid++;
      return null;
    }
    let robot = this.robots.get(evt.robot_id);
    if (!robot) {
      // unknown robot: register it rather than dropping it on the floor
      robot = {
        robot_id: evt.robot_id, robot_type: 'unknown',
        x: null, y: null, status: 'unknown', battery: null, t: null,
        seq: 0, online: false, updated_at: null, last_seen: null, history_tail: [],
      };
      this.robots.set(evt.robot_id, robot);
    }

    // out-of-order / late guard: recorded `t` must not go backwards
    if (robot.t !== null && Number.isFinite(evt.t) && evt.t < robot.t) {
      this.counters.dropped_stale++;
      return null;
    }

    robot.x = evt.x;
    robot.y = evt.y;
    robot.status = typeof evt.status === 'string' ? evt.status : robot.status;
    robot.battery = evt.battery;
    robot.t = Number.isFinite(evt.t) ? evt.t : robot.t;
    robot.seq = ++this.seq;
    robot.online = true; // a fresh message proves the link is alive
    robot.updated_at = Date.now();
    robot.last_seen = Date.now();

    const applied = {
      robot_id: robot.robot_id,
      x: robot.x, y: robot.y,
      status: robot.status, battery: robot.battery,
      t: robot.t, seq: robot.seq, online: true,
      updated_at: robot.updated_at,
    };
    if (evt.task_event) applied.task_event = evt.task_event;

    robot.history_tail.push(applied);
    if (robot.history_tail.length > TAIL_LEN) robot.history_tail.shift();

    this.counters.ingested++;
    return { robot, event: applied };
  }

  /** Mark a robot's link state (from retained status topic or watchdog). */
  setOnline(robotId, online) {
    const robot = this.robots.get(robotId);
    if (!robot || robot.online === online) return null;
    robot.online = online;
    robot.seq = ++this.seq;
    const event = {
      robot_id: robotId, online,
      status: robot.status, battery: robot.battery,
      x: robot.x, y: robot.y, t: robot.t,
      seq: robot.seq, updated_at: Date.now(),
    };
    return { robot, event };
  }

  /**
   * Watchdog sweep: any robot we haven't heard from in `staleMs` is marked
   * offline. This catches silence the broker's LWT can't see (e.g. a robot
   * process that never connected at all). Returns the list of changes.
   */
  sweepStale(staleMs) {
    const now = Date.now();
    const changes = [];
    for (const robot of this.robots.values()) {
      if (robot.online && robot.last_seen !== null && now - robot.last_seen > staleMs) {
        const change = this.setOnline(robot.robot_id, false);
        if (change) changes.push({ ...change.event, reason: 'silence_timeout' });
      }
    }
    return changes;
  }

  /** Plain-JSON snapshot of the whole fleet (what REST and WS both serve). */
  snapshot() {
    return {
      captured_at: Date.now(),
      uptime_ms: Date.now() - this.startedAt,
      counters: { ...this.counters },
      robots: [...this.robots.values()].map(({ history_tail, ...r }) => ({
        ...r,
        recent_events: history_tail.length, // count only; tail is internal
      })),
    };
  }

  getRobot(robotId) {
    const robot = this.robots.get(robotId);
    if (!robot) return null;
    const { history_tail, ...rest } = robot;
    return { ...rest, recent_events: history_tail };
  }
}

module.exports = { FleetState };
