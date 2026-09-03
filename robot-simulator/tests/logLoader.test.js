'use strict';
/** Tests for the simulator's log loader: filtering, ordering, corrupt lines. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadEventsForRobot } = require('../src/logLoader');

describe('loadEventsForRobot', () => {
  let file;
  beforeAll(() => {
    file = path.join(os.tmpdir(), `events-test-${Date.now()}.jsonl`);
    const lines = [
      JSON.stringify({ t: 10, robot_id: 'r2', x: 1, y: 1, status: 'idle', battery: 50 }),
      JSON.stringify({ t: 0, robot_id: 'r1', x: 0, y: 0, status: 'idle', battery: 90 }),
      'this is not json',
      JSON.stringify({ t: 5, robot_id: 'r1', x: 5, y: 5, status: 'active', battery: 89 }),
      '',
      JSON.stringify({ t: 10, robot_id: 'r1', x: 9, y: 9, status: 'active', battery: 88 }),
    ];
    fs.writeFileSync(file, lines.join('\n'));
  });
  afterAll(() => fs.unlinkSync(file));

  test('returns only the requested robot\'s events, sorted by t', async () => {
    const events = await loadEventsForRobot(file, 'r1');
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.t)).toEqual([0, 5, 10]);
    expect(events.every((e) => e.robot_id === 'r1')).toBe(true);
  });

  test('skips corrupt lines instead of crashing', async () => {
    const events = await loadEventsForRobot(file, 'r2');
    expect(events).toHaveLength(1);
    expect(events[0].t).toBe(10);
  });

  test('returns empty array for an unknown robot (caller decides what to do)', async () => {
    expect(await loadEventsForRobot(file, 'ghost')).toEqual([]);
  });
});
