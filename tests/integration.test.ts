import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { all, get, run, setSetting } from "@/lib/db";
import { generateOrders } from "@/lib/shop";
import { reprocessMessage, runIntegration, type Message } from "@/lib/integration";
import * as shopApi from "@/app/api/shop/orders/route";
import * as warehouseApi from "@/app/api/warehouse/shipments/route";

const BASE = "http://hub.test";

// Send the hub's HTTP calls straight to our real route handlers (no server needed).
vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  const request = new NextRequest(input, init as ConstructorParameters<typeof NextRequest>[1]);
  const path = new URL(input).pathname;
  if (path === "/api/shop/orders") return shopApi.GET(request);
  if (path === "/api/warehouse/shipments") return warehouseApi.POST(request);
  return new Response("Not found", { status: 404 });
});

const messages = () => all<Message>("SELECT * FROM messages ORDER BY id");
const makeRetriesDue = () => run("UPDATE messages SET next_retry_at = '2000-01-01T00:00:00.000Z'");

beforeEach(() => {
  for (const table of ["message_attempts", "incidents", "messages", "warehouse_shipments", "shop_orders"]) {
    run(`DELETE FROM ${table}`);
  }
  setSetting("shop_checkpoint", "0");
  setSetting("warehouse_failure_rate", "0");
});

function insertOrder(sku: string, qty: number) {
  run(
    "INSERT INTO shop_orders (customer_name, customer_email, country, items_json, created_at) VALUES (?, ?, ?, ?, ?)",
    "Test Customer",
    "t@example.com",
    "MY",
    JSON.stringify([{ sku, name: "Item", qty, unitPrice: 10 }]),
    new Date().toISOString(),
  );
}

describe("integration flow", () => {
  it("delivers new orders when the warehouse is healthy", async () => {
    insertOrder("DRL-1001", 2);
    insertOrder("LSR-5100", 1);

    const summary = await runIntegration(BASE);

    expect(summary).toMatchObject({ polled: 2, delivered: 2, failed: 0 });
    expect(messages().every((m) => m.status === "DELIVERED")).toBe(true);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM warehouse_shipments")?.n).toBe(2);
  });

  it("does not pick up the same order twice", async () => {
    generateOrders(3);
    await runIntegration(BASE);
    const second = await runIntegration(BASE);
    expect(second.polled).toBe(0);
    expect(messages()).toHaveLength(3);
  });

  it("retries during an outage, then fails and opens an incident", async () => {
    insertOrder("DRL-1001", 1);
    setSetting("warehouse_failure_rate", "1");

    await runIntegration(BASE);
    expect(messages()[0]).toMatchObject({ status: "RETRY", attempts: 1 });

    for (let i = 0; i < 3; i++) {
      makeRetriesDue();
      await runIntegration(BASE);
    }

    const [message] = messages();
    expect(message).toMatchObject({ status: "FAILED", attempts: 4 });
    expect(message.last_error).toContain("Gave up after 4 attempts");
    expect(all("SELECT * FROM incidents WHERE status = 'OPEN'")).toHaveLength(1);
  });

  it("fails bad data immediately without retrying", async () => {
    insertOrder("drl1001", 1);

    await runIntegration(BASE);

    const [message] = messages();
    expect(message).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(message.last_error).toContain("HTTP 422");
  });

  it("reprocess after an outage delivers the message and resolves the incident", async () => {
    insertOrder("ANC-2040", 5);
    setSetting("warehouse_failure_rate", "1");
    await runIntegration(BASE);
    for (let i = 0; i < 3; i++) {
      makeRetriesDue();
      await runIntegration(BASE);
    }
    expect(messages()[0].status).toBe("FAILED");

    setSetting("warehouse_failure_rate", "0");
    expect(reprocessMessage(messages()[0].id)).toBe(true);
    await runIntegration(BASE);

    expect(messages()[0].status).toBe("DELIVERED");
    expect(all("SELECT * FROM incidents WHERE status = 'OPEN'")).toHaveLength(0);
    expect(all("SELECT * FROM message_attempts")).toHaveLength(5);
  });

  it("warehouse is idempotent: the same shipment twice is not duplicated", async () => {
    insertOrder("DRL-1001", 1);
    await runIntegration(BASE);
    run("UPDATE messages SET status = 'PENDING', attempts = 0");
    await runIntegration(BASE);
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM warehouse_shipments")?.n).toBe(1);
  });
});
