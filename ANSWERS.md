# ANSWERS.md — Assignment 2 (Backend)


## 1. Where does the fleet's current state live, and why that shape?

It lives in one in-memory `Map<string, RobotRecord>` inside `FleetState`
(`backend/src/fleetState.js`). There's exactly one instance per backend
process, built at boot from `robots.json`, and every consumer reads that same
object: the MQTT consumer writes into it through `applyTelemetry`, the
WebSocket hub broadcasts whatever `applyTelemetry` returns, and the REST
routes (`routes.js`) serialize the same records via `snapshot()` /
`getRobot()`.

Why this shape: the assignment's consistency requirement — a client on one
interface shouldn't see something inconsistent with a client on the other —
is easiest to guarantee by making it structurally impossible to break. One
in-memory store means there's no replication lag, no cache to invalidate, and
no second code path that can drift from the first. A `Map` keyed by
`robot_id` gives O(1) updates (the hot path — ~2 msg/s here, but the shape
holds at much higher rates) and O(n) snapshots, which is trivial at 8 robots
and still fine at hundreds. Each record is flat — `robot_id`, `x`, `y`,
`status`, `battery`, `t`, `seq`, `online`, `updated_at`, `last_seen` — so it
serializes straight to JSON for either transport, no transform layer needed.
Each robot also carries a 20-entry `history_tail` ring so a reconnecting
client (or a human debugging) can see its recent events without a Mongo
round-trip.

The one addition on top of the plain Map is the per-robot monotonic `seq` and
the stale guard in `applyTelemetry`: any event whose `t` is older than what's
already held gets counted (`counters.dropped_stale`) and dropped, so a late
or redelivered packet can never rewind a robot's position for every client at
once. This is the property `backend/tests/fleetState.test.js` spends the most
time on, because basically every correctness guarantee either API makes
reduces to it.

## 2. One real tradeoff worth arguing: robot → backend transport

**MQTT (Mosquitto) with QoS 1, over HTTP callbacks, raw sockets, or something
heavier like Kafka/RabbitMQ.**

Why I picked it: this is a textbook producer/consumer problem over flaky
links, and MQTT was built for exactly that — battery-powered publishers,
unreliable networks, lots of small messages. It bought me three things I'd
otherwise have had to hand-build:

- **Last Will and Testament** — each robot registers a retained "offline"
  message at connect time (`robot-simulator/src/robot-process.js`). If a
  robot's TCP link dies silently, the *broker* announces the death, and my
  backend learns about it within seconds even with zero robot code running.
- **Retained status topics** — a backend that restarts mid-shift sees who's
  online immediately, without waiting for the next telemetry tick.
- **QoS 1 + persistent sessions** on the consumer side (`clean: false` in
  `mqttConsumer.js`) — anything published while the backend was briefly down
  gets redelivered once it's back.

HTTP webhooks would've given me none of that — every robot would need its own
retry queue, and "robot died" would look identical to "robot is just quiet."
Kafka gives stronger log semantics but is way too heavy for 8 robots at
~2 msg/sec, and it has no concept of per-device presence at all.

The honest cost: QoS 1 is at-least-once, so duplicates and out-of-order
redelivery are just normal, and I pay for that with the stale-`t` guard and
idempotent re-application in `FleetState.applyTelemetry` (an equal-`t` update
just re-stamps the same values). Second, WS fanout is fire-and-forget — a
telemetry event can be ACKed to the robot and applied to state while a WS
client happens to be disconnected, and that client just misses the delta. I
reconcile this by making the WS layer catch-up-based instead of
delivery-based: on connect (or on demand) a client gets a full snapshot, and
every record carries `seq` so a client can detect a gap and re-sync. That's
deliberately weaker than end-to-end exactly-once — the state store is the
source of truth, the stream is just a notification — which does mean a
dashboard that never reconnects cleanly could sit on stale data indefinitely.
Third, MQTT means running a broker — one more container, one more failure
mode, though the simulator's `reconnectPeriod` plus the consumer's persistent
session mean a broker restart mostly self-heals. For this fleet size, the
broker's operational cost is well below what it would've cost to hand-roll
presence, retries, and redelivery over HTTP myself.

## 3. What I left out, and what's next

Left out on purpose, inside the timebox:

- **Auth and TLS.** The Mosquitto listener allows anonymous connections
  (`broker/mosquitto.conf`), and the REST/WS APIs are open with permissive
  CORS. Fine for a local eval stack, not okay for a real deployment. Next
  step: per-robot username/password or client certs on the broker, plus a
  token on the API.
- **Richer history queries.** The stretch goal is done —
  `GET /robots/history/:id?from=&to=`, backed by Mongo in `history.js` — but
  it's only filtered by event-time `t` with a limit cap. No aggregation
  (battery drain per hour, say), no pagination cursor, no fleet-wide history
  endpoint.
- **Command path.** The system is telemetry-in only, one direction. A real
  dashboard eventually needs "robot r3, return to charger," which would land
  as a `fleet/robots/{id}/cmd` topic the simulator subscribes to.
- **Structured alerting.** `error`/`blocked` statuses get ingested and
  fanned out, but nothing actually pages anyone. The natural next step is a
  small rules engine hanging off the same `onEvent` hook the WS hub uses.
- **Horizontal scaling.** One backend process holds all the state. I wrote up
  the sharding story — shared MQTT subscriptions, Redis fanout — in
  SYSTEM_DESIGN.md Q2 instead of building it, because at 8 robots it would be
  pure ceremony.

If I had more time, roughly in this order: security first, then alerting
(best operator value per hour of work), then the command path, then richer
history.
richer history.
