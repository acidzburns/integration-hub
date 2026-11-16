"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { setSetting } from "@/lib/db";
import { generateOrders } from "@/lib/shop";
import { reprocessMessage, runIntegration, type RunSummary } from "@/lib/integration";

/** The app's own address, so the hub can call the Shop and Warehouse APIs over HTTP. */
async function baseUrl() {
  const h = await headers();
  const host = h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export async function createOrders(count: number) {
  generateOrders(Math.min(Math.max(count, 1), 50));
  revalidatePath("/");
}

export async function runNow(): Promise<RunSummary> {
  const summary = await runIntegration(await baseUrl());
  revalidatePath("/", "layout");
  return summary;
}

export async function setFailureRate(rate: number) {
  setSetting("warehouse_failure_rate", String(Math.min(Math.max(rate, 0), 1)));
  revalidatePath("/");
}

export async function reprocess(id: number) {
  reprocessMessage(id);
  revalidatePath("/", "layout");
}
