import { DataTerraformRemoteStateS3, S3Backend, TerraformOutput, TerraformStack } from "cdktn";
import { AwsProvider } from "@cdktn/provider-aws/lib/provider";
import type { Construct } from "constructs";

import { formatTerraformId } from "../common";
import { type AwsConfiguration, awsConfigurationFromContext } from "../models/aws-configuration";
import { type ListenerConfiguration, listenerConfigurationFromContext } from "../models/listener-configuration";
import {
  type SpecialistSandboxConfiguration,
  specialistSandboxConfigurationFromContext,
} from "../models/specialist-sandbox-configuration";
import { type TemporalConfiguration, temporalConfigurationFromContext } from "../models/temporal-configuration";
import { type ContextNode, requireNode, requireString, requireStringMap } from "../models/context";

/**
 * Base class for every stack: reads context, wires the AWS provider, and points
 * the stack at its own key in the shared S3 state bucket.
 *
 * Unlike the reference project's base stack, this one declares no sensitive
 * TerraformVariables. Secrets are SSM parameters created out-of-band and
 * injected by the ECS agent at task start, so there is nothing sensitive for
 * synth to hold.
 */
export abstract class BaseStack extends TerraformStack {
  private static readonly contextKeys: string[] = [
    "aws",
    "listener",
    "specialist-sandbox",
    "temporal",
    "global-tags",
    "domain-name",
    "hosted-zone-id",
    "vpc-cidr-block",
    "state-bucket-name",
    "parameter-prefix",
    "resource-name-prefix",
  ];

  protected readonly aws: AwsConfiguration;
  protected readonly listener: ListenerConfiguration;
  protected readonly specialistSandbox: SpecialistSandboxConfiguration;
  protected readonly temporal: TemporalConfiguration;
  protected readonly globalTags: Record<string, string>;
  protected readonly domainName: string;
  protected readonly hostedZoneId: string;
  protected readonly vpcCidrBlock: string;

  /** Prefix under which every stack's SSM secrets live — one shared value, not one per stack. */
  protected readonly parameterPrefix: string;

  /**
   * Leading segment of every deployment-scoped resource name (ECS clusters and
   * everything the constructs derive from them). Context rather than a literal
   * because it names one deployment, and deployment identity does not belong in
   * a repository anyone can clone — see CLAUDE.md, "No Private References".
   * Changing its value renames resources, which for a cluster means replacing
   * it, so it is set once per deployment and left alone.
   */
  protected readonly resourceNamePrefix: string;

  private readonly stateBucketName: string;

  protected constructor(scope: Construct, tfStateKey: string, id: string) {
    super(scope, id);

    const context = this.rootContext();

    this.aws = awsConfigurationFromContext(requireNode(context, "aws", "context"));
    this.listener = listenerConfigurationFromContext(requireNode(context, "listener", "context"));
    this.specialistSandbox = specialistSandboxConfigurationFromContext(
      requireNode(context, "specialist-sandbox", "context"),
    );
    this.temporal = temporalConfigurationFromContext(requireNode(context, "temporal", "context"));
    this.globalTags = requireStringMap(context, "global-tags", "context");
    this.domainName = requireString(context, "domain-name", "context");
    this.hostedZoneId = requireString(context, "hosted-zone-id", "context");
    this.vpcCidrBlock = requireString(context, "vpc-cidr-block", "context");
    this.stateBucketName = requireString(context, "state-bucket-name", "context");
    this.parameterPrefix = requireString(context, "parameter-prefix", "context");
    this.resourceNamePrefix = requireString(context, "resource-name-prefix", "context");

    new AwsProvider(this, "aws", {
      region: this.aws.region,
      profile: this.aws.profile,

      // Refuses to plan against the wrong account if a profile is mis-set —
      // cheap protection given the account number is already in context.
      allowedAccountIds: [this.aws.accountNumber],
    });

    new S3Backend(this, {
      bucket: this.stateBucketName,
      key: tfStateKey,
      region: this.aws.region,
      profile: this.aws.profile,
      encrypt: true,

      // S3-native state locking, which is why the prerequisites list no DynamoDB
      // lock table. Requires Terraform or OpenTofu >= 1.10 — declared as
      // `targetVersions` in cdktf.json, which synth validates against.
      useLockfile: true,
    });
  }

  /**
   * Every key this project uses sits at the root of cdktf.json's `context`
   * block. Collected once into a plain object so the model factories can
   * validate it as data, rather than each field reaching into the construct
   * tree on its own.
   */
  private rootContext(): ContextNode {
    const context: ContextNode = {};

    for (const key of BaseStack.contextKeys) {
      const value = this.node.tryGetContext(key);
      if (value !== undefined) context[key] = value;
    }

    return context;
  }

  /**
   * Publishes one Terraform output per key of `outputs`. The type parameter is
   * compile-time only — it is what keeps a stack's declared output interface and
   * its actual outputs the same thing — while the loop itself is untyped,
   * standing in for the reference project's reflection over record properties.
   */
  protected renderOutputs<T extends Record<string, string | string[] | number>>(outputs: T): void {
    for (const [name, value] of Object.entries(outputs)) {
      new TerraformOutput(this, name, {
        value: value,

        // No output of either stack is currently a secret. The check is here so
        // that adding one later fails safe rather than printing it to a console.
        sensitive: /password|secret|token|apikey/i.test(name),
      });
    }
  }

  protected remoteState(tfStateKey: string): DataTerraformRemoteStateS3 {
    return new DataTerraformRemoteStateS3(this, formatTerraformId(`remote_state_${tfStateKey}`), {
      bucket: this.stateBucketName,
      key: tfStateKey,
      region: this.aws.region,
      profile: this.aws.profile,
    });
  }
}
