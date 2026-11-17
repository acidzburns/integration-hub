import { all, get, getSetting } from "./db";
import { getServiceNowConfig } from "./servicenow";
import type { Message, MessageStatus } from "./integration";

/** Read-only queries for the monitoring screens. */

export type Attempt = {
  id: number;
  attempt_no: number;
  started_at: string;
  duration_ms: number;
  http_status: number | null;
  outcome: "SUCCESS" | "TRANSIENT_ERROR" | "PERMANENT_ERROR";
  error: string | null;
};

export type Incident = {
  id: number;
  message_id: number;
  title: string;
  description: string;
  status: "OPEN" | "RESOLVED";
  created_at: string;
  resolved_at: string | null;
  sn_sys_id: string | null;
  sn_number: string | null;
  sn_synced_status: string | null;
  sn_error: string | null;
};

export function getOverview() {
  const counts = Object.fromEntries(
    all<{ status: MessageStatus; n: number }>("SELECT status, COUNT(*) AS n FROM messages GROUP BY status").map(
      (r) => [r.status, r.n],
    ),
  ) as Partial<Record<MessageStatus, number>>;

  const delivered = counts.DELIVERED ?? 0;
  const failed = counts.FAILED ?? 0;
  const finished = delivered + failed;

  const avg = get<{ avg: number | null }>(
    `SELECT AVG(duration_ms) AS avg FROM
       (SELECT duration_ms FROM message_attempts WHERE outcome = 'SUCCESS' ORDER BY id DESC LIMIT 100)`,
  );

  return {
    total: Object.values(counts).reduce((a, b) => a + (b ?? 0), 0),
    pending: counts.PENDING ?? 0,
    retrying: counts.RETRY ?? 0,
    delivered,
    failed,
    successRate: finished === 0 ? null : delivered / finished,
    avgLatencyMs: avg?.avg == null ? null : Math.round(avg.avg),
    openIncidents: get<{ n: number }>("SELECT COUNT(*) AS n FROM incidents WHERE status = 'OPEN'")?.n ?? 0,
    failureRate: Number(getSetting("warehouse_failure_rate") || 0),
    shipmentsReceived: get<{ n: number }>("SELECT COUNT(*) AS n FROM warehouse_shipments")?.n ?? 0,
    ordersInShop: get<{ n: number }>("SELECT COUNT(*) AS n FROM shop_orders")?.n ?? 0,
    serviceNowHost: (() => {
      const config = getServiceNowConfig();
      return config ? new URL(config.instance).host : null;
    })(),
    serviceNowErrors:
      get<{ n: number }>("SELECT COUNT(*) AS n FROM incidents WHERE sn_error IS NOT NULL")?.n ?? 0,
  };
}

/** Delivery attempts per minute for the last 15 minutes. */
export function getThroughput(minutes = 15) {
  const since = new Date(Date.now() - minutes * 60_000);
  since.setSeconds(0, 0);
  const rows = all<{ started_at: string; outcome: Attempt["outcome"] }>(
    "SELECT started_at, outcome FROM message_attempts WHERE started_at >= ?",
    since.toISOString(),
  );

  const buckets = Array.from({ length: minutes + 1 }, (_, i) => ({
    minute: new Date(since.getTime() + i * 60_000),
    success: 0,
    error: 0,
  }));
  for (const row of rows) {
    const index = Math.floor((new Date(row.started_at).getTime() - since.getTime()) / 60_000);
    const bucket = buckets[Math.min(Math.max(index, 0), minutes)];
    if (row.outcome === "SUCCESS") bucket.success++;
    else bucket.error++;
  }
  return buckets;
}

export function listMessages(status?: MessageStatus, limit = 50): Message[] {
  return status
    ? all<Message>("SELECT * FROM messages WHERE status = ? ORDER BY id DESC LIMIT ?", status, limit)
    : all<Message>("SELECT * FROM messages ORDER BY id DESC LIMIT ?", limit);
}

export function getMessage(id: number) {
  const message = get<Message>("SELECT * FROM messages WHERE id = ?", id);
  if (!message) return null;
  return {
    message,
    attempts: all<Attempt>("SELECT * FROM message_attempts WHERE message_id = ? ORDER BY id", id),
    incidents: all<Incident>("SELECT * FROM incidents WHERE message_id = ? ORDER BY id DESC", id),
  };
}

export function listOpenIncidents(limit = 10): Incident[] {
  return all<Incident>("SELECT * FROM incidents WHERE status = 'OPEN' ORDER BY id DESC LIMIT ?", limit);
}
