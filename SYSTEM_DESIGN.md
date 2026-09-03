# SYSTEM_DESIGN.md — Fleet Management Backend

Answers reference the actual submission: `backend/src/*.js`,
`robot-simulator/src/*.js`, `docker-compose.yml`.

## 1. Adding a new feature later: does the design accommodate it?

Walkthrough of a concrete feature: **"alert the operator when any robot's
battery drops below 20% while not charging."**

It plugs in without touching any existing component. The seam is the
`onEvent` callback that `backend/src/index.js` passes into `MqttConsumer` —
today there is exactly one subscriber (`wsHub.broadcast`), which is just
`consumer = new MqttConsumer({ ..., onEvent: (e) => wsHub.broadcast(e) })`.
An `AlertRules` module would subscribe to the same hook:

```js
const alerts = new AlertRules({ threshold: 20 });
consumer = new MqttConsumer({ ..., onEvent: (e) => { wsHub.broadcast(e); alerts.evaluate(e); } });
```

`alerts.evaluate` sees every ingested event (already validated and ordered by
`FleetState.applyTelemetry`), and an alert it raises is itself just another
message on the WS hub (`{ type: "alert", ... }`) plus a row in a Mongo
collection via the existing `HistoryStore` connection. No changes to the
robots, the broker topics, the REST surface, or the state shape.

That is the general pattern: the pipeline is **producer → broker → consumer →
state → fanout**, and each stage has one obvious extension point — new event
types pass through `applyTelemetry`'s tolerant validation (unknown extra keys
like `task_event` already flow through untouched), new consumers hook
`onEvent`, new API consumers mount another router next to `buildRouter`. The
one thing that *would* need rework is the reverse direction (backend → robot
commands), because the simulator currently only publishes; that means a new
`fleet/robots/{id}/cmd` subscription in `robot-process.js` and an
`MqttPublisher` in the backend — an addition, not a rework, but it touches
both sides.

## 2. From eight robots to five hundred: what breaks first?

First to break is **not** what people usually guess. `FleetState` (a Map,
O(1) updates, O(n) snapshots) handles 500 robots at 5-second cadence — ~100
msg/s — without breaking a sweat, and Mosquitto handles thousands of
connections. The first real casualty is the **`GET /robots` full-snapshot
payload combined with the WebSocket per-client fanout**:

- Every event is serialized and pushed to *every* WS client
  (`wsHub.broadcast` stringifies once but still writes to N sockets; with a
  handful of operator dashboards that's ~600 small writes/s — fine; with a
  few dozen dashboards or per-robot fine-grained subscriptions it becomes the
  hot spot).
- Each new WS client triggers `fleetState.snapshot()` — a 500-robot snapshot
  is ~150 KB, served on every connect and every reconnect storm (flaky
  clients reconnecting together after a network blip would stampede it).

