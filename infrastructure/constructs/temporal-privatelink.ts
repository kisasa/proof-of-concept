import { Construct } from "constructs";
import { Route53Record } from "@cdktn/provider-aws/lib/route53-record";
import { Route53Zone } from "@cdktn/provider-aws/lib/route53-zone";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group";
import { VpcEndpoint } from "@cdktn/provider-aws/lib/vpc-endpoint";

import { formatName, securityGroupDescription } from "../common";

export interface TemporalPrivateLinkConfig {
  readonly environmentName: string;
  readonly vpcId: string;
  readonly subnetIds: string[];
  readonly vpcCidrBlock: string;
  readonly awsRegion: string;
  readonly globalTags: Record<string, string>;
}

// Published and maintained by Temporal Cloud — see
// https://docs.temporal.io/cloud/connectivity/aws-connectivity. Keys are AWS
// region names; both tables are kept in lockstep on purpose, so a region present
// in one is always present in the other.
const PRIVATE_LINK_SERVICE_NAMES: Record<string, string> = {
  "ap-northeast-1": "com.amazonaws.vpce.ap-northeast-1.vpce-svc-08f34c33f9fb8a48a",
  "ap-northeast-2": "com.amazonaws.vpce.ap-northeast-2.vpce-svc-08c4d5445a5aad308",
  "ap-south-1": "com.amazonaws.vpce.ap-south-1.vpce-svc-0ad4f8ed56db15662",
  "ap-south-2": "com.amazonaws.vpce.ap-south-2.vpce-svc-08bcf602b646c69c1",
  "ap-southeast-1": "com.amazonaws.vpce.ap-southeast-1.vpce-svc-05c24096fa89b0ccd",
  "ap-southeast-2": "com.amazonaws.vpce.ap-southeast-2.vpce-svc-0634f9628e3c15b08",
  "ca-central-1": "com.amazonaws.vpce.ca-central-1.vpce-svc-080a781925d0b1d9d",
  "eu-central-1": "com.amazonaws.vpce.eu-central-1.vpce-svc-073a419b36663a0f3",
  "eu-west-1": "com.amazonaws.vpce.eu-west-1.vpce-svc-04388e89f3479b739",
  "eu-west-2": "com.amazonaws.vpce.eu-west-2.vpce-svc-0ac7f9f07e7fb5695",
  "sa-east-1": "com.amazonaws.vpce.sa-east-1.vpce-svc-0ca67a102f3ce525a",
  "us-east-1": "com.amazonaws.vpce.us-east-1.vpce-svc-0822256b6575ea37f",
  "us-east-2": "com.amazonaws.vpce.us-east-2.vpce-svc-01b8dccfc6660d9d4",
  "us-west-2": "com.amazonaws.vpce.us-west-2.vpce-svc-0f44b3d7302816b94",
};

// DNS override hostname used for the private-hosted-zone CNAME and as the
// cluster address workers connect to when PrivateLink is active — a single
// regional record covers every namespace, so no per-namespace DNS management is
// needed for this part (the per-namespace SNI hostname is a separate CNAME,
// added by `temporal-namespace.ts` into the same zone).
const PRIVATE_LINK_DNS_OVERRIDES: Record<string, string> = {
  "ap-northeast-1": "aws-ap-northeast-1.region.tmprl.cloud",
  "ap-northeast-2": "aws-ap-northeast-2.region.tmprl.cloud",
  "ap-south-1": "aws-ap-south-1.region.tmprl.cloud",
  "ap-south-2": "aws-ap-south-2.region.tmprl.cloud",
  "ap-southeast-1": "aws-ap-southeast-1.region.tmprl.cloud",
  "ap-southeast-2": "aws-ap-southeast-2.region.tmprl.cloud",
  "ca-central-1": "aws-ca-central-1.region.tmprl.cloud",
  "eu-central-1": "aws-eu-central-1.region.tmprl.cloud",
  "eu-west-1": "aws-eu-west-1.region.tmprl.cloud",
  "eu-west-2": "aws-eu-west-2.region.tmprl.cloud",
  "sa-east-1": "aws-sa-east-1.region.tmprl.cloud",
  "us-east-1": "aws-us-east-1.region.tmprl.cloud",
  "us-east-2": "aws-us-east-2.region.tmprl.cloud",
  "us-west-2": "aws-us-west-2.region.tmprl.cloud",
};

