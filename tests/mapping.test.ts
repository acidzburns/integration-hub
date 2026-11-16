import { describe, expect, it } from "vitest";
import { mapOrderToShipment, validateShipment, type ShopOrder } from "@/lib/mapping";
import { backoffSeconds, classify } from "@/lib/integration";

const order: ShopOrder = {
  id: 42,
  customerName: "  Lim Construction ",
  customerEmail: "orders@lim.example",
  country: "my",
  createdAt: "2026-11-16T03:15:00.000Z",
  items: [
    { sku: "DRL-1001", name: "Cordless Drill 18V", qty: 2, unitPrice: 589 },
    { sku: "SCR-0715", name: "Screws", qty: 3, unitPrice: 32.1 },
  ],
};

describe("mapOrderToShipment", () => {
  it("maps a shop order into the warehouse format", () => {
    const shipment = mapOrderToShipment(order);
    expect(shipment.externalRef).toBe("SO-000042");
    expect(shipment.orderDate).toBe("2026-11-16");
    expect(shipment.shipTo).toEqual({ name: "Lim Construction", country: "MY" });
    expect(shipment.lines.map((l) => l.lineNo)).toEqual([10, 20]);
    expect(shipment.lines[0]).toMatchObject({ materialNo: "DRL-1001", quantity: 2 });
    expect(shipment.totalValue).toBe(1274.3);
  });

  it("produces a shipment the warehouse accepts", () => {
    expect(validateShipment(mapOrderToShipment(order))).toEqual([]);
  });
});

describe("validateShipment", () => {
  it("rejects bad material numbers and zero quantities", () => {
    const bad = mapOrderToShipment({
      ...order,
      items: [
        { sku: "drl1001", name: "typo", qty: 1, unitPrice: 1 },
        { sku: "BIT-0450", name: "zero", qty: 0, unitPrice: 1 },
      ],
    });
    const errors = validateShipment(bad);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("unknown material number");
    expect(errors[1]).toContain("quantity");
  });

  it("rejects a non-object body", () => {
    expect(validateShipment(null)).toEqual(["Body must be a JSON object"]);
  });
});

describe("retry rules", () => {
  it("treats timeouts and 5xx as temporary, 4xx as permanent", () => {
    expect(classify(201)).toBe("SUCCESS");
    expect(classify(null)).toBe("TRANSIENT_ERROR");
    expect(classify(503)).toBe("TRANSIENT_ERROR");
    expect(classify(429)).toBe("TRANSIENT_ERROR");
    expect(classify(422)).toBe("PERMANENT_ERROR");
    expect(classify(400)).toBe("PERMANENT_ERROR");
  });

  it("backs off exponentially: 5s, 15s, 45s", () => {
    expect([1, 2, 3].map(backoffSeconds)).toEqual([5, 15, 45]);
  });
});
