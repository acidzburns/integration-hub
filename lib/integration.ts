import { randomUUID } from "node:crypto";
import { all, get, getSetting, now, run, setSetting } from "./db";
import { mapOrderToShipment, toExternalRef, type ShopOrder } from "./mapping";
import { syncIncidents, type SyncSummary } from "./servicenow";

/**
 * The Integration Hub engine.
 *
 *  1. POLL     — ask the Shop API for orders created since the last checkpoint
 *  2. MAP      — transform each order into the Warehouse format and store it as a message
 *  3. DELIVER  — POST each message to the Warehouse API
 *  4. HANDLE   — success → DELIVERED
 *                temporary problem (timeout, 5xx) → RETRY later with backoff
 *                permanent problem (4xx, bad data) → FAILED + incident, no retry
 */

export const FLOW_NAME = "Shop Orders → Warehouse Shipments";
export const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_SECONDS = 5; // retries after 5s, 15s, 45s
const REQUEST_TIMEOUT_MS = 5000;
const BATCH_SIZE = 25;

export type MessageStatus = "PENDING" | "RETRY" | "DELIVERED" | "FAILED";

export type Message = {
  id: number;
  correlation_id: string;
  flow: string;
  order_id: number;
  external_ref: string | null;
  status: MessageStatus;
  attempts: number;
  max_attempts: number;
  next_retry_at: string | null;
  source_payload: string;
  target_payload: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type RunSummary = {
  skipped?: boolean;
  polled: number;
  delivered: number;
  retrying: number;
  failed: number;
  pollError?: string;
  serviceNow?: SyncSummary;
};

/** Seconds to wait before the next attempt: 5, 15, 45… */
export function backoffSeconds(attempt: number): number {
  return BASE_BACKOFF_SECONDS * 3 ** (attempt - 1);
}

/** Decide what an HTTP result means for the message. */
export function classify(httpStatus: number | null): "SUCCESS" | "TRANSIENT_ERROR" | "PERMANENT_ERROR" {
  if (httpStatus === null) return "TRANSIENT_ERROR"; // network error / timeout
  if (httpStatus >= 200 && httpStatus < 300) return "SUCCESS";
  if (httpStatus === 408 || httpStatus === 429 || httpStatus >= 500) return "TRANSIENT_ERROR";
  return "PERMANENT_ERROR";
}

const lock = globalThis as unknown as { hubRunning?: boolean };

export async function runIntegration(baseUrl: string): Promise<RunSummary> {
  const summary: RunSummary = { polled: 0, delivered: 0, retrying: 0, failed: 0 };
  if (lock.hubRunning) return { ...summary, skipped: true };
  lock.hubRunning = true;

  try {
    // 1 + 2. Poll the Shop and turn new orders into messages
    try {
      const checkpoint = Number(getSetting("shop_checkpoint") || 0);
      const res = await fetch(`${baseUrl}/api/shop/orders?after=${checkpoint}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Shop API answered HTTP ${res.status}`);
      const { orders } = (await res.json()) as { orders: ShopOrder[] };

      for (const order of orders) {
        createMessage(order);
        setSetting("shop_checkpoint", String(order.id));
        summary.polled++;
      }
    } catch (err) {
      summary.pollError = err instanceof Error ? err.message : String(err);
    }

    // 3 + 4. Deliver everything that is due
    const due = all<Message>(
      `SELECT * FROM messages
       WHERE status IN ('PENDING', 'RETRY') AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY id LIMIT ?`,
      now(),
      BATCH_SIZE,
    );
    for (const message of due) {
      const status = await deliver(message, baseUrl);
      if (status === "DELIVERED") summary.delivered++;
      else if (status === "RETRY") summary.retrying++;
      else if (status === "FAILED") summary.failed++;
    }

    // 5. Push new and resolved incidents to ServiceNow (skipped if not configured)
    summary.serviceNow = await syncIncidents();
  } finally {
    lock.hubRunning = false;
  }
  return summary;
}

function createMessage(order: ShopOrder) {
  const timestamp = now();
  let target: string | null = null;
  let status: MessageStatus = "PENDING";
  let error: string | null = null;

  try {
    target = JSON.stringify(mapOrderToShipment(order));
  } catch (err) {
    status = "FAILED";
    error = `Mapping error: ${err instanceof Error ? err.message : String(err)}`;
  }

  const result = run(
    `INSERT OR IGNORE INTO messages
      (correlation_id, flow, order_id, external_ref, status, attempts, max_attempts,
       source_payload, target_payload, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
    randomUUID(),
    FLOW_NAME,
    order.id,
    toExternalRef(order.id),
    status,
    MAX_ATTEMPTS,
    JSON.stringify(order),
    target,
    error,
    timestamp,
    timestamp,
  );
  if (status === "FAILED" && result.changes > 0) {
    openIncident(Number(result.lastInsertRowid), error ?? "Mapping error");
  }
}

async function deliver(message: Message, baseUrl: string): Promise<MessageStatus> {
  const attemptNo = message.attempts + 1; // counts towards max_attempts (reset by Reprocess)
  const historyNo =
    (get<{ n: number }>("SELECT COUNT(*) AS n FROM message_attempts WHERE message_id = ?", message.id)?.n ?? 0) + 1;
  const startedAt = now();
  const started = performance.now();
  let httpStatus: number | null = null;
  let error: string | null = null;

  try {
    const res = await fetch(`${baseUrl}/api/warehouse/shipments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Correlation-ID": message.correlation_id },
      body: message.target_payload,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    httpStatus = res.status;
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const details = Array.isArray(body.errors) ? body.errors.join("; ") : body.error;
      error = `HTTP ${res.status}${details ? `: ${details}` : ""}`;
    }
  } catch (err) {
    error = err instanceof Error && err.name === "TimeoutError"
      ? `Timeout after ${REQUEST_TIMEOUT_MS / 1000}s`
      : `Connection error: ${err instanceof Error ? err.message : String(err)}`;
  }

  const durationMs = Math.round(performance.now() - started);
  const outcome = classify(httpStatus);

  run(
    `INSERT INTO message_attempts (message_id, attempt_no, started_at, duration_ms, http_status, outcome, error)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    message.id,
    historyNo,
    startedAt,
    durationMs,
    httpStatus,
    outcome,
    error,
  );

  let status: MessageStatus;
  let nextRetryAt: string | null = null;

  if (outcome === "SUCCESS") {
    status = "DELIVERED";
  } else if (outcome === "TRANSIENT_ERROR" && attemptNo < message.max_attempts) {
    status = "RETRY";
    nextRetryAt = new Date(Date.now() + backoffSeconds(attemptNo) * 1000).toISOString();
  } else {
    status = "FAILED";
    if (outcome === "TRANSIENT_ERROR") error = `Gave up after ${attemptNo} attempts. Last error: ${error}`;
  }

  const timestamp = now();
  run(
    `UPDATE messages
     SET status = ?, attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ?,
         completed_at = CASE WHEN ? IN ('DELIVERED', 'FAILED') THEN ? ELSE NULL END
     WHERE id = ?`,
    status,
    attemptNo,
    nextRetryAt,
    status === "DELIVERED" ? null : error,
    timestamp,
    status,
    timestamp,
    message.id,
  );

  if (status === "FAILED") openIncident(message.id, error ?? "Unknown error");
  if (status === "DELIVERED") resolveIncidents(message.id);
  return status;
}

function openIncident(messageId: number, error: string) {
  const existing = get<{ id: number }>(
    "SELECT id FROM incidents WHERE message_id = ? AND status = 'OPEN'",
    messageId,
  );
  if (existing) return;
  const ref = get<{ external_ref: string }>("SELECT external_ref FROM messages WHERE id = ?", messageId);
  run(
    `INSERT INTO incidents (message_id, title, description, status, created_at)
     VALUES (?, ?, ?, 'OPEN', ?)`,
    messageId,
    `Integration failure: ${ref?.external_ref ?? `message ${messageId}`} not delivered to Warehouse`,
    error,
    now(),
  );
}

function resolveIncidents(messageId: number) {
  run(
    "UPDATE incidents SET status = 'RESOLVED', resolved_at = ? WHERE message_id = ? AND status = 'OPEN'",
    now(),
    messageId,
  );
}

/** Manual "Reprocess" from the monitor: give the message a fresh set of attempts. */
export function reprocessMessage(id: number): boolean {
  const result = run(
    `UPDATE messages
     SET status = 'PENDING', attempts = 0, next_retry_at = NULL, updated_at = ?, completed_at = NULL
     WHERE id = ? AND status IN ('FAILED', 'RETRY') AND target_payload IS NOT NULL`,
    now(),
    id,
  );
  return result.changes > 0;
}
