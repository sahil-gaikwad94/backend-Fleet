
# SYSTEM_DESIGN.md — Fleet Management Backend

## 1. Can the design take a new feature without a rewrite?

Let me walk through a real one: alert the operator when a robot's battery
drops below 20% while it isn't charging.

This one plugs in without touching anything that already exists. The seam is
the `onEvent` callback that `index.js` hands to `MqttConsumer`. Right now
there's exactly one subscriber on it — `wsHub.broadcast`:

```js
consumer = new MqttConsumer({ ..., onEvent: (e) => wsHub.broadcast(e) });
```

An `AlertRules` module just becomes a second subscriber on the same hook:

```js
const alerts = new AlertRules({ threshold: 20 });
consumer = new MqttConsumer({ ..., onEvent: (e) => { wsHub.broadcast(e); alerts.evaluate(e); } });
```

`alerts.evaluate` sees every event after it's already been validated and
ordered by `FleetState.applyTelemetry`, so it doesn't need to re-derive
anything. An alert it raises is just another WS message
(`{ type: "alert", ... }`) and a row in Mongo through the same `HistoryStore`
connection already in use. Nothing about the robots, broker topics, REST
surface, or state shape has to change.

That's really the pattern for the whole pipeline — producer → broker →
consumer → state → fanout — and each stage has one obvious place to extend
it: new event types just flow through `applyTelemetry`'s validation (it
already lets unknown extra keys like `task_event` pass through untouched),
new consumers hook onto `onEvent`, new API consumers mount another router
next to `buildRouter`. The one direction that would actually need rework is
backend → robot, since the simulator only publishes today — that means
adding a `fleet/robots/{id}/cmd` subscription in `robot-process.js` and an
`MqttPublisher` on the backend. Not a rewrite, but it does touch both sides.

## 2. Eight robots to five hundred — what breaks first?

Not what most people guess first. `FleetState` is a Map with O(1) updates and
O(n) snapshots — 500 robots at 5s cadence is ~100 msg/s, which it eats
without noticing, and Mosquitto handles thousands of connections without
trying.

What actually breaks first is the combination of the `GET /robots` full
snapshot and the WebSocket fanout:

- Every event gets serialized and pushed to every WS client. `wsHub.broadcast`
  only stringifies once, but it's still N socket writes per event. With a
  handful of operator dashboards that's ~600 small writes/sec — fine. With a
  few dozen dashboards, or per-robot subscriptions, it turns into the actual
  hot spot.
- Every new WS client triggers a fresh `fleetState.snapshot()`. At 500 robots
  that's ~150KB, generated on every connect *and* every reconnect. A
  reconnect storm — a bunch of flaky clients dropping and reconnecting
  together after a network blip — would hammer this hard.

