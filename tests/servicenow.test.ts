import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { all, run, setSetting } from "@/lib/db";
import { reprocessMessage, runIntegration, type Message } from "@/lib/integration";
import { syncIncidents } from "@/lib/servicenow";
import * as shopApi from "@/app/api/shop/orders/route";
import * as warehouseApi from "@/app/api/warehouse/shipments/route";

const BASE = "http://hub.test";
const SN = "https://dev00000.service-now.com";

// A fake ServiceNow instance that records every request it receives
type SnCall = { method: string; path: string; auth: string | null; body: Record<string, string> };
let snCalls: SnCall[] = [];
let snMode: "ok" | "down" | "unauthorized" | "policy" = "ok";
let nextNumber = 10001;
let snChoices: { value: string; label: string; language: string }[] = [];

vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  if (url.origin === SN) {
    const call = {
      method: init?.method ?? "GET",
      path: url.pathname,
      auth: new Headers(init?.headers).get("Authorization"),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    snCalls.push(call);
    if (snMode === "down") return new Response("<html>Service Unavailable</html>", { status: 503 });
    if (snMode === "unauthorized") {
      return Response.json({ error: { message: "User Not Authenticated" } }, { status: 401 });
    }
    if (call.method === "GET" && call.path === "/api/now/table/sys_choice") {
      return Response.json({ result: snChoices });
    }
    if (snMode === "policy" && call.method === "PATCH") {
      return Response.json(
        { error: { message: "Operation Failed", detail: "Data Policy Exception: Caller is mandatory" }, status: "failure" },
        { status: 403 },
      );
    }
    if (call.method === "POST") {
      const n = nextNumber++;
      return Response.json({ result: { sys_id: `sys${n}`, number: `INC00${n}` } }, { status: 201 });
    }
    return Response.json({ result: { sys_id: call.path.split("/").pop(), state: "6" } });
  }

  const request = new NextRequest(input, init as ConstructorParameters<typeof NextRequest>[1]);
  if (url.pathname === "/api/shop/orders") return shopApi.GET(request);
  if (url.pathname === "/api/warehouse/shipments") return warehouseApi.POST(request);
  return new Response("Not found", { status: 404 });
});

type IncidentRow = { id: number; status: string; sn_number: string | null; sn_synced_status: string | null; sn_error: string | null };
const incidents = () => all<IncidentRow>("SELECT * FROM incidents ORDER BY id");
const messages = () => all<Message>("SELECT * FROM messages ORDER BY id");

function insertOrder(sku: string) {
  run(
    "INSERT INTO shop_orders (customer_name, customer_email, country, items_json, created_at) VALUES (?, ?, ?, ?, ?)",
    "Test Customer",
    "t@example.com",
    "MY",
    JSON.stringify([{ sku, name: "Item", qty: 1, unitPrice: 10 }]),
    new Date().toISOString(),
  );
}

async function failOneMessageDuringOutage() {
  insertOrder("DRL-1001");
  setSetting("warehouse_failure_rate", "1");
  await runIntegration(BASE);
  for (let i = 0; i < 3; i++) {
    run("UPDATE messages SET next_retry_at = '2000-01-01T00:00:00.000Z'");
    await runIntegration(BASE);
  }
}

beforeEach(() => {
  for (const table of ["message_attempts", "incidents", "messages", "warehouse_shipments", "shop_orders"]) {
    run(`DELETE FROM ${table}`);
  }
  setSetting("shop_checkpoint", "0");
  setSetting("warehouse_failure_rate", "0");
  snCalls = [];
  snMode = "ok";
  nextNumber = 10001;
  snChoices = [];
  (globalThis as { snCloseCode?: unknown }).snCloseCode = undefined;
  vi.stubEnv("SERVICENOW_INSTANCE", `${SN}/`);
  vi.stubEnv("SERVICENOW_USER", "integration.hub");
  vi.stubEnv("SERVICENOW_PASSWORD", "s3cret");
});

afterEach(() => vi.unstubAllEnvs());

