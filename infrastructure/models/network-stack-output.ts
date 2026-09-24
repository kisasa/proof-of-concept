import type { DataTerraformRemoteStateS3 } from "cdktn";

/**
 * What the network stack publishes and the listener stack consumes.
 *
 * The reference C# project reads cross-stack outputs by reflecting over a
 * record's constructor parameters and dispatching on their declared types
 * (StreampayStack.GetStackOutput). TypeScript has no runtime view of an
 * interface, so the read is spelled out instead: this codec is the TypeScript
 * equivalent, and its cost is exactly why the project is two stacks rather
 * than three.
 *
 * The field names here are the Terraform output names — `renderOutputs` in the
 * base stack derives them from the keys of the object it is handed, so the two
 * sides stay in sync only as long as both use this same declaration.
 *
 * Declared as a type alias rather than an interface on purpose: only aliases get
 * an implicit index signature, which is what lets `renderOutputs` accept this as
 * a `Record` while still type-checking the keys at the call site.
 */
export type NetworkStackOutput = {
  readonly vpcId: string;
  readonly publicSubnetIds: string[];
};

export function networkStackOutputFromRemoteState(state: DataTerraformRemoteStateS3): NetworkStackOutput {
  return {
    vpcId: state.getString("vpcId"),
    publicSubnetIds: state.getList("publicSubnetIds"),
  };
}
