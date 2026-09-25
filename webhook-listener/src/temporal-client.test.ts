import { describe, it, expect, vi } from "vitest";

const connectMock = vi.fn();
const clientCtorMock = vi.fn();

vi.mock("@temporalio/client", () => ({
  Connection: { connect: (...args: unknown[]) => connectMock(...args) },
  Client: class {
    constructor(...args: unknown[]) {
      clientCtorMock(...args);
    }
  },
}));

const { createTemporalClient } = await import("./temporal-client.js");

describe("createTemporalClient", () => {
  it("connects with TLS and the given API key, then constructs a Client scoped to the namespace", async () => {
    const fakeConnection = { kind: "fake-connection" };
    connectMock.mockResolvedValue(fakeConnection);

    await createTemporalClient({
      temporalHost: "example.tmprl.cloud:7233",
      temporalNamespace: "example-dispatch.abc12",
      temporalTaskQueue: "dispatch-task-queue",
      temporalApiKey: "test-api-key",
      temporalTls: true,
    });

    expect(connectMock).toHaveBeenCalledWith({
      address: "example.tmprl.cloud:7233",
      tls: true,
      apiKey: "test-api-key",
    });
    expect(clientCtorMock).toHaveBeenCalledWith({ connection: fakeConnection, namespace: "example-dispatch.abc12" });
  });

  it("connects without TLS and without an API key against a local dev server", async () => {
    connectMock.mockResolvedValue({ kind: "fake-connection" });

    await createTemporalClient({
      temporalHost: "localhost:7233",
      temporalNamespace: "default",
      temporalTaskQueue: "dispatch-task-queue",
      temporalApiKey: undefined,
      temporalTls: false,
    });

    expect(connectMock).toHaveBeenCalledWith({
      address: "localhost:7233",
      tls: false,
      apiKey: undefined,
    });
  });
});
