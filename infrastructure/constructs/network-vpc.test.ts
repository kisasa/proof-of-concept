import { describe, expect, it } from "vitest";
import { Testing } from "cdktn/lib/testing";
import { NetworkVpc } from "./network-vpc.js";

const baseConfig = {
  name: "network-test",
  cidrBlock: "10.0.0.0/22",
  availabilityZoneCount: 2,
  globalTags: { project: "intent-to-production" },
};

function synth(config: typeof baseConfig = baseConfig): string {
  return Testing.synthScope((scope) => {
    new NetworkVpc(scope, "network", config);
  });
}

describe("NetworkVpc", () => {
  it("refuses fewer than 2 availability zones — an ALB requires at least two subnets", () => {
    expect(() => synth({ ...baseConfig, availabilityZoneCount: 1 })).toThrow(/availabilityZoneCount must be at least 2/);
  });

  it("enables DNS support and hostnames, required for ECR and load-balancer resolution", () => {
    const json = JSON.parse(synth());
    const vpcs = Object.values(json.resource?.aws_vpc ?? {}) as Array<{
      enable_dns_support: boolean;
      enable_dns_hostnames: boolean;
    }>;
    expect(vpcs).toHaveLength(1);
    expect(vpcs[0]?.enable_dns_support).toBe(true);
    expect(vpcs[0]?.enable_dns_hostnames).toBe(true);
  });

  it("creates one public subnet per availability zone, each with a public IP on launch", () => {
    const json = JSON.parse(synth({ ...baseConfig, availabilityZoneCount: 3 }));
    const subnets = Object.values(json.resource?.aws_subnet ?? {}) as Array<{ map_public_ip_on_launch: boolean }>;
    expect(subnets).toHaveLength(3);
    for (const subnet of subnets) {
      expect(subnet.map_public_ip_on_launch).toBe(true);
    }
  });

  it("routes the public route table's default route through the internet gateway, not a NAT gateway", () => {
    const json = JSON.parse(synth());
    expect(json.resource?.aws_nat_gateway).toBeUndefined();
    const routes = Object.values(json.resource?.aws_route ?? {}) as Array<{
      destination_cidr_block: string;
      gateway_id: unknown;
    }>;
    expect(routes).toHaveLength(1);
    expect(routes[0]?.destination_cidr_block).toBe("0.0.0.0/0");
    expect(routes[0]?.gateway_id).toBeDefined();
  });

  it("associates every subnet with the shared public route table", () => {
    const json = JSON.parse(synth({ ...baseConfig, availabilityZoneCount: 3 }));
    const associations = Object.values(json.resource?.aws_route_table_association ?? {});
    expect(associations).toHaveLength(3);
  });
});