Behind that, two more go quickly: the **MongoDB insert-per-event** path
(`history.record` awaits one `insertOne` per message — 100 round-trips/s is
fine until it isn't, and it has no batching), and the **simulator host**,
which forks 500 Node processes at ~30 MB each ≈ 15 GB of RAM (that one is
demo-only; the fix is 500 lightweight containers/pods, or fewer processes
each emulating several robots — with the honesty note that this trades away
the process-per-robot realism on purpose).

The fix order: (1) make `broadcast` subscription-aware (`?robots=r1,r5` or
throttled fleet-level diffs at 1 Hz instead of one message per event);
(2) cache the snapshot JSON and invalidate on change rather than rebuilding
per request; (3) batch Mongo writes (`insertMany` on a 500 ms flush window);
(4) only then, when a single backend process saturates a core, shard
ingestion with MQTT **shared subscriptions** (`$share/backend/fleet/...`)
across N backend replicas, put Redis pub/sub between them for cross-instance
WS fanout, and move `FleetState` from "the" store to "each replica's
authoritative shard" — robots hash onto replicas by `robot_id`, so each
robot's state still lives in exactly one place and the consistency argument
from ANSWERS.md Q1 survives sharding unchanged.

## 3. Bandwidth-limited links between robots and backend

Current cost per update: one JSON object (~120 bytes) plus MQTT framing —
trivial at 5 s cadence, painful over, say, a 9600-baud radio or a paid-per-MB
cellular plan. Changes, in the order I'd make them:

1. **Send deltas, not state.** Most fields rarely change: an idle robot's
   position is constant, battery moves 0.1/tick. Publish
   `{robot_id, t, battery}` heartbeats and only include `x`/`y`/`status` when
   they change beyond a deadband (e.g. moved > 1 unit, status transition).
   `FleetState.applyTelemetry` already tolerates partial updates structurally
   — it would merge missing fields from the current record (small change:
   stop requiring `x`/`y`/`battery` on every message, keep last-known for
   absent keys). Typical traffic drops 60–80%.
2. **Adaptive cadence.** Idle/charging robots report every 30–60 s; moving or
   low-battery robots every 5 s. The watchdog (`STALE_MS=15000`) would need a
   per-robot expected-interval instead of one global threshold, or robots
   advertise their current cadence in the retained status message — the
   watchdog then compares silence against *that*, not a constant.
3. **Binary encoding.** If JSON is still too fat, CBOR/Protobuf over the same
   topics halves the bytes again; MQTT doesn't care about payload format. I'd
   resist this until 1+2 prove insufficient — schema-free JSON debuggability
   is worth a lot at small scale.
4. **Batch and compress uplinks.** A robot that buffered telemetry while
   offline (the simulator already buffers via the mqtt.js offline queue)
   should send one `fleet/robots/{id}/backlog` message with an array rather
   than N separate publishes — one header instead of N.

What I would *not* sacrifice: the `t` timestamp and per-robot ordering
guarantee — under constrained bandwidth, late/out-of-order delivery gets
*worse*, and the stale guard in `applyTelemetry` is the only thing standing
between the dashboard and nonsense.

## 4. A robot goes down mid-task and stops responding

Detection is layered, and each layer exists in the code today:

1. **Instant: broker Last Will.** Each robot registers a retained
   `fleet/robots/{id}/status = {online:false}` will at connect time
   (`robot-process.js`, the `will` option). If the TCP link dies ungracefully
   — crash, power loss, network cut — the broker publishes the will itself
   and the backend marks the robot offline within a second or two. This was
   verified end-to-end by SIGKILLing a robot process in integration testing.
2. **Slower but universal: the watchdog.** If a robot never connects, or the
   broker itself is down, `sweepStale` (`fleetState.js`, driven by a timer in
   `index.js`, `STALE_MS=15000`) flags any robot silent past its threshold as
   offline and broadcasts the change. Three missed 5-second reports is the
   default tripwire.
3. **Semantic: status telemetry.** The log itself carries `error`,
   `blocked`, `maintenance`, `offline` statuses — a robot that is alive but
   stuck shows up in state before it ever trips the watchdog.

What the rest of the system should *do*: (a) mark it offline in
`FleetState`, so both APIs immediately show it (already happens);
(b) surface an alert to the operator (the Q1 extension seam); (c) if the
robot was mid-task — detectable from `status: on_mission` plus an unpaired
`task_started` in its history — the task must be treated as orphaned:
flagged for re-dispatch to another robot, and the dead robot's last known
position flagged for physical recovery. Task re-dispatch is the part this
submission deliberately doesn't automate (there is no task queue in scope),
but the detection inputs are all in the data already.

On recovery: the robot reconnects, publishes retained `online:true`, resumes
telemetry — and critically, if it buffered reports while down, it back-fills
them; the `t`-ordering guard in `applyTelemetry` lets the backend accept the
fresh position and file the stale backlog into history without ever moving
the robot backwards on the live view.

## 5. Slow/unreliable robot↔backend connection: late, out-of-order, missing updates

**What the rest of the system sees during the outage:** the robot's record in
`FleetState` simply stops advancing — `updated_at` and `last_seen` age,
position freezes at the last good value. For up to `STALE_MS` the fleet view
shows "stale but nominally online"; after the watchdog sweep it flips to
`online: false` with the last known position and battery intact. Crucially it
does **not** show a frozen robot as happily working — the operator sees both
the staleness (timestamps are in every record) and then the offline flag.
WS clients get the offline transition pushed as a normal update, so the
dashboard changes in real time.

**Out-of-order and duplicates on the ingest path:** QoS 1 redelivery and
buffered back-fill can deliver events late and reordered. The stale guard in
`applyTelemetry` (drop any event with `t` older than the held one) plus
idempotent equal-`t` handling make the state store immune: the robot's live
position is always the *newest known*, never a rewound one. The cost is a
real one — a genuinely-but-slightly-out-of-order stream can drop a legitimate
newer-position event that arrived after an even newer one — but for positions
on a map that self-corrects on the next tick, and the alternative (rendering
a robot teleporting backwards) is worse.

**Recovery once the link heals:** three mechanisms converge. The robot's
mqtt.js client reconnects with backoff and drains its offline buffer
(store-and-forward, configured in `robot-process.js`); the backend's
persistent session (`clean: false`) receives anything the broker queued for
it during *its* outage; and the retained status topic re-announces
`online:true`. Fresh telemetry flips `online` back on the first accepted
message (`applyTelemetry` sets `online = true` unconditionally), the watchdog
stops firing on its next sweep, and every WS client sees the robot resume —
with a position jump if it moved while dark, which is honest: the UI shows
where it *is*, with `updated_at` exposing how fresh that is.

The known gap, stated plainly: events published by a robot while the
*backend's* MQTT session was being recreated (broker restart + `clean:false`
session expiry) can be lost, and the per-robot 20-event tail only papers over
short gaps for reconnecting WS clients. Closing it means durable
device-side storage with explicit replay ranges ("send me t=420..510") — the
`history` endpoint already has the query shape for it; the robot-side buffer
is the missing half.
