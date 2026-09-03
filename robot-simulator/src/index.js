#!/usr/bin/env node
/**
 * Simulator supervisor.
 *
 * Reads robots.json, then forks ONE child OS process per robot
 * (robot-process.js). Eight coroutines inside a single process would not be a
 * real producer/consumer split: here each robot owns its own MQTT connection,
 * its own event schedule and its own failure behaviour, exactly like physical
 * hardware on a site.
 *
 * The supervisor's only jobs are: fork, restart crashed children with
 * backoff, and shut everything down cleanly on SIGTERM/SIGINT.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

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
const ROBOTS_FILE = path.join(DATA_DIR, 'robots.json');
const ROBOTS = JSON.parse(fs.readFileSync(ROBOTS_FILE, 'utf8'));

const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 15000;

const children = new Map(); // robot_id -> { proc, restarts }
let shuttingDown = false;

function spawnRobot(robot) {
  const child = fork(path.join(__dirname, 'robot-process.js'), [], {
    env: {
      ...process.env,
      ROBOT_ID: robot.robot_id,
      ROBOT_TYPE: robot.robot_type,
      DATA_DIR,
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  });

  children.set(robot.robot_id, { proc: child, restarts: (children.get(robot.robot_id)?.restarts || 0) });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const entry = children.get(robot.robot_id);
    entry.restarts += 1;
    const delay = Math.min(RESTART_BASE_MS * 2 ** entry.restarts, RESTART_MAX_MS);
    console.warn(`[supervisor] ${robot.robot_id} exited (code=${code}, signal=${signal}); restart #${entry.restarts} in ${delay}ms`);
    setTimeout(() => !shuttingDown && spawnRobot(robot), delay);
  });

  console.log(`[supervisor] spawned ${robot.robot_id} (pid ${child.pid})`);
}

for (const robot of ROBOTS) spawnRobot(robot);

function shutdown(signal) {
  console.log(`[supervisor] ${signal} received, stopping ${children.size} robot processes`);
  shuttingDown = true;
  for (const { proc } of children.values()) {
    try { proc.kill('SIGTERM'); } catch { /* already gone */ }
  }
  // give children a moment to close MQTT gracefully, then leave
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
