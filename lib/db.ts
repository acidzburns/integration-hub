import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * One SQLite database file holds three "systems" so the demo runs anywhere:
 *  - shop_*        → the source system (where orders are created)
 *  - warehouse_*   → the target system (which receives shipment requests)
 *  - messages, message_attempts, incidents, settings → the Integration Hub itself
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS shop_orders (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name  TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  country        TEXT NOT NULL,
  items_json     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS warehouse_shipments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  external_ref TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  received_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  correlation_id TEXT NOT NULL UNIQUE,
  flow           TEXT NOT NULL,
  order_id       INTEGER NOT NULL UNIQUE,
  external_ref   TEXT,
  status         TEXT NOT NULL,          -- PENDING | RETRY | DELIVERED | FAILED
  attempts       INTEGER NOT NULL DEFAULT 0,
  max_attempts   INTEGER NOT NULL,
  next_retry_at  TEXT,
  source_payload TEXT NOT NULL,
  target_payload TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, next_retry_at);

CREATE TABLE IF NOT EXISTS message_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES messages(id),
  attempt_no  INTEGER NOT NULL,
  started_at  TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  http_status INTEGER,
  outcome     TEXT NOT NULL,             -- SUCCESS | TRANSIENT_ERROR | PERMANENT_ERROR
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_attempts_started ON message_attempts(started_at);

CREATE TABLE IF NOT EXISTS incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL REFERENCES messages(id),
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  status      TEXT NOT NULL,             -- OPEN | RESOLVED
  created_at  TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('warehouse_failure_rate', '0.2'),
  ('shop_checkpoint', '0');
`;

const globalForDb = globalThis as unknown as { hubDb?: DatabaseSync };

/** Opens the database once and reuses it (also survives hot reload in dev). */
export function getDb(): DatabaseSync {
  if (!globalForDb.hubDb) {
    const file = process.env.HUB_DB_PATH ?? path.join(process.cwd(), "data", "hub.db");
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA);
    migrate(db);
    globalForDb.hubDb = db;
  }
  return globalForDb.hubDb;
}

/**
 * Small migrations: add columns introduced after the first version, so an
 * existing hub.db keeps working without deleting it. Safe to run every start.
 */
function migrate(db: DatabaseSync) {
  const columns = (db.prepare("PRAGMA table_info(incidents)").all() as { name: string }[]).map((c) => c.name);
  const added: Record<string, string> = {
    sn_sys_id: "TEXT", // ServiceNow record ID
    sn_number: "TEXT", // ServiceNow incident number, e.g. INC0010023
    sn_synced_status: "TEXT", // status ServiceNow last confirmed: OPEN | RESOLVED
    sn_error: "TEXT", // last sync error, if any
    sn_synced_at: "TEXT",
  };
  for (const [name, type] of Object.entries(added)) {
    if (!columns.includes(name)) db.exec(`ALTER TABLE incidents ADD COLUMN ${name} ${type}`);
  }
}

export function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return getDb().prepare(sql).all(...params) as unknown as T[];
}

export function get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return getDb().prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(sql: string, ...params: SQLInputValue[]) {
  return getDb().prepare(sql).run(...params);
}

export function getSetting(key: string): string {
  return get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key)?.value ?? "";
}

export function setSetting(key: string, value: string) {
  run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    value,
  );
}

export const now = () => new Date().toISOString();
