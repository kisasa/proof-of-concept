import type { DataTerraformRemoteStateS3 } from "cdktn";

/**
 * What the temporal-workers stack publishes. Consumed by `listener.ts`, which
 * reads `namespaceId`/`namespaceClusterAddress`/`taskQueueName` via remote
 * state to give the webhook listener's own Temporal client the connection
 * info it needs to start a dispatch workflow — the `TEMPORAL_API_KEY` secret
 * itself is read separately, directly from its own already-existing SSM
 * parameter (`${this.parameterPrefix}TEMPORAL_API_KEY`, created by
 * `temporal-workers.ts`), the same way every other stack reads its own
 * secrets — not published here, since a stack output isn't the right place
 * for even an arn pointing at sensitive material when a well-known SSM path
 * already addresses it.
 *
 * Note what's absent: a future activity calling `ecs:RunTask` against the
 * specialist sandbox needs *that* stack's outputs
 * (`specialist-sandbox-stack-output.ts`), not this one's — this stack's
 * outputs describe the Temporal side only.
 *
 * A type alias rather than an interface, for the reason given in
 * network-stack-output.ts.
 */
export type TemporalStackOutput = {
  readonly namespaceId: string;
  readonly namespaceClusterAddress: string;
  readonly taskQueueName: string;
  readonly clusterArn: string;
  readonly serviceName: string;
  readonly logGroupName: string;
};

export function temporalStackOutputFromRemoteState(state: DataTerraformRemoteStateS3): TemporalStackOutput {
  return {
    namespaceId: state.getString("namespaceId"),
    namespaceClusterAddress: state.getString("namespaceClusterAddress"),
    taskQueueName: state.getString("taskQueueName"),
    clusterArn: state.getString("clusterArn"),
    serviceName: state.getString("serviceName"),
    logGroupName: state.getString("logGroupName"),
  };
}
