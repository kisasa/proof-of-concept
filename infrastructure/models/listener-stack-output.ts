/**
 * What the listener stack publishes. Nothing consumes these today — they exist
 * so that `cdktn output listener` answers the two questions asked most often
 * after a deploy: where do I point the tracker's webhook, and where are the logs.
 *
 * A type alias rather than an interface, for the reason given in
 * network-stack-output.ts.
 */
export type ListenerStackOutput = {
  readonly webhookUrl: string;
  readonly serviceName: string;
  readonly logGroupName: string;
  readonly imageUri: string;
};
