import { all, getDb, now } from "./db";
import type { ShopOrder, ShopOrderItem } from "./mapping";

/** The simulated Shop (source) system. */

const CATALOGUE: Omit<ShopOrderItem, "qty">[] = [
  { sku: "DRL-1001", name: "Cordless Drill 18V", unitPrice: 589.0 },
  { sku: "ANC-2040", name: "Wedge Anchor M10 (box of 50)", unitPrice: 74.5 },
  { sku: "SAW-3302", name: "Circular Saw 190mm", unitPrice: 729.0 },
  { sku: "BIT-0450", name: "SDS Drill Bit Set", unitPrice: 119.9 },
  { sku: "LSR-5100", name: "Line Laser Level", unitPrice: 1249.0 },
  { sku: "SCR-0715", name: "Self-tapping Screws (pack of 200)", unitPrice: 32.0 },
];

const CUSTOMERS = [
  { name: "Binaan Jaya Sdn Bhd", email: "procurement@binaanjaya.example", country: "MY" },
  { name: "Lim Construction", email: "orders@limconstruction.example", country: "MY" },
  { name: "Harbour Build Pte Ltd", email: "buy@harbourbuild.example", country: "SG" },
  { name: "PT Karya Beton", email: "purchasing@karyabeton.example", country: "ID" },
  { name: "Siam Steelworks", email: "supply@siamsteel.example", country: "TH" },
];

const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/**
 * Create random orders. About 1 in 10 has bad data (a typo in a SKU or a zero
 * quantity) so you can see how the hub handles permanent errors.
 */
export function generateOrders(count: number): number {
  const insert = getDb().prepare(
    "INSERT INTO shop_orders (customer_name, customer_email, country, items_json, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < count; i++) {
    const customer = pick(CUSTOMERS);
    const lineCount = 1 + Math.floor(Math.random() * 3);
    const items: ShopOrderItem[] = Array.from({ length: lineCount }, () => ({
      ...pick(CATALOGUE),
      qty: 1 + Math.floor(Math.random() * 12),
    }));

    if (Math.random() < 0.1) {
      const broken = items[0];
      if (Math.random() < 0.5) broken.qty = 0;
      else broken.sku = broken.sku.toLowerCase().replace("-", "");
    }

    insert.run(customer.name, customer.email, customer.country, JSON.stringify(items), now());
  }
  return count;
}

type OrderRow = {
  id: number;
  customer_name: string;
  customer_email: string;
  country: string;
  items_json: string;
  created_at: string;
};

/** New orders after a given order ID — how the hub "polls" the shop. */
export function listOrdersAfter(afterId: number, limit = 50): ShopOrder[] {
  return all<OrderRow>(
    "SELECT * FROM shop_orders WHERE id > ? ORDER BY id LIMIT ?",
    afterId,
    limit,
  ).map((row) => ({
    id: row.id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    country: row.country,
    items: JSON.parse(row.items_json),
    createdAt: row.created_at,
  }));
}
