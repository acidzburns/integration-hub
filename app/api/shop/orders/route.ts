import { NextResponse, type NextRequest } from "next/server";
import { generateOrders, listOrdersAfter } from "@/lib/shop";

/**
 * Shop system API (the SOURCE system)
 *   GET  /api/shop/orders?after=120   → orders created after order 120
 *   POST /api/shop/orders {"count":5} → create test orders
 */
export async function GET(request: NextRequest) {
  const after = Number(request.nextUrl.searchParams.get("after") ?? 0);
  if (!Number.isInteger(after) || after < 0) {
    return NextResponse.json({ error: "after must be a non-negative integer" }, { status: 400 });
  }
  return NextResponse.json({ orders: listOrdersAfter(after) });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const count = Math.min(Math.max(Number(body.count) || 1, 1), 50);
  generateOrders(count);
  return NextResponse.json({ created: count }, { status: 201 });
}
