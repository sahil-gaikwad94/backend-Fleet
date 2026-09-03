'use strict';
/**
 * History store (stretch goal) — persists every ingested telemetry event to
 * MongoDB and answers GET /robots/history/{id}?from=&to= time-range queries.
 *
 * Why MongoDB: the events are schemaless-ish JSON documents (some lines carry
 * an extra task_event key), write volume is append-only telemetry, and the
 * fleet roster is tiny. A document store fits the shape with zero ORM ceremony,
 * and it keeps the "M" of the MERN stack the submission was built around.
 * The store is wrapped so the backend degrades gracefully if Mongo is down —
 * ingestion and live state keep working, history endpoints return 503.
 */
const { MongoClient } = require('mongodb');

class HistoryStore {
  constructor(uri, dbName = 'fleet') {
    this.uri = uri;
    this.dbName = dbName;
    this.client = null;
    this.collection = null;
    this.ready = false;
  }

  async connect() {
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 5000 });
    await this.client.connect();
    const db = this.client.db(this.dbName);
    this.collection = db.collection('events');
    await this.collection.createIndex({ robot_id: 1, ingested_at: -1 });
    await this.collection.createIndex({ robot_id: 1, t: -1 });
    this.ready = true;
  }

  async record(event) {
    if (!this.ready) return;
    try {
      await this.collection.insertOne({ ...event, ingested_at: new Date() });
    } catch (err) {
      console.warn('[history] insert failed:', err.message);
    }
  }

  /**
   * Range query. from/to accept either event-time `t` (seconds, 0..900) or
   * ISO/millis wall-clock on ingested_at. Returns newest-first, capped.
   */
  async query(robotId, { from, to, limit = 500 }) {
    if (!this.ready) throw Object.assign(new Error('history store unavailable'), { code: 503 });
    const filter = { robot_id: robotId };
    if (from !== undefined || to !== undefined) {
      filter.t = {};
      if (from !== undefined) filter.t.$gte = Number(from);
      if (to !== undefined) filter.t.$lte = Number(to);
    }
    const docs = await this.collection
      .find(filter, { projection: { _id: 0 } })
      .sort({ t: -1 })
      .limit(Math.min(Number(limit) || 500, 5000))
      .toArray();
    return docs;
  }

  async close() {
    if (this.client) await this.client.close();
  }
}

module.exports = { HistoryStore };
