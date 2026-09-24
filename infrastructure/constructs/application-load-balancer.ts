import { Construct } from "constructs";
import { Lb } from "@cdktn/provider-aws/lib/lb";
import { LbListener } from "@cdktn/provider-aws/lib/lb-listener";
import { LbTargetGroup } from "@cdktn/provider-aws/lib/lb-target-group";
import { Route53Record } from "@cdktn/provider-aws/lib/route53-record";
import { SecurityGroup } from "@cdktn/provider-aws/lib/security-group";

import { formatName, formatTerraformId, securityGroupDescription } from "../common";

export interface ApplicationLoadBalancerConfig {
  readonly name: string;
  readonly vpcId: string;
  readonly subnetIds: string[];
  readonly certificateArn: string;
  readonly hostedZoneId: string;

  /** Fully qualified name the tracker posts webhooks to. */
  readonly recordName: string;

  /** Container port the target group forwards to. */
  readonly targetPort: number;

  /** Path the target group polls for health. Returns 200 "ok" in the listener. */
  readonly healthCheckPath: string;
  readonly globalTags: Record<string, string>;
}

/**
 * Public HTTPS front door for the listener service.
 *
 * Open to 0.0.0.0/0 on 443 by design: the tracker posts from its own
 * infrastructure and the request's authenticity is established in the
 * application by HMAC signature verification, not by source address. An IP
 * allowlist here would add a second thing to keep current, and would fail
 * closed and silently when the tracker's ranges change.
 */
export class ApplicationLoadBalancer extends Construct {
  public readonly targetGroupArn: string;
  public readonly securityGroupId: string;

  /**
   * Exposed so the service can depend on it explicitly. An ECS service refuses
   * to be created against a target group that is not yet attached to a load
   * balancer, and passing only the target group's arn gives Terraform no reason
   * to order the listener first.
   */
  public readonly httpsListener: LbListener;

  constructor(scope: Construct, id: string, config: ApplicationLoadBalancerConfig) {
    super(scope, id);

    const securityGroup = new SecurityGroup(this, "security-group", {
      name: formatName(`${config.name}-alb-sg`, 255),
      description: securityGroupDescription("Public HTTPS ingress for the webhook listener"),
      vpcId: config.vpcId,
      ingress: [
        {
          fromPort: 443,
          toPort: 443,
          protocol: "tcp",
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
          description: securityGroupDescription("HTTPS from anywhere; authenticity enforced by webhook signature, not by address"),
        },
        {
          fromPort: 80,
          toPort: 80,
          protocol: "tcp",
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
          description: securityGroupDescription("HTTP, redirected to HTTPS"),
        },
      ],
      egress: [
        {
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
          description: securityGroupDescription("To the service task"),
        },
      ],
      tags: config.globalTags,
    });

    const loadBalancer = new Lb(this, "alb", {
      name: formatTerraformId(`${config.name}-alb`),
      internal: false,
      loadBalancerType: "application",
      securityGroups: [securityGroup.id],
      subnets: config.subnetIds,
      tags: config.globalTags,
    });

    const targetGroup = new LbTargetGroup(this, "target-group", {
      name: formatTerraformId(`${config.name}-tg`),
      port: config.targetPort,
      protocol: "HTTP",

      // Fargate tasks in awsvpc mode register by IP, not instance id.
      targetType: "ip",
      vpcId: config.vpcId,

      // The listener answers and returns immediately — activation work continues
      // in the background, detached from any request — so there is nothing long
      // running to drain from a connection.
      deregistrationDelay: "30",
      healthCheck: {
        enabled: true,
        path: config.healthCheckPath,
        protocol: "HTTP",
        matcher: "200",
        interval: 30,
        timeout: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 3,
      },
      tags: config.globalTags,
    });

    this.httpsListener = new LbListener(this, "https-listener", {
      loadBalancerArn: loadBalancer.arn,
      port: 443,
      protocol: "HTTPS",
      sslPolicy: "ELBSecurityPolicy-TLS13-1-2-2021-06",
      certificateArn: config.certificateArn,
      defaultAction: [{ type: "forward", targetGroupArn: targetGroup.arn }],
      tags: config.globalTags,
    });

    // Not needed by the tracker, which posts to HTTPS. Here so that a human
    // pasting the hostname into a browser lands somewhere sensible.
    new LbListener(this, "http-redirect", {
      loadBalancerArn: loadBalancer.arn,
      port: 80,
      protocol: "HTTP",
      defaultAction: [
        {
          type: "redirect",
          redirect: { port: "443", protocol: "HTTPS", statusCode: "HTTP_301" },
        },
      ],
      tags: config.globalTags,
    });

    new Route53Record(this, "dns-record", {
      zoneId: config.hostedZoneId,
      name: config.recordName,
      type: "A",
      alias: {
        name: loadBalancer.dnsName,
        zoneId: loadBalancer.zoneId,
        evaluateTargetHealth: true,
      },
    });

    this.targetGroupArn = targetGroup.arn;
    this.securityGroupId = securityGroup.id;
  }
}
