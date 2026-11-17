import { all, run } from "./db";

/**
 * ServiceNow connector — syncs the hub's incidents to a real ServiceNow instance
 * using the ServiceNow Table API (REST).
 *
 * It works like an "outbox": incidents are always saved locally first, then this
 * sync pushes them to ServiceNow. If ServiceNow is down or the password is wrong,
 * nothing is lost — the sync simply tries again on the next run.
 *
 * Settings come from environment variables (.env.local), never from the code:
 *   SERVICENOW_INSTANCE   e.g. https://dev12345.service-now.com
 *   SERVICENOW_USER       e.g. admin
 *   SERVICENOW_PASSWORD   your instance password
 *   SERVICENOW_CLOSE_CODE optional, default "Solution provided"
 *   SERVICENOW_CALLER_SYS_ID optional, sys_id of the user to set as Caller
 */

export type ServiceNowConfig = {
  instance: string;
  user: string;
  password: string;
  closeCode: string;
  callerSysId: string | null;
};

export function getServiceNowConfig(): ServiceNowConfig | null {
  const instance = process.env.SERVICENOW_INSTANCE?.trim().replace(/\/+$/, "");
  const user = process.env.SERVICENOW_USER?.trim();
  const password = process.env.SERVICENOW_PASSWORD;
  if (!instance || !user || !password) return null;
  return {
    instance,
    user,
    password,
    closeCode: process.env.SERVICENOW_CLOSE_CODE?.trim() || "Solution provided",
    callerSysId: process.env.SERVICENOW_CALLER_SYS_ID?.trim() || null,
  };
}

/** Link that opens a ServiceNow incident record in the browser. */
export function serviceNowLink(sysId: string): string | null {
  const config = getServiceNowConfig();
  return config ? `${config.instance}/nav_to.do?uri=incident.do?sys_id=${sysId}` : null;
}

type IncidentToSync = {
  id: number;
  message_id: number;
  title: string;
  description: string;
  status: "OPEN" | "RESOLVED";
  sn_sys_id: string | null;
  sn_synced_status: string | null;
  correlation_id: string;
  external_ref: string;
};

export type SyncSummary = { configured: boolean; created: number; resolved: number; errors: number };

const TIMEOUT_MS = 10_000;

async function callServiceNow(config: ServiceNowConfig, method: "GET" | "POST" | "PATCH", path: string, body?: object) {
  const res = await fetch(`${config.instance}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });

  const text = await res.text();
  let data: { result?: { sys_id?: string; number?: string } & Record<string, unknown>; error?: { message?: string; detail?: string } } = {};
  try {
    data = JSON.parse(text);
  } catch {
    // Hibernating instances answer with an HTML page instead of JSON
    if (text.toLowerCase().includes("hibernat")) {
      throw new Error("Instance is hibernating. Open it in your browser to wake it up.");
    }
  }

  if (!res.ok) {
    if (res.status === 401) throw new Error("HTTP 401: wrong username or password");
    // ServiceNow puts a short summary in "message" and the real reason in "detail"
    const parts = [data.error?.message, data.error?.detail].filter(Boolean);
    const detail = parts.length > 0 ? parts.join(" — ") : text.slice(0, 120);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  if (!data.result) throw new Error("Unexpected response from ServiceNow (not JSON)");
  return data.result;
}

type Choice = { value: string; label: string };
const choiceCache = globalThis as unknown as { snCloseCode?: { key: string; value: string } };

/**
 * Find a valid "Resolution code" value for this instance.
 * Dropdowns store a hidden value that can differ between ServiceNow releases,
 * so we read the instance's own choice list (sys_choice table) and pick:
 *   1. the choice matching SERVICENOW_CLOSE_CODE (by value or label), else
 *   2. one that sounds like "solution provided / solved / resolved", else
 *   3. the first active choice.
 * If the list can't be read (e.g. no permission), we use the configured value as-is.
 */
export async function resolveCloseCode(config: ServiceNowConfig): Promise<string> {
  const key = `${config.instance}|${config.closeCode}`;
  if (choiceCache.snCloseCode?.key === key) return choiceCache.snCloseCode.value;

  let value = config.closeCode;
  try {
    const query = encodeURIComponent("name=incident^element=close_code^inactive=false");
    const res = await fetch(
      `${config.instance}/api/now/table/sys_choice?sysparm_query=${query}&sysparm_fields=value,label,language&sysparm_limit=100`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString("base64")}`,
        },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (res.ok) {
      const rows = ((await res.json()).result ?? []) as (Choice & { language?: string })[];
      const choices = rows.filter((c) => c.value && (!c.language || c.language === "en"));
      const wanted = config.closeCode.toLowerCase();
      const pick =
        choices.find((c) => c.value.toLowerCase() === wanted || c.label?.toLowerCase() === wanted) ??
        choices.find((c) => /solution provided|solved \(permanently\)/i.test(`${c.label} ${c.value}`)) ??
        choices.find((c) => /solved|resolved/i.test(c.label) && !/\bnot\b|no resolution/i.test(c.label)) ??
        choices[0];
      if (pick) value = pick.value;
    }
  } catch {
    // keep the configured value
  }
  choiceCache.snCloseCode = { key, value };
  return value;
}

