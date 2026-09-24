import { describe, expect, it } from "vitest";
import { Testing } from "cdktn/lib/testing";
import { TemporalPrivateLink } from "./temporal-privatelink.js";

const baseConfig = {
  environmentName: "prod",
  vpcId: "vpc-0123456789abcdef0",
  subnetIds: ["subnet-aaaaaaaa", "subnet-bbbbbbbb"],
  vpcCidrBlock: "10.0.0.0/22",
  awsRegion: "us-east-1",
  globalTags: { project: "intent-to-production" },
};

function synth(config: typeof baseConfig = baseConfig): string {
  return Testing.synthScope((scope) => {
    new TemporalPrivateLink(scope, "temporal-privatelink", config);
  });
}

describe("TemporalPrivateLink", () => {
  it("refuses a region Temporal Cloud PrivateLink doesn't publish a service name for", () => {
    expect(() => synth({ ...baseConfig, awsRegion: "us-gov-west-1" })).toThrow(
      /PrivateLink is not available in region 'us-gov-west-1'/,
    );
  });

  it("resolves the region's own PrivateLink service name and DNS override, not another region's", () => {
    const json = JSON.parse(synth({ ...baseConfig, awsRegion: "eu-west-1" }));
    const endpoints = Object.values(json.resource?.aws_vpc_endpoint ?? {}) as Array<{ service_name: string }>;
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.service_name).toBe("com.amazonaws.vpce.eu-west-1.vpce-svc-04388e89f3479b739");

    const records = Object.values(json.resource?.aws_route53_record ?? {}) as Array<{ name: string }>;
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("aws-eu-west-1.region.tmprl.cloud");
  });

  it("disables private DNS on the endpoint itself — resolution is controlled by the private hosted zone instead", () => {
    const json = JSON.parse(synth());
    const endpoints = Object.values(json.resource?.aws_vpc_endpoint ?? {}) as Array<{ private_dns_enabled: boolean }>;
    expect(endpoints[0]?.private_dns_enabled).toBe(false);
  });

  it("restricts the endpoint security group's ingress to the VPC's own CIDR block on port 7233", () => {
    const json = JSON.parse(synth());
    const groups = Object.values(json.resource?.aws_security_group ?? {}) as Array<{
      ingress: Array<{ from_port: number; to_port: number; cidr_blocks: string[] }>;
    }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]?.ingress).toEqual([
      expect.objectContaining({
        from_port: 7233,
        to_port: 7233,
        cidr_blocks: [baseConfig.vpcCidrBlock],
      }),
    ]);
  });
});
