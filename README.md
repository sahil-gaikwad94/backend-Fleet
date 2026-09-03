# Fleet Management Backend — Peppermint Robotics SDE-1 (Assignment 2)

A backend for a fleet-management dashboard. Eight mocked robots replay their
recorded telemetry from `events.jsonl` over MQTT; a Node.js backend ingests
the stream, maintains the fleet's current state in one in-memory store, and
exposes it over **both** a WebSocket push stream and a REST polling API, kept
consistent by construction. Fleet history is persisted to MongoDB (stretch
goal) and everything boots with a single `docker compose up`.

## Stack

Node.js 20 + Express + `ws` + MQTT (Mosquitto) + MongoDB + Docker Compose —
the MERN ecosystem's backend half, with MQTT as the robot-facing transport.

## Run it

```bash
docker compose up --build
```

That one command brings up four services:

| Service     | What it is                                             | Port  |
|-------------|--------------------------------------------------------|-------|
| `broker`    | Eclipse Mosquitto MQTT broker                          | 1883  |
| `mongo`     | MongoDB 7, persists fleet history (stretch goal)       | 27017 |
| `backend`   | Express REST + WebSocket API, MQTT consumer            | 8080  |
| `simulator` | Supervisor that forks **one OS process per robot**     |   —   |

The simulator starts the robot fleet by itself; nothing needs to be run by
hand in a second terminal. All images are pinned `linux/amd64` so the stack
boots on x86_64 even if built on Apple Silicon.

### Try it

```bash
# REST snapshot (polling client)
curl http://localhost:8080/api/robots

# one robot, including its last-20 event tail
curl http://localhost:8080/api/robots/r1

# persisted history (stretch goal), t = event seconds 0..900
curl "http://localhost:8080/api/robots/history/r1?from=300&to=500&limit=100"

# health / ingestion counters
curl http://localhost:8080/api/health

# WebSocket stream
node -e "new (require('ws'))('ws://localhost:8080/ws').on('message', d => console.log(d.toString()))"
```

Every WebSocket client gets a full `snapshot` on connect, then an `update`
message for every ingested event. A reconnecting client can send
`{"type":"snapshot"}` to re-sync at any time.

### Knobs (environment variables)

| Var                 | Default      | Meaning                                        |
|---------------------|--------------|------------------------------------------------|
| `REPLAY_SPEED`      | `2`          | simulator playback multiplier (2 = 2× real time)|
| `CHAOS`             | `0`          | `1` = robots randomly sever/reconnect their MQTT link |
| `STALE_MS`          | `15000`      | silence longer than this → robot flagged offline |
| `MQTT_URL`          | `mqtt://broker:1883` | broker address                        |

`CHAOS=1 docker compose up --build` is the fastest way to watch the
Last-Will/watchdog offline detection work end to end.

## Design decisions (short version; long version in ANSWERS.md)

1. **MQTT as the robot transport.** Robots are producers, the backend is a
   consumer, and real robots are flaky — MQTT was designed for exactly this.
   It gives us per-robot topics, QoS 1 delivery, retained online/offline
   status, and a **Last Will** so the broker itself reports a dead robot even
   if its TCP link just vanishes.
2. **One publisher process per robot.** The simulator supervisor forks 8 child
   processes, each with its own MQTT connection, its own event schedule and
   its own crash behaviour — the brief explicitly ruled out 8 coroutines in
   one process.
3. **A single in-memory `FleetState` Map as the source of truth.** Both the
   WebSocket fanout and the REST endpoint read the same object, so the two
   transports can never disagree (see `backend/src/fleetState.js`).
4. **Monotonic per-robot sequence numbers + a stale-update guard** make
   late/out-of-order QoS 1 redeliveries harmless.
5. **MongoDB for history** because the events are append-only JSON documents
   with an occasional extra `task_event` key — a document store fits with
   zero schema ceremony, and it's the M of MERN.

## Tests

```bash
cd backend && npm install && npm test          # 15 tests: FleetState + REST routes
cd robot-simulator && npm install && npm test  #  3 tests: log loader
```

The trickiest part — `FleetState`'s ordering, dedup, and watchdog semantics —
is covered by `backend/tests/fleetState.test.js` (stale-event rejection,
exactly-once online transitions, sweep behaviour, REST/WS snapshot equality).

## Data provenance (honesty note)

The supplied `events.jsonl` reached me as a **partial screenshot** — t=0 was
fully legible, t=5 mostly legible (r7/r8 were cut off), and the remaining
~15 minutes were not visible at all. `data/events.jsonl` therefore:

- reproduces the 14 legible screenshot lines **verbatim**,
- infers r7/r8 @ t=5 using the log's own convention (idle robots: position
  unchanged, battery −0.1),
- extends the window to t=900 with a small seeded simulation
  (`tools/gen-events.js`) that respects the obstacle rectangles measured from
  `layout.png`, drains battery while moving, recharges at pads, and emits a
  few rare `task_started`/`task_completed` extras exactly as the brief
  describes.

This matches the brief's own framing ("this log comes from a small scripted
simulation… nothing hidden in it"), and the generator is included so the file
is reproducible. If you have the original file, drop it in `data/` — nothing
else changes.

`robots.json` was likewise reconstructed from a screenshot; robot types
(picker/hauler, alternating) were illegible and are my reasonable guess.

## AI delegation notes

Built with AI assistance (Genspark) under my direction. Concretely: I chose
the architecture (MQTT, one-process-per-robot, single source of truth,
LWT+watchdog), and the AI drafted the boilerplate (Dockerfiles, compose file,
Express plumbing, test scaffolding) and the data-reconstruction generator.
Every design decision, every bug found during integration testing (the
blocking Mongo connect, the data-dir resolution, the LWT race in the test
harness), and all tradeoff arguments in ANSWERS.md/SYSTEM_DESIGN.md are
reviewed and owned by me. No code is included that I cannot explain line by
line.

## What I'd do next

TLS + per-robot credentials on the broker, a dead-letter/alert topic for
`error`-status robots, Prometheus metrics on ingestion counters, a minimal
operator dashboard consuming `/ws`, and horizontal scaling (shared-subscription
consumers + Redis pub/sub for cross-instance WS fanout) once robot counts
justify it — see SYSTEM_DESIGN.md.
