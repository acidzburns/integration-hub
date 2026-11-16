import { NextResponse, type NextRequest } from "next/server";
import { get, getSetting, now, run } from "@/lib/db";
import { validateShipment, type ShipmentRequest } from "@/lib/mapping";

/**
 * Warehouse system API (the TARGET system)
 *   POST /api/warehouse/shipments
 *
 * Behaves like a real, slightly unreliable system:
 *  - random delay of 80–400 ms
 *  - fails with 503 at the "failure rate" set on the dashboard (simulated outage)
 *  - rejects bad data with 422
 *  - is idempotent: sending the same externalRef twice does not create a duplicate
 */
export async function POST(request: NextRequest) {
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 320));

  const failureRate = Number(getSetting("warehouse_failure_rate") || 0);
  if (Math.random() < failureRate) {
    return NextResponse.json({ error: "Warehouse system temporarily unavailable" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const errors = validateShipment(body);
  if (errors.length > 0) {
    return NextResponse.json({ error: "Validation failed", errors }, { status: 422 });
  }

  const shipment = body as ShipmentRequest;
  const existing = get<{ id: number }>(
    "SELECT id FROM warehouse_shipments WHERE external_ref = ?",
    shipment.externalRef,
  );
  if (existing) {
    return NextResponse.json({ shipmentId: existing.id, duplicate: true }, { status: 200 });
  }

  const result = run(
    "INSERT INTO warehouse_shipments (external_ref, payload_json, received_at) VALUES (?, ?, ?)",
    shipment.externalRef,
    JSON.stringify(shipment),
    now(),
  );
  return NextResponse.json({ shipmentId: Number(result.lastInsertRowid) }, { status: 201 });
}
