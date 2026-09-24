/**
 * This process's connection to Temporal for *starting* workflows —
 * `@temporalio/client`'s `Connection`/`Client`, not `@temporalio/worker`'s
 * `NativeConnection`: this process never executes a workflow or activity, it
 * only calls `client.workflow.start(...)` and returns. Same TLS + API key
 * shape as `dispatch-worker/src/temporal-connection.ts`'s own worker
 * connection (confirmed against `@temporalio/client`'s own
 * `connection.d.ts`: `ConnectionOptions.apiKey` exists on this class too, not
 * just `NativeConnection`'s). Both `tls` and `apiKey` are config-driven, not
 * hardcoded — a local Temporal dev server (`temporalio/auto-setup`, no
 * namespace auth) runs without either.
 *
 * `dispatchStoryWorkflow` itself is never imported here — dispatch-worker and
 * webhook-listener are separate npm packages with no shared lib (the
 * existing pattern throughout this repo). The workflow is started by its
 * string type name instead, which Temporal resolves against whatever the
 * `temporal-workers` service has registered on `TEMPORAL_TASK_QUEUE` — see
 * `dispatch-trigger.ts` for the literal name and the locally-mirrored input
 * shape.
 */

import { Connection, Client } from "@temporalio/client";

export interface TemporalClientConfig {
  readonly temporalHost: string;
  readonly temporalNamespace: string;
  readonly temporalTaskQueue: string;
  /** Optional: Temporal Cloud requires one, a local dev server doesn't have one at all. */
  readonly temporalApiKey: string | undefined;
  /** Defaults `true` (Temporal Cloud) — only `TEMPORAL_TLS=false` turns it off. */
  readonly temporalTls: boolean;
}

export async function createTemporalClient(config: TemporalClientConfig): Promise<Client> {
  const connection = await Connection.connect({
    address: config.temporalHost,
    tls: config.temporalTls,
    apiKey: config.temporalApiKey,
  });
  return new Client({ connection: connection, namespace: config.temporalNamespace });
}

// Env is read once, at module load — same rule as everywhere else in this
// repo — but validated lazily, on first real use (getClient()), not here.
// Only one of this app's four lanes touches Temporal; a webhook-listener
// deployed before temporal-workers exists (documented elsewhere as
// "registered but not yet applyable") must still route Intake/Specification/
// Decompose without crashing at startup, the same lenient posture
// tracker-notifier.ts's own default export already takes for
// LINEAR_AGENT_API_KEY.
const envConfig: TemporalClientConfig = {
  temporalHost: process.env.TEMPORAL_HOST ?? "",
  temporalNamespace: process.env.TEMPORAL_NAMESPACE ?? "",
  temporalTaskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "",
  temporalApiKey: process.env.TEMPORAL_API_KEY || undefined,
  temporalTls: process.env.TEMPORAL_TLS !== "false",
};

// Only the string fields that must be genuinely present are checked here —
// temporalApiKey is legitimately optional and temporalTls is a boolean, so
// neither belongs in a generic truthy-over-every-field loop.
function requireConfigured(config: TemporalClientConfig): void {
  const required: Record<string, string> = {
    temporalHost: config.temporalHost,
    temporalNamespace: config.temporalNamespace,
    temporalTaskQueue: config.temporalTaskQueue,
  };
  for (const [key, value] of Object.entries(required)) {
    if (!value) throw new Error(`Missing required env var for the Temporal client: ${key}`);
  }
}

let clientPromise: Promise<Client> | null = null;

/** The task queue every dispatch workflow starts on — read once at module load. */
export function temporalTaskQueue(): string {
  requireConfigured(envConfig);
  return envConfig.temporalTaskQueue;
}

export function getClient(): Promise<Client> {
  if (!clientPromise) {
    requireConfigured(envConfig);
    clientPromise = createTemporalClient(envConfig);
  }
  return clientPromise;
}
