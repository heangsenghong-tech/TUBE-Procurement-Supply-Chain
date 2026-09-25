// SQLite storage for the app's document collections, users, sessions and audit log.
// Uses Node's built-in node:sqlite, so the server has no npm dependencies.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name          TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin      INTEGER NOT NULL DEFAULT 0,
      active        INTEGER NOT NULL DEFAULT 1,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS docs (
      collection TEXT NOT NULL,
      id         TEXT NOT NULL,
      data       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      user_id    TEXT,
      action     TEXT NOT NULL,
      collection TEXT,
      doc_id     TEXT,
      before     TEXT,
      after      TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_log_doc ON audit_log (collection, doc_id);
  `);
  return db;
}

function now() { return new Date().toISOString(); }

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Same semantics the prototype relied on: nested maps merge, everything else replaces.
function deepMerge(target, patch) {
  const out = Object.assign({}, target);
  for (const k of Object.keys(patch)) {
    out[k] = isPlainObject(patch[k]) && isPlainObject(out[k]) ? deepMerge(out[k], patch[k]) : patch[k];
  }
  return out;
}

function createStore(db) {
  const q = {
    list: db.prepare('SELECT id, data FROM docs WHERE collection = ? ORDER BY created_at, id'),
    get: db.prepare('SELECT data FROM docs WHERE collection = ? AND id = ?'),
    insert: db.prepare('INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'),
    upsert: db.prepare(`INSERT INTO docs (collection, id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`),
    update: db.prepare('UPDATE docs SET data = ?, updated_at = ? WHERE collection = ? AND id = ?'),
    del: db.prepare('DELETE FROM docs WHERE collection = ? AND id = ?'),
    audit: db.prepare('INSERT INTO audit_log (at, user_id, action, collection, doc_id, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    count: db.prepare('SELECT COUNT(*) AS n FROM docs WHERE collection = ?')
  };

  function audit(userId, action, collection, id, before, after) {
    q.audit.run(now(), userId || null, action, collection || null, id || null,
      before === undefined ? null : JSON.stringify(before),
      after === undefined ? null : JSON.stringify(after));
  }

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }

  return {
    audit,
    list(collection) {
      return q.list.all(collection).map((r) => ({ id: r.id, data: JSON.parse(r.data) }));
    },
    get(collection, id) {
      const r = q.get.get(collection, id);
      return r ? JSON.parse(r.data) : null;
    },
    count(collection) { return q.count.get(collection).n; },
    add(collection, id, data, userId) {
      const t = now();
      q.insert.run(collection, id, JSON.stringify(data), t, t);
      audit(userId, 'add', collection, id, undefined, data);
      return data;
    },
    set(collection, id, data, userId) {
      return tx(() => {
        const before = this.get(collection, id);
        const t = now();
        q.upsert.run(collection, id, JSON.stringify(data), t, t);
        audit(userId, 'set', collection, id, before === null ? undefined : before, data);
        return data;
      });
    },
    // Returns null when the document does not exist (the client treats that as an error).
    update(collection, id, patch, userId) {
      return tx(() => {
        const before = this.get(collection, id);
        if (before === null) return null;
        const after = deepMerge(before, patch);
        q.update.run(JSON.stringify(after), now(), collection, id);
        audit(userId, 'update', collection, id, before, after);
        return after;
      });
    },
    remove(collection, id, userId) {
      return tx(() => {
        const before = this.get(collection, id);
        if (before === null) return false;
        q.del.run(collection, id);
        audit(userId, 'delete', collection, id, before, undefined);
        return true;
      });
    }
  };
}

module.exports = { openDb, createStore, deepMerge, now };
