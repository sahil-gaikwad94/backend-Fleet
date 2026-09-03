'use strict';
/**
 * Route-level tests with the state store and history stubbed — verifies the
 * REST contract (shapes, status codes, query parsing) without a broker or DB.
 */
const express = require('express');
const http = require('http');
const { FleetState } = require('../src/fleetState');
const { buildRouter } = require('../src/routes');

function makeServer(history) {
  const fleetState = new FleetState([
    { robot_id: 'r1', robot_type: 'picker', start: { x: 1, y: 2 } },
  ]);
  fleetState.applyTelemetry({ robot_id: 'r1', t: 5, x: 10, y: 20, status: 'active', battery: 90 });
  const app = express();
  app.use(buildRouter({ fleetState, history }));
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

async function get(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('REST API', () => {
  let server, port;
  const historyStub = {
    query: jest.fn(async (id, opts) => [{ robot_id: id, t: opts.from ?? 0, x: 1, y: 2 }]),
  };

  beforeAll(async () => { ({ server, port } = await makeServer(historyStub)); });
  afterAll(() => server.close());

  test('GET /health reports ok and counters', async () => {
    const { status, body } = await get(port, '/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.counters.ingested).toBe(1);
  });

  test('GET /robots returns the fleet snapshot', async () => {
    const { status, body } = await get(port, '/robots');
    expect(status).toBe(200);
    expect(body.robots).toHaveLength(1);
    expect(body.robots[0]).toMatchObject({ robot_id: 'r1', x: 10, status: 'active' });
  });

  test('GET /robots/:id 404s for unknown robots', async () => {
    const { status, body } = await get(port, '/robots/nope');
    expect(status).toBe(404);
    expect(body.error).toMatch(/nope/);
  });

  test('GET /robots/history/:id parses from/to and forwards to the store', async () => {
    const { status, body } = await get(port, '/robots/history/r1?from=100&to=500&limit=10');
    expect(status).toBe(200);
    expect(historyStub.query).toHaveBeenCalledWith('r1', { from: '100', to: '500', limit: '10' });
    expect(body.events[0].robot_id).toBe('r1');
  });

  test('history endpoint 503s when the store is not configured', async () => {
    const { server: s2, port: p2 } = await makeServer(null);
    const { status, body } = await get(p2, '/robots/history/r1');
    expect(status).toBe(503);
    expect(body.error).toMatch(/not configured/);
    s2.close();
  });
});
