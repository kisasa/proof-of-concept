import type { DataTerraformRemoteStateS3 } from "cdktn";

/**
 * What the specialist-sandbox stack publishes, and what `temporal-workers.ts`
 * reads via remote state — the same way `listener.ts` reads `network`'s
 * outputs — to call `ecs:RunTask` against this task definition and grant its
 * own task role the IAM permission to do so.
 *
 * A type alias rather than an interface, for the reason given in
 * network-stack-output.ts.
 */
export type SpecialistSandboxStackOutput = {
  readonly clusterArn: string;
  readonly taskDefinitionArn: string;
  readonly taskDefinitionFamily: string;
  readonly securityGroupId: string;
  readonly executionRoleArn: string;
  readonly taskRoleArn: string;
  readonly logGroupName: string;
};

export function specialistSandboxStackOutputFromRemoteState(
  state: DataTerraformRemoteStateS3,
): SpecialistSandboxStackOutput {
  return {
    clusterArn: state.getString("clusterArn"),
    taskDefinitionArn: state.getString("taskDefinitionArn"),
    taskDefinitionFamily: state.getString("taskDefinitionFamily"),
    securityGroupId: state.getString("securityGroupId"),
    executionRoleArn: state.getString("executionRoleArn"),
    taskRoleArn: state.getString("taskRoleArn"),
    logGroupName: state.getString("logGroupName"),
  };
}
