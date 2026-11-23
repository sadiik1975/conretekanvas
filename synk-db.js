"use strict";

const { mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function now() {
  return new Date().toISOString();
}

function createSynkRepository(databasePath = "data/synk.db") {
  const path = databasePath === ":memory:" ? databasePath : resolve(databasePath);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS synk_signups (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      source TEXT NOT NULL DEFAULT 'direct',
      unsubscribe_token_hash TEXT NOT NULL,
      is_subscribed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      unsubscribed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS synk_email_sends (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('sending', 'succeeded', 'partial', 'failed', 'unknown')
      ),
      recipient_count INTEGER NOT NULL DEFAULT 0,
      attempted_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS synk_one_active_send
      ON synk_email_sends(status) WHERE status = 'sending';

    CREATE TABLE IF NOT EXISTS synk_sessions (
      token_hash TEXT PRIMARY KEY,
      admin_email TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkout_orders (
      stripe_session_id TEXT PRIMARY KEY,
      stripe_event_id TEXT NOT NULL UNIQUE,
      product_id TEXT NOT NULL,
      size TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'fulfilled', 'failed')),
      printful_order_id TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS synk_signups_created_at
      ON synk_signups(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS synk_email_sends_created_at
      ON synk_email_sends(created_at DESC, id DESC);
  `);

  const insertSignup = database.prepare(`
    INSERT INTO synk_signups (
      id, email, source, unsubscribe_token_hash, is_subscribed, created_at
    ) VALUES (?, ?, ?, ?, 1, ?)
  `);
  const selectSignup = database.prepare(
    "SELECT * FROM synk_signups WHERE id = ?"
  );
  const listSignups = database.prepare(
    "SELECT email, source, created_at, is_subscribed FROM synk_signups ORDER BY created_at DESC, id DESC"
  );
  const listActiveRecipients = database.prepare(
    "SELECT id, email FROM synk_signups WHERE is_subscribed = 1 ORDER BY created_at, id"
  );
  const unsubscribeSignup = database.prepare(`
    UPDATE synk_signups
    SET is_subscribed = 0, unsubscribed_at = ?
    WHERE id = ? AND unsubscribe_token_hash = ?
  `);
  const isSubscribed = database.prepare(
    "SELECT 1 AS active FROM synk_signups WHERE id = ? AND is_subscribed = 1"
  );
  const insertSend = database.prepare(`
    INSERT INTO synk_email_sends (
      id, subject, status, recipient_count, attempted_count, failed_count,
      created_at, updated_at
    ) VALUES (?, ?, 'sending', 0, 0, 0, ?, ?)
  `);
  const updateSend = database.prepare(`
    UPDATE synk_email_sends
    SET status = ?, recipient_count = ?, attempted_count = ?,
        failed_count = ?, updated_at = ?
    WHERE id = ?
  `);
  const updateSendProgress = database.prepare(`
    UPDATE synk_email_sends
    SET recipient_count = ?, attempted_count = ?, failed_count = ?, updated_at = ?
    WHERE id = ?
  `);
  const listSends = database.prepare(`
    SELECT created_at, subject, recipient_count, attempted_count, failed_count, status
    FROM synk_email_sends
    ORDER BY created_at DESC, id DESC
  `);
  const selectSend = database.prepare("SELECT * FROM synk_email_sends WHERE id = ?");
  const insertSession = database.prepare(
    "INSERT INTO synk_sessions (token_hash, admin_email, expires_at, created_at) VALUES (?, ?, ?, ?)"
  );
  const selectSession = database.prepare(
    "SELECT * FROM synk_sessions WHERE token_hash = ? AND expires_at > ?"
  );
  const deleteSession = database.prepare(
    "DELETE FROM synk_sessions WHERE token_hash = ?"
  );
  const insertOrder = database.prepare(`
    INSERT OR IGNORE INTO checkout_orders (
      stripe_session_id, stripe_event_id, product_id, size, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'processing', ?, ?)
  `);
  const updateOrder = database.prepare(`
    UPDATE checkout_orders
    SET status = ?, printful_order_id = ?, error = ?, updated_at = ?
    WHERE stripe_session_id = ?
  `);

  return {
    database,
    close: () => database.close(),

    addSignup({ id, email, source, unsubscribeTokenHash }) {
      insertSignup.run(id, email, source, unsubscribeTokenHash, now());
      return selectSignup.get(id);
    },

    hasEmail(email) {
      return Boolean(database.prepare(
        "SELECT 1 AS found FROM synk_signups WHERE email = ? COLLATE NOCASE"
      ).get(email));
    },

    listSignups() {
      return listSignups.all().map(row => ({
        ...row,
        is_subscribed: Boolean(row.is_subscribed)
      }));
    },

    listActiveRecipients() {
      return listActiveRecipients.all();
    },

    isSubscribed(id) {
      return Boolean(isSubscribed.get(id));
    },

    unsubscribe(id, unsubscribeTokenHash) {
      return unsubscribeSignup.run(now(), id, unsubscribeTokenHash).changes > 0;
    },

    createSend(id, subject) {
      const timestamp = now();
      insertSend.run(id, subject, timestamp, timestamp);
      return selectSend.get(id);
    },

    updateSendProgress(id, values) {
      updateSendProgress.run(
        values.recipientCount,
        values.attemptedCount,
        values.failedCount,
        now(),
        id
      );
    },

    finishSend(id, values) {
      updateSend.run(
        values.status,
        values.recipientCount,
        values.attemptedCount,
        values.failedCount,
        now(),
        id
      );
    },

    getSend(id) {
      return selectSend.get(id) || null;
    },

    listSends() {
      return listSends.all();
    },

    createSession(tokenHash, adminEmail, expiresAt) {
      insertSession.run(tokenHash, adminEmail, expiresAt, now());
    },

    getSession(tokenHash) {
      return selectSession.get(tokenHash, now()) || null;
    },

    deleteSession(tokenHash) {
      deleteSession.run(tokenHash);
    },

    cleanExpiredSessions() {
      database.prepare("DELETE FROM synk_sessions WHERE expires_at <= ?").run(now());
    },

    claimOrder({ stripeEventId, stripeSessionId, productId, size }) {
      const timestamp = now();
      return insertOrder.run(
        stripeSessionId,
        stripeEventId,
        productId || "unknown",
        size || "unknown",
        timestamp,
        timestamp
      ).changes === 1;
    },

    finishOrder(stripeSessionId, { status, printfulOrderId = null, error = null }) {
      updateOrder.run(status, printfulOrderId, error, now(), stripeSessionId);
    }
  };
}

module.exports = { createSynkRepository };
