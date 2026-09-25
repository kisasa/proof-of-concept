import { describe, expect, it } from "vitest";
import { Testing } from "cdktn/lib/testing";
import { TemporalNamespace } from "./temporal-namespace.js";

const baseConfig = {
  environmentName: "prod",
  namespaceName: "example-dispatch",
  awsRegion: "us-east-1",
  vpcEndpointId: "vpce-0123456789abcdef0",
  privateHostedZoneId: "Z0123456789ABCDEFGHI",
  vpcEndpointDnsName: "vpce-0123456789abcdef0-abc12345.vpce-svc-0822256b6575ea37f.us-east-1.vpce.amazonaws.com",
};

function synth(config: typeof baseConfig = baseConfig): string {
  return Testing.synthScope((scope) => {
    new TemporalNamespace(scope, "temporal-namespace", config);
  });
}

describe("TemporalNamespace", () => {
  it("refuses a region connectivity hasn't been wired up for, even one PrivateLink itself supports", () => {
    // eu-west-1 is a real TemporalPrivateLink region but not in this
    // construct's own narrower CONNECTIVITY_REGION_OVERRIDES table.
    expect(() => synth({ ...baseConfig, awsRegion: "eu-west-1" })).toThrow(
      /Temporal Cloud connectivity is not wired up for region 'eu-west-1'/,
    );
  });

  it("scopes the connectivity rule to the requesting region's own override, not another region's", () => {
    const json = JSON.parse(synth({ ...baseConfig, awsRegion: "us-west-2" }));
    const rules = Object.values(json.resource?.temporalcloud_connectivity_rule ?? {}) as Array<{ region: string }>;
    expect(rules).toHaveLength(1);
    expect(rules[0]?.region).toBe("aws-us-west-2");
  });

  it("points the namespace-specific CNAME at the PrivateLink endpoint's own DNS name", () => {
    const json = JSON.parse(synth());
    const records = Object.values(json.resource?.aws_route53_record ?? {}) as Array<{
      zone_id: string;
      type: string;
      records: string[];
    }>;
    expect(records).toHaveLength(1);
    expect(records[0]?.zone_id).toBe(baseConfig.privateHostedZoneId);
    expect(records[0]?.type).toBe("CNAME");
    expect(records[0]?.records).toEqual([baseConfig.vpcEndpointDnsName]);
  });

  it("grants the service account admin on this namespace only", () => {
    const json = JSON.parse(synth());
    const serviceAccounts = Object.values(json.resource?.temporalcloud_service_account ?? {}) as Array<{
      namespace_accesses: Array<{ permission: string }>;
    }>;
    expect(serviceAccounts).toHaveLength(1);
    expect(serviceAccounts[0]?.namespace_accesses).toEqual([expect.objectContaining({ permission: "admin" })]);
  });
});
