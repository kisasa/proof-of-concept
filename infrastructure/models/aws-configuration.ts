import { type ContextNode, requireString } from "./context";

export interface AwsConfiguration {
  readonly region: string;
  readonly accountNumber: string;
  readonly profile: string;
}

export function awsConfigurationFromContext(node: ContextNode): AwsConfiguration {
  return {
    region: requireString(node, "region", "aws"),
    accountNumber: requireString(node, "account-number", "aws"),
    profile: requireString(node, "profile", "aws"),
  };
}
