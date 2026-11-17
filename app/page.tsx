import Link from "next/link";
import { Suspense } from "react";
import { connection } from "next/server";
import { FLOW_NAME, type MessageStatus } from "@/lib/integration";
import { getOverview, getThroughput, listMessages, listOpenIncidents } from "@/lib/queries";
import { ControlPanel } from "./components/ControlPanel";
import { StatusBadge, timeAgo } from "./components/ui";

const FILTERS: (MessageStatus | "ALL")[] = ["ALL", "PENDING", "RETRY", "DELIVERED", "FAILED"];

export default function Page({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading monitor…</p>}>
      <Dashboard searchParams={searchParams} />
    </Suspense>
  );
}

async function Dashboard({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  await connection(); // always read fresh data from the database
  const params = await searchParams;
  const filter = FILTERS.includes(params.status as MessageStatus)
    ? (params.status as MessageStatus)
    : undefined;

  const o = getOverview();
  const throughput = getThroughput();
  const messages = listMessages(filter);
  const incidents = listOpenIncidents();
  const peak = Math.max(1, ...throughput.map((b) => b.success + b.error));

  const tiles = [
    { label: "Messages", value: o.total, hint: `${o.ordersInShop} orders in Shop` },
    {
      label: "Success rate",
      value: o.successRate === null ? "—" : `${(o.successRate * 100).toFixed(1)}%`,
      hint: `${o.delivered} delivered · ${o.failed} failed`,
      tone: o.successRate !== null && o.successRate < 0.9 ? "text-rose-600" : "",
    },
    {
      label: "In retry",
      value: o.retrying,
      hint: `${o.pending} pending`,
      tone: o.retrying > 0 ? "text-amber-600" : "",
    },
    {
      label: "Avg latency",
      value: o.avgLatencyMs === null ? "—" : `${o.avgLatencyMs} ms`,
      hint: "last 100 successful calls",
    },
    {
      label: "Open incidents",
      value: o.openIncidents,
      hint: `${o.shipmentsReceived} shipments in Warehouse`,
      tone: o.openIncidents > 0 ? "text-rose-600" : "",
    },
  ];

  return (
    <div className="space-y-6">
      <ControlPanel failureRate={o.failureRate} />

      {/* KPI tiles */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {tiles.map((t) => (
          <div key={t.label} className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
            <p className="font-mono text-[11px] uppercase tracking-wide text-zinc-500">{t.label}</p>
            <p className={`mt-1 text-2xl font-semibold tabular-nums ${t.tone ?? ""}`}>{t.value}</p>
            <p className="mt-1 text-xs text-zinc-500">{t.hint}</p>
          </div>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        {/* Throughput chart */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Delivery attempts · last 15 min</h2>
            <div className="flex gap-3 text-xs text-zinc-500">
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-emerald-500" /> success
              </span>
              <span className="flex items-center gap-1">
                <span className="h-2 w-2 rounded-sm bg-rose-400" /> error
              </span>
            </div>
          </div>
          <div className="mt-4 flex h-32 items-end gap-1">
            {throughput.map((b) => (
              <div
                key={b.minute.toISOString()}
                className="flex h-full flex-1 flex-col justify-end"
                title={`${b.minute.toLocaleTimeString("en-MY", { hour: "2-digit", minute: "2-digit" })} — ${b.success} success, ${b.error} error`}
              >
                <div className="bg-rose-400" style={{ height: `${(b.error / peak) * 100}%` }} />
                <div className="rounded-b-[1px] bg-emerald-500" style={{ height: `${(b.success / peak) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-400">
            <span>-15m</span>
            <span>now</span>
          </div>
        </section>

        {/* Incidents */}
        <section className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Open incidents</h2>
            {o.serviceNowHost ? (
              <span
                className={`flex items-center gap-1.5 font-mono text-[11px] ${
                  o.serviceNowErrors > 0 ? "text-rose-600" : "text-emerald-700"
                }`}
                title={o.serviceNowHost}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${o.serviceNowErrors > 0 ? "bg-rose-500" : "bg-emerald-500"}`}
                />
                ServiceNow {o.serviceNowErrors > 0 ? `· ${o.serviceNowErrors} sync error(s)` : "connected"}
              </span>
            ) : (
              <span className="font-mono text-[11px] text-zinc-400">ServiceNow not configured</span>
            )}
          </div>
          {incidents.length === 0 ? (
            <p className="mt-4 text-sm text-zinc-500">No open incidents. All failed messages have been handled.</p>
          ) : (
            <ul className="mt-3 divide-y divide-zinc-100">
              {incidents.map((i) => (
                <li key={i.id} className="py-2.5">
                  <Link href={`/messages/${i.message_id}`} className="group block">
                    <p className="text-sm font-medium group-hover:underline">
                      INC{String(i.id).padStart(5, "0")} · {i.title.replace("Integration failure: ", "")}
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{i.description}</p>
                    <p className="mt-0.5 font-mono text-[11px] text-zinc-400">
                      {timeAgo(i.created_at)}
                      {i.sn_number && <span className="text-emerald-700"> · ServiceNow {i.sn_number}</span>}
                      {i.sn_error && <span className="text-rose-600"> · sync failed: {i.sn_error}</span>}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Message monitor */}
      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Message monitor</h2>
            <p className="text-xs text-zinc-500">{FLOW_NAME}</p>
          </div>
          <nav className="flex gap-1">
            {FILTERS.map((f) => {
              const active = (filter ?? "ALL") === f;
              return (
                <Link
                  key={f}
                  href={f === "ALL" ? "/" : `/?status=${f}`}
                  className={`rounded px-2 py-1 font-mono text-[11px] ${
                    active ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
                  }`}
                >
                  {f}
                </Link>
              );
            })}
          </nav>
        </div>

        {messages.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-zinc-500">
            No messages yet. Click <b>Create 5 orders</b>, then <b>Run integration</b>.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left font-mono text-[11px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="px-4 py-2 font-medium">ID</th>
                  <th className="px-4 py-2 font-medium">Order ref</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Attempts</th>
                  <th className="px-4 py-2 font-medium">Last error</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {messages.map((m) => (
                  <tr key={m.id} className="hover:bg-zinc-50">
                    <td className="px-4 py-2 font-mono text-xs">
                      <Link href={`/messages/${m.id}`} className="text-sky-700 hover:underline">
                        #{m.id}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{m.external_ref}</td>
                    <td className="px-4 py-2">
                      <StatusBadge status={m.status} />
                      {m.status === "RETRY" && (
                        <span className="ml-2 font-mono text-[11px] text-zinc-500">
                          next {timeAgo(m.next_retry_at)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 tabular-nums">
                      {m.attempts}/{m.max_attempts}
                    </td>
                    <td className="max-w-xs truncate px-4 py-2 text-xs text-zinc-500" title={m.last_error ?? ""}>
                      {m.last_error ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-zinc-500">{timeAgo(m.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
