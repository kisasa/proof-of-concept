import type { Construct } from "constructs";

import { tfStateKeys } from "../common";
import { NetworkVpc } from "../constructs/network-vpc";
import type { NetworkStackOutput } from "../models/network-stack-output";
import { BaseStack } from "./base-stack";

/**
 * The slow-moving half of the deployment: the VPC and its public subnets, which
 * change essentially never. Kept separate from the listener stack so that
 * bumping an image tag does not plan against the network.
 */
export class NetworkStack extends BaseStack {
  constructor(scope: Construct) {
    super(scope, tfStateKeys.network, "network");

    const tags = { ...this.globalTags, stack: `network-${this.listener.environmentName}` };

    const network = new NetworkVpc(this, "vpc", {
      name: `${this.resourceNamePrefix}-${this.listener.environmentName}`,
      cidrBlock: this.vpcCidrBlock,
      availabilityZoneCount: 2,
      globalTags: tags,
    });

    const outputs: NetworkStackOutput = {
      vpcId: network.vpc.id,
      publicSubnetIds: network.publicSubnetIds,
    };

    this.renderOutputs(outputs);
  }
}
