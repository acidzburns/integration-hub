import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { reprocess } from "@/app/actions";
import { getMessage } from "@/lib/queries";
import { serviceNowLink } from "@/lib/servicenow";
import { StatusBadge, formatTime, timeAgo } from "@/app/components/ui";

export default function Page({ params }: PageProps<"/messages/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-zinc-500">Loading message…</p>}>
      <MessageDetail params={params} />
    </Suspense>
  );
}

function Json({ title, value }: { title: string; value: string | null }) {
  let pretty = value ?? "—";
  try {
    if (value) pretty = JSON.stringify(JSON.parse(value), null, 2);
  } catch {}
  return (
    <div className="min-w-0 rounded-lg border border-zinc-200 bg-white shadow-sm">
      <h3 className="border-b border-zinc-200 px-4 py-2 font-mono text-[11px] uppercase tracking-wide text-zinc-500">
        {title}
      </h3>
      <pre className="max-h-96 overflow-auto p-4 font-mono text-xs leading-relaxed">{pretty}</pre>
    </div>
  );
}

async function MessageDetail({ params }: { params: PageProps<"/messages/[id]">["params"] }) {
  await connection();
  const { id } = await params;
  const data = getMessage(Number(id));
  if (!data) notFound();
  const { message: m, attempts, incidents } = data;
  const canReprocess = (m.status === "FAILED" || m.status === "RETRY") && m.target_payload !== null;

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-900">
        ← Message monitor
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-zinc-200 bg-white p-5 shadow-sm">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">Message #{m.id}</h1>
            <StatusBadge status={m.status} />
          </div>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-500">Flow</dt>
            <dd>{m.flow}</dd>
            <dt className="text-zinc-500">Order ref</dt>
            <dd className="font-mono">{m.external_ref}</dd>
            <dt className="text-zinc-500">Correlation ID</dt>
            <dd className="font-mono text-xs leading-5">{m.correlation_id}</dd>
            <dt className="text-zinc-500">Created</dt>
            <dd>{formatTime(m.created_at)}</dd>
            <dt className="text-zinc-500">Attempts</dt>
            <dd>
              {m.attempts} of {m.max_attempts}
              {m.status === "RETRY" && ` · next retry ${timeAgo(m.next_retry_at)}`}
            </dd>
          </dl>
          {m.last_error && (
            <p className="mt-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{m.last_error}</p>
          )}
        </div>
        {canReprocess && (
          <form action={reprocess.bind(null, m.id)}>
            <button className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800">
              ↻ Reprocess
            </button>
            <p className="mt-1 max-w-48 text-xs text-zinc-500">Queues the message again with a fresh set of attempts.</p>
          </form>
        )}
      </header>

      <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
        <h2 className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold">Delivery log</h2>
        {attempts.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500">Not sent yet.</p>
        ) : (
          <ol className="divide-y divide-zinc-100">
            {attempts.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm">
                <span className="w-20 font-mono text-xs text-zinc-500">Attempt {a.attempt_no}</span>
                <StatusBadge status={a.outcome} />
                <span className="font-mono text-xs">HTTP {a.http_status ?? "—"}</span>
                <span className="font-mono text-xs text-zinc-500">{a.duration_ms} ms</span>
                <span className="text-xs text-zinc-500">{formatTime(a.started_at)}</span>
                {a.error && <span className="basis-full pl-24 text-xs text-rose-600">{a.error}</span>}
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Json title="Source · Shop order" value={m.source_payload} />
        <Json title="Target · Warehouse shipment (after mapping)" value={m.target_payload} />
      </section>

      {incidents.length > 0 && (
        <section className="rounded-lg border border-zinc-200 bg-white shadow-sm">
          <h2 className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold">Incidents</h2>
          <ul className="divide-y divide-zinc-100">
            {incidents.map((i) => (
              <li key={i.id} className="px-4 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs">INC{String(i.id).padStart(5, "0")}</span>
                  <StatusBadge status={i.status} />
                  <span className="text-xs text-zinc-500">opened {timeAgo(i.created_at)}</span>
                  {i.resolved_at && <span className="text-xs text-zinc-500">· resolved {timeAgo(i.resolved_at)}</span>}
                </div>
                <p className="mt-1">{i.title}</p>
                <p className="mt-0.5 text-xs text-zinc-500">{i.description}</p>
                {i.sn_sys_id && (
                  <p className="mt-1.5 text-xs">
                    ServiceNow{" "}
                    {serviceNowLink(i.sn_sys_id) ? (
                      <a
                        href={serviceNowLink(i.sn_sys_id)!}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-sky-700 hover:underline"
                      >
                        {i.sn_number ?? i.sn_sys_id} ↗
                      </a>
                    ) : (
                      <span className="font-mono">{i.sn_number}</span>
                    )}
                    {i.sn_synced_status && <span className="text-zinc-500"> · {i.sn_synced_status.toLowerCase()} in ServiceNow</span>}
                  </p>
                )}
                {i.sn_error && <p className="mt-1.5 text-xs text-rose-600">ServiceNow sync failed: {i.sn_error}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