/**
 * Keeps worker→Temporal Cloud gRPC traffic (port 7233) on the AWS backbone
 * instead of the public internet, via an Interface VPC Endpoint. Chosen over
 * Temporal Cloud's public endpoint specifically because it doesn't need a NAT
 * gateway — it layers onto the existing public-subnet-only `network` stack
 * without reopening the NAT decision made there, at a modest fixed cost.
 *
 * Ported from the reference CDKTF project's `CloudPrivateLink` construct.
 * The zone is deliberately named "tmprl.cloud" (not environment-scoped) —
 * anything narrower couldn't intercept queries for the region's PrivateLink DNS
 * override name, which would fall through to public DNS and bypass PrivateLink
 * entirely. `temporal-namespace.ts` adds the per-namespace CNAME into this same
 * zone via `phzZoneId`.
 */
export class TemporalPrivateLink extends Construct {
  public readonly regionalEndpoint: string;
  public readonly vpcEndpointId: string;
  public readonly vpcEndpointDnsName: string;
  public readonly phzZoneId: string;

  constructor(scope: Construct, id: string, config: TemporalPrivateLinkConfig) {
    super(scope, id);

    const serviceName = PRIVATE_LINK_SERVICE_NAMES[config.awsRegion];
    const regionalEndpoint = PRIVATE_LINK_DNS_OVERRIDES[config.awsRegion];

    if (serviceName === undefined || regionalEndpoint === undefined) {
      throw new Error(
        `Temporal Cloud PrivateLink is not available in region '${config.awsRegion}'. ` +
          `Supported regions: ${Object.keys(PRIVATE_LINK_SERVICE_NAMES).join(", ")}`,
      );
    }

    this.regionalEndpoint = regionalEndpoint;

    const endpointSecurityGroup = new SecurityGroup(this, "endpoint-security-group", {
      name: formatName(`${config.environmentName}-temporal-endpoint-sg`, 255),
      description: securityGroupDescription("Temporal gRPC from workers in this VPC"),
      vpcId: config.vpcId,
      ingress: [
        {
          fromPort: 7233,
          toPort: 7233,
          protocol: "tcp",
          cidrBlocks: [config.vpcCidrBlock],
          description: securityGroupDescription("Temporal gRPC from workers in this VPC"),
        },
      ],
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
          description: securityGroupDescription("To Temporal Cloud"),
        },
      ],
      tags: config.globalTags,
    });

    // No public IP, no route through an internet gateway — private DNS is
    // disabled because the private hosted zone below controls resolution
    // instead.
    const vpcEndpoint = new VpcEndpoint(this, "vpc-endpoint", {
      vpcId: config.vpcId,
      serviceName: serviceName,
      vpcEndpointType: "Interface",
      subnetIds: config.subnetIds,
      privateDnsEnabled: false,
      ipAddressType: "ipv4",
      securityGroupIds: [endpointSecurityGroup.id],
      tags: { ...config.globalTags, Name: formatName(`${config.environmentName}-temporal-privatelink`) },
    });

    const privateHostedZone = new Route53Zone(this, "private-hosted-zone", {
      name: "tmprl.cloud",
      tags: config.globalTags,
      vpc: [{ vpcId: config.vpcId }],
    });

    const endpointDnsName = vpcEndpoint.dnsEntry.get(0).dnsName;

    new Route53Record(this, "regional-cname", {
      zoneId: privateHostedZone.zoneId,
      name: this.regionalEndpoint,
      type: "CNAME",
      ttl: 300,
      records: [endpointDnsName],
    });

    this.vpcEndpointId = vpcEndpoint.id;
    this.vpcEndpointDnsName = endpointDnsName;
    this.phzZoneId = privateHostedZone.zoneId;
  }
}
