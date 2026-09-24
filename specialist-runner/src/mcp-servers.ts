/**
 * The two MCP servers every specialist run attaches: the issue tracker
 * (Linear) and source control (GitHub) — same two named in
 * `agents/specialist-backend.md`/`-frontend.md`'s "How you hand back"
 * section. Mirrors `webhook-listener/src/activation-runner.ts`'s own
 * URL/token conventions (same env var names, same defaults), adapted to the
 * Agent SDK's `McpHttpServerConfig` shape instead of the raw Messages API's
 * `mcp_servers` connector param.
 *
 * VERIFY before relying on this in production (unconfirmed, same category as
 * activation-runner.ts's own flagged assumptions):
 *   - Whether these two hosted MCP servers actually accept `Authorization:
 *     Bearer <token>` over HTTP, versus requiring OAuth or a different header.
 *   - Linear's and GitHub's exact tool surface for what a specialist needs
 *     (open a pull request, in GitHub's case) — assumed present on their
 *     general-purpose hosted MCP servers, not confirmed against a live run.
 */

import type { McpHttpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { envOr } from "./env.js";

export interface McpCredentials {
  readonly linearMcpUrl: string;
  readonly linearAgentApiKey: string;
  readonly githubMcpUrl: string;
  readonly githubToken: string;
}

export function buildMcpServers(credentials: McpCredentials): Record<string, McpHttpServerConfig> {
  return {
    linear: {
      type: "http",
      url: credentials.linearMcpUrl,
      headers: { Authorization: `Bearer ${credentials.linearAgentApiKey}` },
    },
    github: {
      type: "http",
      url: credentials.githubMcpUrl,
      headers: { Authorization: `Bearer ${credentials.githubToken}` },
    },
  };
}

const LINEAR_MCP_URL = envOr("LINEAR_MCP_URL", "https://mcp.linear.app/mcp");
const LINEAR_AGENT_API_KEY = process.env.LINEAR_AGENT_API_KEY ?? "";
const GITHUB_MCP_URL = envOr("GITHUB_MCP_URL", "https://api.githubcopilot.com/mcp/");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";

export function mcpServersFromEnv(): Record<string, McpHttpServerConfig> {
  return buildMcpServers({
    linearMcpUrl: LINEAR_MCP_URL,
    linearAgentApiKey: LINEAR_AGENT_API_KEY,
    githubMcpUrl: GITHUB_MCP_URL,
    githubToken: GITHUB_TOKEN,
  });
}
