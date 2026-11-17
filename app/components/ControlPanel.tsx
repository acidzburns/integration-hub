"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createOrders, runNow, setFailureRate } from "@/app/actions";
import type { RunSummary } from "@/lib/integration";

const RATES = [
  { value: 0, label: "Healthy" },
  { value: 0.2, label: "20% errors" },
  { value: 0.5, label: "50% errors" },
  { value: 1, label: "Outage" },
];

/** Buttons that drive the demo: create traffic, run the hub, break the warehouse. */
export function ControlPanel({ failureRate }: { failureRate: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [autoRun, setAutoRun] = useState(false);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);

  // "Scheduler": while auto-run is on, run the integration every 5 seconds
  useEffect(() => {
    if (!autoRun) return;
    let cancelled = false;
    const tick = async () => {
      const summary = await runNow();
      if (!cancelled) {
        setLastRun(summary);
        router.refresh();
      }
    };
    tick();
    const timer = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [autoRun, router]);

  const button =
    "rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm font-medium shadow-sm transition hover:bg-zinc-50 disabled:opacity-50";

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-4 shadow-sm lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <button
          className={button}
          disabled={pending}
          onClick={() => startTransition(() => createOrders(5))}
        >
          + Create 5 orders
        </button>
        <button
          className={`${button} border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800`}
          disabled={pending || autoRun}
          onClick={() =>
            startTransition(async () => {
              setLastRun(await runNow());
            })
          }
        >
          ▶ Run integration
        </button>
        <label className="ml-1 flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-zinc-900"
            checked={autoRun}
            onChange={(e) => setAutoRun(e.target.checked)}
          />
          Auto-run every 5s
          {autoRun && <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />}
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs uppercase tracking-wide text-zinc-500">Warehouse</span>
        <div className="flex overflow-hidden rounded-md border border-zinc-300">
          {RATES.map((r) => (
            <button
              key={r.value}
              disabled={pending}
              onClick={() => startTransition(() => setFailureRate(r.value))}
              className={`border-l border-zinc-300 px-2.5 py-1.5 text-xs first:border-l-0 ${
                failureRate === r.value
                  ? r.value === 1
                    ? "bg-rose-600 text-white"
                    : r.value === 0
                      ? "bg-emerald-600 text-white"
                      : "bg-amber-500 text-white"
                  : "bg-white hover:bg-zinc-50"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {lastRun && (
        <p className="font-mono text-xs text-zinc-500 lg:basis-full">
          Last run: {lastRun.skipped ? "skipped (previous run still busy)" : (
            <>
              {lastRun.polled} polled · {lastRun.delivered} delivered · {lastRun.retrying} retrying ·{" "}
              {lastRun.failed} failed
              {lastRun.pollError && <span className="text-rose-600"> · poll error: {lastRun.pollError}</span>}
              {lastRun.serviceNow?.configured && (
                <>
                  {" "}· ServiceNow: {lastRun.serviceNow.created} created, {lastRun.serviceNow.resolved} resolved
                  {lastRun.serviceNow.errors > 0 && (
                    <span className="text-rose-600">, {lastRun.serviceNow.errors} error(s)</span>
                  )}
                </>
              )}
            </>
          )}
        </p>
      )}
    </div>
  );
}
