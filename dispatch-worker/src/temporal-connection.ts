/**
 * The worker's connection to Temporal — `NativeConnection`
 * (`@temporalio/worker`), not `@temporalio/client`'s `Connection`: this
 * process executes workflows/activities, it doesn't start them, and the
 * Worker polls its task queue over the native (Rust-core) connection, a
 * distinct class from the gRPC client connection a caller like
 * webhook-listener would use to start a workflow.
 *
 * Confirmed shape via @temporalio/worker's own connection-options.d.ts, not
 * guessed: `{ address, tls, apiKey }`, same as the reference Example Payments
 * project's worker connects to Temporal Cloud with TLS + an API key over
 * PrivateLink (`TEMPORAL_HOST` is the PrivateLink-routed namespace address
 * `temporal-workers.ts`'s outputs already expose). `tls`/`apiKey` are both
 * config-driven, not hardcoded — a local Temporal dev server
 * (`temporalio/auto-setup`, no namespace auth) runs without either.
 */

import { NativeConnection } from "@temporalio/worker";
import type { WorkerConfig } from "./worker-config.js";

export function connectToTemporal(config: WorkerConfig): Promise<NativeConnection> {
  return NativeConnection.connect({
    address: config.temporalHost,
    tls: config.temporalTls,
    apiKey: config.temporalApiKey,
  });
}
