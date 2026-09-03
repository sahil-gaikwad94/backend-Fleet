#!/usr/bin/env node
/**
 * One-off tool: reconstructs a plausible events.jsonl for the hiring challenge.
 *
 * The original events.jsonl was only available as a partial screenshot
 * (t=0 fully, t=5 mostly). This generator:
 *   - hard-codes the 14 fully legible screenshot lines verbatim,
 *   - infers r7/r8 @ t=5 by the log's own convention (battery -0.1 for idle
 *     robots, position unchanged while idle),
 *   - extends the log to t=900 with a small scripted simulation that respects
 *     the obstacle rectangles measured from layout.png, drains battery while
 *     moving, recharges while charging, and emits a couple of rare
 *     task_started / task_completed extras exactly as the assignment describes.
 *
 * Deterministic (seeded PRNG) so the file is reproducible.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ---------- deterministic PRNG (mulberry32) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260901);

// ---------- world ----------
const W = 900, H = 560;
const OBSTACLES = [
  { x1: 150, y1: 80,  x2: 350, y2: 140 },
  { x1: 150, y1: 220, x2: 350, y2: 280 },
  { x1: 150, y1: 360, x2: 350, y2: 420 },
  { x1: 500, y1: 60,  x2: 560, y2: 460 },  // central wall
  { x1: 649, y1: 150, x2: 850, y2: 200 },
  { x1: 650, y1: 340, x2: 850, y2: 390 },
];
const MARGIN = 2; // small safety margin for path planning only
const inObstacle = (x, y, margin = MARGIN) =>
  OBSTACLES.some(o => x > o.x1 - margin && x < o.x2 + margin && y > o.y1 - margin && y < o.y2 + margin);
const strictlyInside = (x, y) =>
  OBSTACLES.some(o => x >= o.x1 && x <= o.x2 && y >= o.y1 && y <= o.y2);

// charger pads sit in open space, away from obstacles
const CHARGERS = [
  { x: 80,  y: 520 }, { x: 420, y: 520 },
  { x: 620, y: 500 }, { x: 860, y: 480 },
];
const nearestCharger = (x, y) => {
  let best = null, bd = Infinity;
  for (const c of CHARGERS) {
    const d = (c.x - x) ** 2 + (c.y - y) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
};
const randomFreePoint = () => {
  for (let i = 0; i < 200; i++) {
    const x = 20 + rand() * (W - 40);
    const y = 20 + rand() * (H - 40);
    if (!inObstacle(x, y)) return { x, y };
  }
  return { x: 450, y: 30 };
};

// ---------- t = 0 and t = 5, verbatim from the screenshot ----------
const LINES_T0 = [
  { t: 0, robot_id: 'r1', x: 569.9, y: 33.0,  status: 'idle', battery: 84.4 },
  { t: 0, robot_id: 'r2', x: 787.3, y: 65.2,  status: 'idle', battery: 75.8 },
  { t: 0, robot_id: 'r3', x: 382.9, y: 35.5,  status: 'idle', battery: 47.1 },
  { t: 0, robot_id: 'r4', x: 208.0, y: 282.8, status: 'idle', battery: 32.3 },
  { t: 0, robot_id: 'r5', x: 42.8,  y: 123.4, status: 'idle', battery: 96.5 },
  { t: 0, robot_id: 'r6', x: 578.9, y: 303.4, status: 'idle', battery: 46.8 },
  { t: 0, robot_id: 'r7', x: 209.6, y: 326.4, status: 'idle', battery: 27.4 },
  { t: 0, robot_id: 'r8', x: 716.1, y: 23.4,  status: 'idle', battery: 27.7 },
];
// t=5: r1, r5 active (moved); r6 unchanged; others -0.1 battery (idle drain).
// r7/r8 were cut off in the screenshot -> inferred with the same convention.
const LINES_T5 = [
  { t: 5, robot_id: 'r1', x: 580.9, y: 29.4,  status: 'active', battery: 83.8 },
  { t: 5, robot_id: 'r2', x: 787.3, y: 65.2,  status: 'idle',   battery: 75.8 },
  { t: 5, robot_id: 'r3', x: 382.9, y: 35.5,  status: 'idle',   battery: 47.0 },
  { t: 5, robot_id: 'r4', x: 208.0, y: 282.8, status: 'idle',   battery: 32.2 },
  { t: 5, robot_id: 'r5', x: 43.8,  y: 115.7, status: 'active', battery: 95.9 },
  { t: 5, robot_id: 'r6', x: 578.9, y: 303.4, status: 'idle',   battery: 46.7 },
  { t: 5, robot_id: 'r7', x: 209.6, y: 326.4, status: 'idle',   battery: 27.3 }, // inferred
  { t: 5, robot_id: 'r8', x: 716.1, y: 23.4,  status: 'idle',   battery: 27.6 }, // inferred
];

// ---------- fleet model ----------
const SPEED = 1.6;          // units per second -> 8 units per 5s tick
const TICK = 5;
const robots = new Map();
for (const e of LINES_T5) {
  robots.set(e.robot_id, {
    id: e.robot_id, x: e.x, y: e.y, battery: e.battery,
    mode: e.status === 'active' ? 'active' : 'idle',
    tx: null, ty: null, // waypoint
    modeLeft: 0,        // ticks left in current mode
    offlineLeft: 0,
    taskPending: false,
  });
}

function pickWaypoint(r) {
  // stay on your own side of the central wall to keep paths mostly legal
  const leftSide = r.x < 500;
  for (let i = 0; i < 50; i++) {
    const p = randomFreePoint();
    if ((p.x < 500) === leftSide) return p;
  }
  return randomFreePoint();
}

function step(r) {
  if (r.tx === null) { const p = pickWaypoint(r); r.tx = p.x; r.ty = p.y; }
  const dx = r.tx - r.x, dy = r.ty - r.y;
  const d = Math.hypot(dx, dy);
  const stepLen = SPEED * TICK;
  let nx = r.x, ny = r.y;
  if (d <= stepLen) { nx = r.tx; ny = r.ty; r.tx = null; }
  else { nx = r.x + (dx / d) * stepLen; ny = r.y + (dy / d) * stepLen; }
  if (inObstacle(nx, ny) || nx < 5 || nx > W - 5 || ny < 5 || ny > H - 5) {
    r.tx = null; // blocked by geometry: replan next tick
    return false;
  }
  r.x = nx; r.y = ny;
  return true;
}

const out = [...LINES_T0, ...LINES_T5];

for (let t = 10; t <= 900; t += TICK) {
  for (const r of robots.values()) {
    // ---- offline episode handling ----
    if (r.offlineLeft > 0) {
      r.offlineLeft--;
      out.push({ t, robot_id: r.id, x: +r.x.toFixed(1), y: +r.y.toFixed(1), status: 'offline', battery: +r.battery.toFixed(1) });
      continue;
    }

    // ---- mode bookkeeping ----
    if (r.modeLeft > 0) r.modeLeft--;

    if (r.mode === 'idle' && r.modeLeft <= 0) {
      const roll = rand();
      if (r.battery < 25) { r.mode = 'to_charger'; r.modeLeft = 60; }
      else if (roll < 0.35) { r.mode = 'active'; r.modeLeft = 3 + Math.floor(rand() * 4); r.taskPending = rand() < 0.25; }
      else if (roll < 0.42) { r.mode = 'on_mission'; r.modeLeft = 6 + Math.floor(rand() * 8); r.taskPending = true; }
      else if (roll < 0.46) { r.mode = 'error'; r.modeLeft = 1 + Math.floor(rand() * 2); }
      else if (roll < 0.48) { r.mode = 'blocked'; r.modeLeft = 1 + Math.floor(rand() * 3); }
      else if (roll < 0.50) { r.mode = 'maintenance'; r.modeLeft = 4 + Math.floor(rand() * 4); }
      else if (roll < 0.53) { r.mode = 'offline_now'; }
      else { r.modeLeft = 2 + Math.floor(rand() * 4); } // stay idle a while
    }
    if (r.mode === 'offline_now') { r.mode = 'offline'; r.offlineLeft = 2 + Math.floor(rand() * 4); r.modeLeft = 0; }
    if (r.mode === 'error' && r.modeLeft <= 0) r.mode = 'idle';
    if (r.mode === 'blocked' && r.modeLeft <= 0) r.mode = 'idle';
    if (r.mode === 'maintenance' && r.modeLeft <= 0) r.mode = 'idle';
    if ((r.mode === 'active' || r.mode === 'on_mission') && r.modeLeft <= 0) {
      r.mode = 'idle'; r.modeLeft = 2 + Math.floor(rand() * 3);
    }

    // ---- motion & battery ----
    let evt = null;
    if (r.mode === 'active' || r.mode === 'on_mission') {
      const moved = step(r);
      r.battery = Math.max(0, r.battery - (moved ? 0.8 : 0.3));
      if (r.mode === 'on_mission' && r.taskPending && r.modeLeft === Math.floor(rand() * 3)) {
        evt = { task_event: 'task_started' }; r.taskPending = 'started';
      }
      if (r.modeLeft <= 0 && r.taskPending === 'started') {
        evt = { task_event: 'task_completed' }; r.taskPending = false;
      }
    } else if (r.mode === 'to_charger') {
      const c = nearestCharger(r.x, r.y);
      r.tx = c.x; r.ty = c.y;
      step(r);
      r.battery = Math.max(0, r.battery - 0.6);
      if (Math.hypot(c.x - r.x, c.y - r.y) < 3) { r.mode = 'charging'; r.modeLeft = 999; }
    } else if (r.mode === 'charging') {
      r.battery = Math.min(100, r.battery + 2.5);
      if (r.battery >= 95) { r.mode = 'idle'; r.modeLeft = 2; }
    } else {
      r.battery = Math.max(0, r.battery - 0.1); // idle / error / blocked / maintenance
    }

    const line = {
      t, robot_id: r.id,
      x: +r.x.toFixed(1), y: +r.y.toFixed(1),
      status: r.mode === 'to_charger' ? 'active' : r.mode,
      battery: +r.battery.toFixed(1),
    };
    if (evt) line.task_event = evt.task_event;
    out.push(line);
  }
}

out.sort((a, b) => a.t - b.t || a.robot_id.localeCompare(b.robot_id));
const file = out.map(o => JSON.stringify(o)).join('\n') + '\n';
const dest = path.join(__dirname, '..', 'data', 'events.jsonl');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, file);

// ---- sanity checks ----
const reload = fs.readFileSync(dest, 'utf8').trim().split('\n').map(JSON.parse);
const perRobot = {};
let minB = 101, maxB = -1, taskEv = 0;
for (const e of reload) {
  perRobot[e.robot_id] = (perRobot[e.robot_id] || 0) + 1;
  minB = Math.min(minB, e.battery); maxB = Math.max(maxB, e.battery);
  if (e.task_event) taskEv++;
  if (strictlyInside(e.x, e.y)) throw new Error(`point inside obstacle: ${JSON.stringify(e)}`);
}
console.log('lines:', reload.length);
console.log('per robot:', perRobot);
console.log('battery range:', minB, '..', maxB, '| task_event lines:', taskEv);
console.log('sample t=300:', reload.filter(e => e.t === 300).slice(0, 3));