describe("ServiceNow connector", () => {
  it("does nothing when ServiceNow is not configured", async () => {
    vi.stubEnv("SERVICENOW_INSTANCE", "");
    insertOrder("bad-sku");
    const summary = await runIntegration(BASE);
    expect(summary.serviceNow).toEqual({ configured: false, created: 0, resolved: 0, errors: 0 });
    expect(snCalls).toHaveLength(0);
  });

  it("creates a ServiceNow incident when a message fails", async () => {
    insertOrder("bad-sku");
    const summary = await runIntegration(BASE);

    expect(summary.serviceNow).toMatchObject({ configured: true, created: 1, errors: 0 });
    expect(snCalls).toHaveLength(1);
    const [call] = snCalls;
    expect(call.method).toBe("POST");
    expect(call.path).toBe("/api/now/table/incident");
    expect(call.auth).toBe(`Basic ${Buffer.from("integration.hub:s3cret").toString("base64")}`);
    expect(call.body.short_description).toContain(messages()[0].external_ref!);
    expect(call.body.correlation_id).toBe(messages()[0].correlation_id);
    expect(incidents()[0]).toMatchObject({ sn_number: "INC0010001", sn_synced_status: "OPEN", sn_error: null });
  });

  it("sets the Caller when a caller sys_id is configured", async () => {
    vi.stubEnv("SERVICENOW_CALLER_SYS_ID", "abc123caller");
    insertOrder("bad-sku");
    await runIntegration(BASE);
    expect(snCalls[0].body.caller_id).toBe("abc123caller");
  });

  it("leaves the Caller empty when no caller is configured", async () => {
    insertOrder("bad-sku");
    await runIntegration(BASE);
    expect(snCalls[0].body).not.toHaveProperty("caller_id");
  });

  it("does not create the same ServiceNow incident twice", async () => {
    insertOrder("bad-sku");
    await runIntegration(BASE);
    await runIntegration(BASE);
    await syncIncidents();
    expect(snCalls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("resolves the ServiceNow incident after a successful reprocess", async () => {
    await failOneMessageDuringOutage();
    expect(incidents()[0].sn_synced_status).toBe("OPEN");

    setSetting("warehouse_failure_rate", "0");
    reprocessMessage(messages()[0].id);
    const summary = await runIntegration(BASE);

    expect(summary.serviceNow).toMatchObject({ resolved: 1, errors: 0 });
    const patch = snCalls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/now/table/incident/sys10001");
    expect(patch?.body).toMatchObject({ state: "6", close_code: "Solution provided" });
    expect(incidents()[0]).toMatchObject({ status: "RESOLVED", sn_synced_status: "RESOLVED" });
  });

  it("uses the instance's own value for the resolution code", async () => {
    snChoices = [
      { value: "duplicate", label: "Duplicate", language: "en" },
      { value: "solution_provided", label: "Solution provided", language: "en" },
    ];
    await failOneMessageDuringOutage();
    setSetting("warehouse_failure_rate", "0");
    reprocessMessage(messages()[0].id);
    await runIntegration(BASE);
    const patch = snCalls.find((c) => c.method === "PATCH");
    expect(patch?.body.close_code).toBe("solution_provided");
  });

  it("falls back to a 'solved' style code when the configured one does not exist", async () => {
    snChoices = [
      { value: "Not Solved (Too Costly)", label: "Not Solved (Too Costly)", language: "en" },
      { value: "Solved (Permanently)", label: "Solved (Permanently)", language: "en" },
    ];
    await failOneMessageDuringOutage();
    setSetting("warehouse_failure_rate", "0");
    reprocessMessage(messages()[0].id);
    await runIntegration(BASE);
    expect(snCalls.find((c) => c.method === "PATCH")?.body.close_code).toBe("Solved (Permanently)");
  });

  it("keeps the incident and retries the sync when ServiceNow is down", async () => {
    snMode = "down";
    insertOrder("bad-sku");
    const first = await runIntegration(BASE);

    expect(first.serviceNow).toMatchObject({ created: 0, errors: 1 });
    expect(incidents()[0].sn_error).toContain("HTTP 503");
    expect(incidents()[0].sn_number).toBeNull();

    snMode = "ok";
    const second = await syncIncidents();
    expect(second).toMatchObject({ created: 1, errors: 0 });
    expect(incidents()[0]).toMatchObject({ sn_number: "INC0010001", sn_error: null });
  });

  it("shows ServiceNow's detailed reason when an update is refused", async () => {
    await failOneMessageDuringOutage();
    snMode = "policy";
    setSetting("warehouse_failure_rate", "0");
    reprocessMessage(messages()[0].id);
    await runIntegration(BASE);
    expect(incidents()[0].sn_error).toBe(
      "HTTP 403: Operation Failed — Data Policy Exception: Caller is mandatory",
    );
    expect(incidents()[0].sn_synced_status).toBe("OPEN");
  });

  it("shows a clear message for a wrong password", async () => {
    snMode = "unauthorized";
    insertOrder("bad-sku");
    await runIntegration(BASE);
    expect(incidents()[0].sn_error).toBe("HTTP 401: wrong username or password");
  });
});