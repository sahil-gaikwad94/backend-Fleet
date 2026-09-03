'use strict';
/**
 * REST API — the polling alternative to the WebSocket stream.
 *
 * Both transports read from the SAME FleetState instance, so a polling client
 * and a streaming client can never see two different "current" states.
 *
 *   GET /health                      liveness + ingestion counters
 *   GET /robots                      full fleet snapshot (same JSON as the WS snapshot)
 *   GET /robots/{id}                 one robot, including its last-20 event tail
 *   GET /robots/history/{id}         stretch goal: persisted history,
 *                                    ?from=<t>&to=<t>&limit=<n> (t = event seconds 0..900)
 */
const express = require('express');

function buildRouter({ fleetState, history }) {
  const router = express.Router();

  router.get('/health', (req, res) => {
    res.json({
      ok: true,
      uptime_ms: Date.now() - fleetState.startedAt,
      counters: fleetState.counters,
      history_store: history?.ready ? 'up' : 'down',
      ws_clients: req.app.get('wsHub')?.clientCount() ?? 0,
    });
  });

  router.get('/robots', (req, res) => {
    res.json(fleetState.snapshot());
  });

  router.get('/robots/history/:id', async (req, res) => {
    if (!history) return res.status(503).json({ error: 'history store not configured' });
    try {
      const docs = await history.query(req.params.id, {
        from: req.query.from,
        to: req.query.to,
        limit: req.query.limit,
      });
      res.json({ robot_id: req.params.id, count: docs.length, events: docs });
    } catch (err) {
      res.status(err.code || 500).json({ error: err.message });
    }
  });

  router.get('/robots/:id', (req, res) => {
    const robot = fleetState.getRobot(req.params.id);
    if (!robot) return res.status(404).json({ error: `unknown robot '${req.params.id}'` });
    res.json(robot);
  });

  return router;
}

module.exports = { buildRouter };
