import { describe, it, expect } from "vitest";
import { buildMcpServers } from "./mcp-servers.js";

describe("buildMcpServers", () => {
  it("builds an http config for linear and github, each with a bearer token", () => {
    const servers = buildMcpServers({
      linearMcpUrl: "https://mcp.linear.app/mcp",
      linearAgentApiKey: "linear-key",
      githubMcpUrl: "https://api.githubcopilot.com/mcp/",
      githubToken: "github-token",
    });

    expect(servers.linear).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer linear-key" },
    });
    expect(servers.github).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: { Authorization: "Bearer github-token" },
    });
  });
});