Right behind those two: Mongo inserts (`history.record` does one `insertOne`
per message, no batching — 100 writes/sec is fine until it isn't), and the
simulator host itself, which forks one Node process per robot at ~30MB each —
500 robots is ~15GB of RAM. That last one is demo-only tooling, not part of
the real architecture; the actual fix is 500 lightweight containers, or fewer
processes each emulating multiple robots (which trades away the "one process
per robot" realism on purpose — worth saying honestly).

Fix order I'd actually do it in:
1. Make broadcast subscription-aware (`?robots=r1,r5`), or throttle to
   fleet-level diffs at 1Hz instead of one message per event.
2. Cache the snapshot JSON and invalidate on change, instead of rebuilding it
   per request.
3. Batch Mongo writes — `insertMany` on a 500ms flush window.
4. Only once a single process is actually saturating a core: shard ingestion
   using MQTT shared subscriptions (`$share/backend/fleet/...`) across N
   backend replicas, put Redis pub/sub between them for cross-instance WS
   fanout, and let `FleetState` become each replica's authoritative shard
   instead of "the" store — robots hash onto replicas by `robot_id`, so each
   robot still lives in exactly one place, and the consistency argument from
   ANSWERS.md Q1 holds up unchanged even after sharding.

## 3. Bandwidth-limited robot↔backend links

Right now each update costs about 120 bytes of JSON plus MQTT framing —
nothing at 5s cadence, but painful over a 9600-baud radio or a metered
cellular plan. In the order I'd tackle it:

1. **Deltas instead of full state.** Most fields barely change — an idle
   robot's position doesn't move, battery drops 0.1 per tick. Send
   `{robot_id, t, battery}` heartbeats and only include `x`/`y`/`status`
   when they cross a deadband (moved more than 1 unit, status changed).
   `applyTelemetry` already tolerates partial updates structurally; the
   actual change needed is small — stop requiring `x`/`y`/`battery` on every
   message and carry forward the last known value for anything missing. This
   alone should cut traffic 60–80%.
2. **Adaptive cadence.** Idle or charging robots report every 30–60s, moving
   or low-battery robots every 5s. The watchdog (`STALE_MS=15000`) would need
   a per-robot expected interval instead of one global number — or robots
   advertise their current cadence in the retained status message, and the
   watchdog compares silence against that instead of a constant.
3. **Binary encoding.** If JSON is still too heavy, CBOR or Protobuf over the
   same topics halves the bytes again — MQTT doesn't care what's in the
   payload. I'd hold off on this until 1 and 2 aren't enough; being able to
   read the payload with your own eyes is worth a lot at this scale.
4. **Batch and compress uplinks.** A robot that buffered telemetry while
   offline (the simulator already does this via mqtt.js's offline queue)
   should send one `fleet/robots/{id}/backlog` message with an array on
   reconnect, instead of N separate publishes — one header instead of N.

What I wouldn't give up: the `t` timestamp and per-robot ordering. Under a
constrained link, late and out-of-order delivery gets worse, not better, and
the stale guard in `applyTelemetry` is the only thing keeping the dashboard
from showing nonsense.

## 4. A robot dies mid-task and goes silent

Detection happens in layers, and all of them already exist in the code:

1. **Instant — broker Last Will.** Every robot registers a retained
   `fleet/robots/{id}/status = {online:false}` will when it connects
   (`robot-process.js`, the `will` option). If the TCP link dies ungracefully
   — crash, power loss, cut cable — the broker publishes the will on the
   robot's behalf, and the backend marks it offline within a second or two,
   without a single line of robot code running. I verified this end-to-end by
   SIGKILLing a robot process during integration testing.
2. **Slower, universal — the watchdog.** If a robot never even connects, or
   the broker itself is down, `sweepStale` in `fleetState.js` (driven by a
   timer in `index.js`, `STALE_MS=15000`) flags anything silent past its
   threshold as offline and broadcasts the change. Default tripwire is three
   missed 5-second reports.
3. **Semantic — status telemetry.** The event log itself carries `error`,
   `blocked`, `maintenance`, `offline` statuses, so a robot that's alive but
   stuck already shows up in state before it ever trips the watchdog.

What should happen next: (a) mark it offline in `FleetState` — already
happens automatically; (b) surface an alert to the operator, which is exactly
the Q1 extension seam; (c) if it was mid-task (`status: on_mission` with an
unpaired `task_started` in its history), treat the task as orphaned — flag it
for re-dispatch, and flag the dead robot's last known position for physical
recovery. Re-dispatch itself is the one thing I deliberately didn't build —
there's no task queue in scope for this assignment — but every input needed
to detect it is already sitting in the data.

On recovery: the robot reconnects, publishes retained `online:true`, resumes
telemetry, and if it buffered anything while it was down, it backfills it.
The `t`-ordering guard in `applyTelemetry` means the backend can accept the
fresh position and file the stale backlog into history without ever moving
the robot backwards on the live view.

## 5. Slow/flaky connection — late, out-of-order, or missing updates

**During the outage:** the robot's record in `FleetState` just stops
advancing — `updated_at`/`last_seen` age, position freezes at the last good
value. Up to `STALE_MS`, the fleet view shows it as stale-but-online; after
the watchdog sweep it flips to `online: false` with the last known position
and battery intact. It never shows a frozen robot as if it's happily
working — the operator sees the staleness first (every record carries
timestamps), then the offline flag. That transition gets pushed to WS clients
like any other update, so the dashboard reflects it in real time.

**Out-of-order and duplicate events on ingest:** QoS 1 redelivery plus
buffered backfill means events can arrive late and reordered. The stale
guard in `applyTelemetry` (drop anything whose `t` is older than what's
already held) plus idempotent handling of equal-`t` updates keeps the store
immune — a robot's live position is always the newest known one, never
rewound. There's a real cost here: a legitimately-but-slightly-out-of-order
stream can drop a valid newer-position event that happened to arrive after
an even newer one. For positions on a map that self-correct next tick,
that's an acceptable trade — the alternative (a robot visibly teleporting
backwards) is worse.

**Once the link heals:** three things converge. The robot's mqtt.js client
reconnects with backoff and drains its offline buffer (store-and-forward,
set up in `robot-process.js`); the backend's persistent session
(`clean: false`) picks up anything the broker queued for it during its own
downtime; and the retained status topic re-announces `online:true`. The
first accepted telemetry message flips `online` back on unconditionally
(that's how `applyTelemetry` is written), the watchdog stops firing on its
next sweep, and every WS client sees the robot come back — possibly with a
position jump if it moved while dark, which I think is the honest behavior:
the UI shows where the robot actually is, and `updated_at` tells you how
fresh that is.

The gap I'll state plainly: anything a robot published while the *backend's*
own MQTT session was being recreated (broker restart plus `clean:false`
session expiry) can be lost, and the 20-event `history_tail` only papers over
short gaps for a reconnecting WS client. Closing that properly means durable
storage on the device side with explicit replay ranges ("send me
t=420..510") — the `history` endpoint already has the query shape for that;
the missing half is the robot-side buffer.0..510") — the history endpoint already has the query shape for that; the missing half is the robot-side buffer.
is the missing half.