function recordError(id: number, err: unknown) {
  const message = err instanceof Error
    ? (err.name === "TimeoutError" ? "Timed out waiting for ServiceNow" : err.message)
    : String(err);
  run("UPDATE incidents SET sn_error = ? WHERE id = ?", message, id);
}

/** Push new incidents to ServiceNow and resolve the ones fixed in the hub. */
export async function syncIncidents(limit = 20): Promise<SyncSummary> {
  const config = getServiceNowConfig();
  const summary: SyncSummary = { configured: config !== null, created: 0, resolved: 0, errors: 0 };
  if (!config) return summary;

  const pending = all<IncidentToSync>(
    `SELECT i.id, i.message_id, i.title, i.description, i.status, i.sn_sys_id, i.sn_synced_status,
            m.correlation_id, m.external_ref
     FROM incidents i JOIN messages m ON m.id = i.message_id
     WHERE i.sn_sys_id IS NULL
        OR (i.status = 'RESOLVED' AND COALESCE(i.sn_synced_status, '') <> 'RESOLVED')
     ORDER BY i.id LIMIT ?`,
    limit,
  );

  for (const incident of pending) {
    try {
      let sysId = incident.sn_sys_id;

      // 1. Create the incident in ServiceNow if it isn't there yet
      if (!sysId) {
        const created = await callServiceNow(config, "POST", "/api/now/table/incident", {
          short_description: incident.title.slice(0, 160),
          description: [
            incident.description,
            "",
            `Order reference: ${incident.external_ref}`,
            `Correlation ID: ${incident.correlation_id}`,
            `Hub incident: INC-HUB-${incident.id}`,
            "Raised automatically by Integration Hub.",
          ].join("\n"),
          category: "software",
          impact: "2",
          urgency: "2",
          correlation_id: incident.correlation_id,
          correlation_display: "Integration Hub",
          ...(config.callerSysId ? { caller_id: config.callerSysId } : {}),
        });
        sysId = created.sys_id ?? null;
        if (!sysId) throw new Error("ServiceNow did not return a sys_id");
        run(
          `UPDATE incidents SET sn_sys_id = ?, sn_number = ?, sn_synced_status = 'OPEN',
             sn_error = NULL, sn_synced_at = ? WHERE id = ?`,
          sysId,
          created.number ?? null,
          new Date().toISOString(),
          incident.id,
        );
        summary.created++;
      }

      // 2. If the hub already fixed it, resolve it in ServiceNow too
      if (incident.status === "RESOLVED") {
        await callServiceNow(config, "PATCH", `/api/now/table/incident/${sysId}`, {
          state: "6", // 6 = Resolved
          close_code: await resolveCloseCode(config),
          close_notes: `Message ${incident.external_ref} was reprocessed and delivered successfully by Integration Hub.`,
        });
        run(
          "UPDATE incidents SET sn_synced_status = 'RESOLVED', sn_error = NULL, sn_synced_at = ? WHERE id = ?",
          new Date().toISOString(),
          incident.id,
        );
        summary.resolved++;
      }
    } catch (err) {
      recordError(incident.id, err);
      summary.errors++;
    }
  }
  return summary;
}