import type { MessageStatus } from "@/lib/integration";

/** Small shared display helpers (no client-side code). */

const STATUS_STYLES: Record<string, string> = {
  DELIVERED: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  PENDING: "bg-sky-50 text-sky-700 ring-sky-600/20",
  RETRY: "bg-amber-50 text-amber-800 ring-amber-600/25",
  FAILED: "bg-rose-50 text-rose-700 ring-rose-600/20",
  OPEN: "bg-rose-50 text-rose-700 ring-rose-600/20",
  RESOLVED: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  SUCCESS: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  TRANSIENT_ERROR: "bg-amber-50 text-amber-800 ring-amber-600/25",
  PERMANENT_ERROR: "bg-rose-50 text-rose-700 ring-rose-600/20",
};

export function StatusBadge({ status }: { status: MessageStatus | string }) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] font-medium ring-1 ring-inset ${
        STATUS_STYLES[status] ?? "bg-zinc-100 text-zinc-700 ring-zinc-500/20"
      }`}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 0) return `in ${-seconds}s`;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-MY");
}

export function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-MY", { dateStyle: "medium", timeStyle: "medium" });
}
