# ANSWERS.md — Assignment 2 (Backend)

## 1. What holds the fleet's current state, and why that shape?

The fleet's current state lives in a single in-memory `Map<string, RobotRecord>`
inside `FleetState` (`backend/src/fleetState.js`). There is exactly one instance
per backend process, created at boot from `robots.json`, and **every consumer
reads that same object**: the MQTT consumer writes to it
(`mqttConsumer.js` → `applyTelemetry`), the WebSocket hub broadcasts the events
`applyTelemetry` returns, and the REST endpoints (`routes.js`) serialize the
same records via `snapshot()` / `getRobot()`.

Why this shape: the assignment's consistency requirement — "a client using one
should not see something inconsistent with a client using the other" — is
easiest to guarantee by making it impossible to do otherwise. With one
in-memory store there is no replication lag, no cache invalidation, and no
second code path that can drift. A `Map` keyed by `robot_id` gives O(1)
updates (the hot path, ~2 msg/s here but the shape holds at much higher rates)
and O(n) snapshots, where n is the fleet size — trivially cheap at 8 robots
and still fine at hundreds. Each record is flat (`robot_id`, `x`, `y`,
`status`, `battery`, `t`, `seq`, `online`, `updated_at`, `last_seen`) so it
serializes straight to JSON for either transport without a transform layer.
Each robot also keeps a 20-entry `history_tail` ring so a reconnecting client
(or a human debugging) can see the robot's last few events without hitting
Mongo.

One addition is the per-robot monotonic `seq` and the stale guard
in `applyTelemetry`: an event whose recorded `t` is older than what we already
hold is counted (`counters.dropped_stale`) and dropped, so a late or
redelivered packet can never rewind a robot's position on every client at
once. This is the property the test suite
(`backend/tests/fleetState.test.js`) spends the most time on, because every
correctness guarantee of both APIs reduces to it.

## 2. One real tradeoff: the robot→backend mechanism

**I chose MQTT (Mosquitto) with QoS 1, rather than HTTP callbacks, raw
sockets, or a heavier queue like Kafka/RabbitMQ.**

Argument for it. The problem is a textbook producer/consumer split over flaky
links, and MQTT was designed for exactly this setting: battery-powered
publishers, unreliable networks, many small messages. Concretely it bought me
three things I would otherwise have had to build: (a) a **Last Will and
Testament** — each robot registers a retained "offline" message at connect
time (`robot-simulator/src/robot-process.js`), so if a robot's TCP link dies
silently the *broker* announces its death and my backend learns about it
within seconds even with no robot code running at all; (b) **retained status
topics**, so a backend that restarts mid-shift immediately sees who is online
without waiting for the next telemetry tick; (c) **QoS 1 + persistent
sessions** on the consumer side (`clean: false` in
`backend/src/mqttConsumer.js`), so messages published while the backend is
briefly down are redelivered when it comes back. HTTP webhooks would have
given me none of this — every robot would need retry queues, and "robot died"
would be indistinguishable from "robot is quiet". Kafka would give me stronger
log semantics but is absurdly heavy for 8 robots and ~2 messages/second, and
it has no concept of a per-device presence will.

The cost, honestly stated. QoS 1 means **at-least-once**: duplicates and
out-of-order redelivery are normal, and I pay for that in
`FleetState.applyTelemetry` with the stale-`t` guard and idempotent
re-application (equal-`t` updates just re-stamp the same values). Second, the
WS fanout is fire-and-forget: a telemetry event can be ACKed to the robot
(QoS 1) and applied to state while a WebSocket client is momentarily
disconnected, so that client *misses* the delta. I reconcile the two
semantics by making the WS layer catch-up-based rather than delivery-based:
on connect (and on demand) the client receives a full `snapshot`, and every
robot record carries `seq` so a client can detect gaps and re-sync. That is
deliberately weaker than end-to-end exactly-once — the state store is the
authority, the stream is a notification mechanism — and it means a dashboard
that never reconnects cleanly could show stale positions indefinitely.
Third, MQTT adds a broker to operate: one more container, one more failure
mode (though the simulator's `reconnectPeriod` and the consumer's persistent
session mean a broker restart self-heals). For this fleet size I judged the
broker's operational cost well below the cost of hand-rolling presence,
retry, and redelivery over HTTP.

## 3. What I left out, and what I'd build next

Left out, deliberately, inside the timebox:

- **Authentication and TLS.** The Mosquitto listener allows anonymous
  connections (`broker/mosquitto.conf`) and the REST/WS APIs are open with
  permissive CORS. Fine for a local evaluation stack; unacceptable for a real
  site. Next step: per-robot username/password or client certs on the broker,
  and a token on the API.
- **Rich history queries.** The stretch goal is implemented
  (`GET /robots/history/:id?from=&to=`, backed by MongoDB in
  `backend/src/history.js`), but only filtered by event-time `t` with a limit
  cap — no aggregation (e.g. "battery drain per hour"), no pagination cursor,
  no fleet-wide history endpoint.
- **Command path.** The system is strictly telemetry-in. A real operator
  dashboard eventually needs the reverse direction ("robot r3, return to
  charger"), which would land as a `fleet/robots/{id}/cmd` topic the
  simulator subscribes to.
- **Structured alerting.** `error`/`blocked` statuses are ingested and
  fanned out, but nothing pages anyone; a natural next step is a small
  rules engine consuming the same `onEvent` hook the WS hub uses.
- **Horizontal scaling.** One backend process holds all state. The sharding
  story (shared MQTT subscriptions, Redis fanout) is written up in
  SYSTEM_DESIGN.md question 2 rather than built, because at 8 robots it would
  be pure ceremony.

Given more time I'd build those in roughly that order: security first, then
alerting (highest operator value per hour), then the command path, then
richer history.
