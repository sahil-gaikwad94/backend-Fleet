'use strict';
/**
 * Shared log loader: filters events.jsonl down to one robot's events,
 * ordered by recorded timestamp. Split out of robot-process.js so it is
 * unit-testable without an MQTT connection.
 */
const fs = require('fs');
const readline = require('readline');

async function loadEventsForRobot(file, robotId) {
  const events = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try { evt = JSON.parse(trimmed); } catch { continue; } // skip corrupt lines
    if (evt.robot_id === robotId) events.push(evt);
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

module.exports = { loadEventsForRobot };
