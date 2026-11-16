/**
 * Message formats for the two systems, and the mapping between them.
 * In SAP Integration Suite this would be a "message mapping" inside an iFlow.
 */

// ── Source format: what the Shop system sends ───────────────────────────
export type ShopOrderItem = { sku: string; name: string; qty: number; unitPrice: number };

export type ShopOrder = {
  id: number;
  customerName: string;
  customerEmail: string;
  country: string;
  items: ShopOrderItem[];
  createdAt: string;
};

// ── Target format: what the Warehouse system expects ────────────────────
export type ShipmentLine = {
  lineNo: number;
  materialNo: string;
  description: string;
  quantity: number;
};

export type ShipmentRequest = {
  externalRef: string;
  orderDate: string;
  shipTo: { name: string; country: string };
  lines: ShipmentLine[];
  totalValue: number;
  currency: "MYR";
};

export function toExternalRef(orderId: number): string {
  return `SO-${String(orderId).padStart(6, "0")}`;
}

/** Transform a Shop order into a Warehouse shipment request. */
export function mapOrderToShipment(order: ShopOrder): ShipmentRequest {
  const total = order.items.reduce((sum, i) => sum + i.qty * i.unitPrice, 0);
  return {
    externalRef: toExternalRef(order.id),
    orderDate: order.createdAt.slice(0, 10),
    shipTo: { name: order.customerName.trim(), country: order.country.toUpperCase() },
    lines: order.items.map((item, index) => ({
      lineNo: (index + 1) * 10, // SAP-style line numbering: 10, 20, 30…
      materialNo: item.sku,
      description: item.name,
      quantity: item.qty,
    })),
    totalValue: Math.round(total * 100) / 100,
    currency: "MYR",
  };
}

/**
 * The Warehouse system's input validation.
 * Returns a list of problems; an empty list means the request is valid.
 */
export function validateShipment(input: unknown): string[] {
  const errors: string[] = [];
  const s = input as Partial<ShipmentRequest> | null;

  if (!s || typeof s !== "object") return ["Body must be a JSON object"];
  if (!/^SO-\d{6}$/.test(s.externalRef ?? "")) errors.push("externalRef must look like SO-000123");
  if (!s.shipTo?.name) errors.push("shipTo.name is required");
  if (!/^[A-Z]{2}$/.test(s.shipTo?.country ?? "")) errors.push("shipTo.country must be a 2-letter code");
  if (!Array.isArray(s.lines) || s.lines.length === 0) {
    errors.push("At least one line is required");
  } else {
    s.lines.forEach((line) => {
      if (!/^[A-Z]{3}-\d{4}$/.test(line.materialNo ?? "")) {
        errors.push(`Line ${line.lineNo}: unknown material number "${line.materialNo}"`);
      }
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        errors.push(`Line ${line.lineNo}: quantity must be a positive whole number`);
      }
    });
  }
  return errors;
}
