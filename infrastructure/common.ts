/**
 * Naming and state-key helpers shared by every stack.
 *
 * AWS caps many resource names well below what a descriptive identifier wants
 * to be — load balancers and target groups at 32 characters — and rejects
 * uppercase, spaces, and leading/trailing hyphens in most of them. Truncating
 * in one place keeps those limits from being rediscovered one failed apply at
 * a time.
 */

export function formatName(name: string, maxLength = 100): string {
  const normalized = name.toLowerCase().replace(/ /g, "-");
  const truncated = normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;

  // Truncation can leave a trailing hyphen, which ALB and target-group names
  // reject outright.
  return truncated.replace(/^-+/, "").replace(/-+$/, "");
}

/**
 * For Terraform logical ids and the AWS names with the tightest caps (load
 * balancer, target group). The 32-character default is the ALB limit, which is
 * why `environment-name` is documented as needing to stay short.
 */
export function formatTerraformId(name: string, maxLength = 32): string {
  return formatName(name, maxLength);
}

/**
 * Security group descriptions accept a narrow ASCII subset — notably no em dash
 * and no apostrophe, both of which are easy to type into a comment-like string.
 * AWS rejects a violation at apply time, several minutes in; this turns that into
 * a synth-time failure naming the offending text.
 *
 * Source: the EC2 API's own constraint on the field.
 */
const SECURITY_GROUP_DESCRIPTION_PATTERN = /^[0-9A-Za-z_ .:\/()#,@[\]+=&;{}!$*-]*$/;

export function securityGroupDescription(description: string): string {
  if (description.length > 255) {
    throw new Error(`Security group description exceeds 255 characters: ${description}`);
  }

  if (!SECURITY_GROUP_DESCRIPTION_PATTERN.test(description)) {
    const offending = [...description].filter((character) => !SECURITY_GROUP_DESCRIPTION_PATTERN.test(character));
    throw new Error(
      `Security group description contains characters AWS rejects (${offending.join(" ")}): ${description}`,
    );
  }

  return description;
}

/**
 * One state file per stack, keyed inside the shared state bucket. Named
 * constants rather than inline strings because a typo here silently points a
 * stack at an empty state and plans a full re-create.
 */
export interface TfStateKeys {
  readonly network: string;
  readonly listener: string;
  readonly specialistSandbox: string;
  readonly temporalWorkers: string;
}

export const tfStateKeys: TfStateKeys = {
  network: "network.tfstate",
  listener: "listener.tfstate",
  specialistSandbox: "specialist-sandbox.tfstate",
  temporalWorkers: "temporal-workers.tfstate",
};
