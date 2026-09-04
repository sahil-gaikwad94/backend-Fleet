# Fleet Management Backend — Peppermint Robotics SDE-1 (Assignment 2)

Backend for a robot-fleet dashboard. Eight mocked robots replay their recorded
telemetry (`events.jsonl`) over MQTT. A Node backend consumes that stream,
keeps the fleet's current state in one in-memory store, and serves it two
ways, a WebSocket push stream and a REST polling API both reading the same
store so they can never disagree. Fleet history is persisted to MongoDB
(stretch goal). Everything comes up with one `docker compose up`.

## Stack

Node.js 20, Express, `ws`, MQTT (Mosquitto), MongoDB, Docker Compose.

## Run it

```bash
docker compose up --build
```

| Service     | What it is                                        | Port  |
|-------------|----------------------------------------------------|-------|
| `broker`    | Eclipse Mosquitto MQTT broker                      | 1883  |
| `mongo`     | MongoDB 7, persists fleet history (stretch goal)   | 27017 |
| `backend`   | Express REST + WebSocket API, MQTT consumer        | 8080  |
| `simulator` | Forks one OS process per robot                     |   —   |

Nothing needs to be run by hand in a second terminal. the simulator starts
all 8 robots on its own. Images are pinned to `linux/amd64` so it boots on
the eval machine even if built on Apple Silicon.

### Try it

```bash
curl http://localhost:8080/api/robots                 # fleet snapshot (polling)
curl http://localhost:8080/api/robots/r1               # one robot + last-20 events
curl "http://localhost:8080/api/robots/history/r1?from=300&to=500"   # Mongo history (stretch)
curl http://localhost:8080/api/health                  # liveness + ingestion counters

# live stream
node -e "new (require('ws'))('ws://localhost:8080/ws').on('message', d => console.log(d.toString()))"
```

Every WebSocket client gets a full `snapshot` on connect, then an `update`
for each ingested event after that. Send `{"type":"snapshot"}` on the socket
to re-sync at any point.

### Env vars

| Var            | Default              | Meaning                                          |
|-----------------|---------------------|---------------------------------------------------|
| `REPLAY_SPEED`  | `2`                 | simulator playback multiplier (2 = 2× real time)  |
| `CHAOS`         | `0`                 | `1` = robots randomly sever/reconnect their MQTT link |
| `STALE_MS`      | `15000`             | silence longer than this → robot flagged offline  |
| `MQTT_URL`      | `mqtt://broker:1883`| broker address                                    |

`CHAOS=1 docker compose up --build` is the fastest way to watch the
Last-Will/watchdog offline detection work end to end.

## Why it's built this way

(full reasoning in `ANSWERS.md`, scaling/failure walkthroughs in
`SYSTEM_DESIGN.md`)

- **MQTT, not HTTP callbacks or a heavier queue.** Robots are flaky
  producers, and MQTT gives me Last-Will (the broker itself announces a dead
  robot even if its process just vanishes), retained online/offline status,
  and QoS 1 redelivery — all things I'd otherwise have to hand-roll.
- **One OS process per robot**, not 8 coroutines in one process — the brief
  ruled that out, and it's honestly closer to how independent hardware
  behaves anyway.
- **One in-memory `FleetState` Map is the only source of truth.** Both REST
  and WS read the same object, so the two transports can't drift apart.
- **Monotonic per-robot `seq` + a stale-`t` guard** stop late or duplicate
  QoS 1 redeliveries from rewinding a robot's position for every client at
  once.
- **MongoDB for history.** The events are basically schemaless JSON with an
  occasional extra key — a document store fit with no ORM ceremony.

## Tests

```bash
cd backend && npm install && npm test          # 15 tests: FleetState + REST routes
cd robot-simulator && npm install && npm test  #  3 tests: log loader
```

Most of the care went into `backend/tests/fleetState.test.js` — it's the
part where every correctness guarantee of both APIs actually lives (stale-
event rejection, exactly-once online transitions, watchdog sweep behaviour,
REST/WS snapshot equality).


## AI use

Used AI assistance (Genspark). I picked the architecture- MQTT, one process per 
robot, a single source of truth,
LWT + watchdog for failure detection and the AI drafted explanatory comments, boilerplate (Dockerfiles, the compose file, Express plumbing, test scaffolding).


