import { Fn, Token } from "cdktn";
import { Construct } from "constructs";
import { DataAwsAvailabilityZones } from "@cdktn/provider-aws/lib/data-aws-availability-zones";
import { InternetGateway } from "@cdktn/provider-aws/lib/internet-gateway";
import { Route } from "@cdktn/provider-aws/lib/route";
import { RouteTable } from "@cdktn/provider-aws/lib/route-table";
import { RouteTableAssociation } from "@cdktn/provider-aws/lib/route-table-association";
import { Subnet } from "@cdktn/provider-aws/lib/subnet";
import { Vpc } from "@cdktn/provider-aws/lib/vpc";

import { formatName } from "../common";

export interface NetworkVpcConfig {
  readonly name: string;
  readonly cidrBlock: string;

  /**
   * An application load balancer requires subnets in at least two availability
   * zones, so two is the floor rather than a preference.
   */
  readonly availabilityZoneCount: number;
  readonly globalTags: Record<string, string>;
}

/**
 * A public-subnet-only VPC: internet gateway, one subnet per availability zone,
 * and a single shared route table with a default route out through the gateway.
 *
 * There is deliberately no NAT gateway and no private tier. The listener's
 * inbound traffic arrives through the load balancer's security group, while its
 * outbound traffic (Anthropic, Linear, GitHub, ECR, CloudWatch) goes straight
 * out through the internet gateway. A NAT gateway would be the largest single
 * line item in this deployment and would buy nothing here: the task's security
 * group already accepts nothing but the load balancer.
 */
export class NetworkVpc extends Construct {
  public readonly vpc: Vpc;
  public readonly publicSubnetIds: string[];

  constructor(scope: Construct, id: string, config: NetworkVpcConfig) {
    super(scope, id);

    if (config.availabilityZoneCount < 2) {
      throw new Error("availabilityZoneCount must be at least 2 — an application load balancer requires two subnets");
    }

    const availabilityZones = new DataAwsAvailabilityZones(this, "azs", {
      state: "available",
    });

    this.vpc = new Vpc(this, "vpc", {
      cidrBlock: config.cidrBlock,

      // Both are required for the ECR hostnames to resolve from a task and for
      // the load balancer's own DNS name to work inside the VPC.
      enableDnsSupport: true,
      enableDnsHostnames: true,
      tags: { ...config.globalTags, Name: formatName(`${config.name}-vpc`) },
    });

    const internetGateway = new InternetGateway(this, "igw", {
      vpcId: this.vpc.id,
      tags: { ...config.globalTags, Name: formatName(`${config.name}-igw`) },
    });

    const routeTable = new RouteTable(this, "public-route-table", {
      vpcId: this.vpc.id,
      tags: { ...config.globalTags, Name: formatName(`${config.name}-public-rt`) },
    });

    new Route(this, "public-default-route", {
      routeTableId: routeTable.id,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: internetGateway.id,
    });

    const subnetIds: string[] = [];

    for (let index = 0; index < config.availabilityZoneCount; index += 1) {
      // /22 in, /24 subnets out — two spare blocks left over for a private tier
      // if this ever grows one.
      const subnet = new Subnet(this, `public-subnet-${index}`, {
        vpcId: this.vpc.id,
        cidrBlock: Fn.cidrsubnet(config.cidrBlock, 2, index),
        availabilityZone: Token.asString(Fn.element(availabilityZones.names, index)),

        // The task runs here with a public IP instead of behind a NAT gateway.
        mapPublicIpOnLaunch: true,
        tags: { ...config.globalTags, Name: formatName(`${config.name}-public-${index}`) },
      });

      new RouteTableAssociation(this, `public-route-table-association-${index}`, {
        subnetId: subnet.id,
        routeTableId: routeTable.id,
      });

      subnetIds.push(subnet.id);
    }

    this.publicSubnetIds = subnetIds;
  }
}
