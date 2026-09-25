/**
 * Entry point: reads the dispatch context, prepares the workspace, builds the
 * prompt, and runs one Agent SDK session to conclusion. This runner does not
 * itself decide complete/waiting/blocked — that's the specialist's own write,
 * through its Linear MCP tool calls, same as the shaping tier's activations
 * are Claude's own writes, not activation-runner.ts's. This function's job is
 * only to make sure the container doesn't hang and something is visible if it
 * crashes before Claude gets a turn (see tracker-fallback.ts).
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadClaudeConfig } from "./claude-config.js";
import { loadDispatchContext } from "./dispatch-context.js";
import { prepareWorkspace } from "./workspace.js";
import { buildSystemPrompt, buildUserMessage } from "./prompt.js";
import { mcpServersFromEnv } from "./mcp-servers.js";
import { postFallbackComment } from "./tracker-fallback.js";
import { createLogger } from "./logger.js";

const log = createLogger("specialist-runner");
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspace";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const LINEAR_AGENT_API_KEY = process.env.LINEAR_AGENT_API_KEY ?? "";

async function main(): Promise<void> {
  const context = loadDispatchContext();
  const claudeConfig = loadClaudeConfig();
  const runId = randomUUID();
  const runLog = log.child(`${context.storyId}:${runId.slice(0, 8)}`);
  runLog.info(`starting specialist run (surface(s): ${context.surfaces.join(", ")}) for ${context.storyId} — "${context.storyTitle}"`);

  const { frameworkPath, surfaceRepoPath } = await prepareWorkspace(
    join(WORKSPACE_ROOT, runId),
    context,
    GITHUB_TOKEN,
    runLog,
  );

  runLog.trace("building system prompt from agent file + skills");
  const { systemPrompt, skills } = await buildSystemPrompt(frameworkPath, surfaceRepoPath, context);
  runLog.info(`skills inlined: ${skills.map((s) => `${s.name} (${s.source})`).join(", ")}`);
  const userMessage = buildUserMessage(context);

  runLog.info(
    `invoking Agent SDK — model=${claudeConfig.model} effort=${claudeConfig.effort} maxTurns=${context.maxTurns} ` +
      `cwd=${surfaceRepoPath}`,
  );

  const stream = query({
    prompt: userMessage,
    options: {
      cwd: surfaceRepoPath,
      systemPrompt: systemPrompt,
      mcpServers: mcpServersFromEnv(),

      // Explicit, not left to the SDK's own default — an unset model/effort
      // would silently track whatever the CLI's default happens to be on a
      // given build. See claude-config.ts.
      model: claudeConfig.model,
      effort: claudeConfig.effort,

      // No WebFetch/WebSearch, no wider tool surface — keeps the sandbox's
      // blast radius to reading/writing/testing the one cloned repo.
      //
      // `Skill` is deliberately absent here: per the SDK's own types, the
      // `skills` option below "is the single place to turn skills on; you do
      // not need to add 'Skill' to allowedTools yourself when using this
      // option."
      allowedTools: ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],

      // Discretionary, surface-local skills: `cwd` is the cloned surface repo,
      // so a `.claude/skills/` the client's own team maintains there is
      // discovered and invocable — added with no framework change and no
      // registry edit on our side. Two tiers on purpose: the skills a surface
      // *must* follow are read eagerly and inlined into systemPrompt (see
      // prompt.ts), because discovery is discretionary — the model sees a name
      // and a description and decides, which fails silently when the
      // description doesn't trigger and leaves no trace in the hand-back.
      // Discovery is for "here is a helper if you need it," never for "this
      // surface's work must follow these practices."
      //
      // `settingSources` is left unset, which the SDK types define as loading
      // all sources (matching CLI defaults) — that is what makes the surface
      // repo's own `.claude/` and `CLAUDE.md` visible, and is wanted. Note it
      // also means a client repo's `.claude/settings.json` is an unreviewed
      // input to this run; if that becomes a concern, narrow it to
      // `["project"]` rather than dropping it entirely, since `project` is
      // what loads CLAUDE.md.
      skills: "all",

      // ...but not the skills Claude Code ships with. A code specialist has no
      // use for pdf/docx/xlsx authoring, and their listings are pure context
      // cost against a turn budget that is already a live failure mode —
      // three live runs each died on "Reached maximum number of turns".
      // Plugins and `.claude/skills/` are explicitly unaffected by this flag.
      managedSettings: { disableBundledSkills: true },

      // Unattended container, no human to approve tool calls one at a time —
      // allowDangerouslySkipPermissions is the required pairing for this mode
      // (confirmed in the SDK's own type definitions).
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,

      // The ledger is explicit that a session "does not time out on its own" —
      // this must be set deliberately, not left to a default.
      maxTurns: context.maxTurns,

    },
  });

  for await (const message of stream) {
    runLog.trace(`message: ${JSON.stringify(message).slice(0, 2000)}`);

    if (message.type === "result") {
      runLog.info(
        `run concluded: subtype=${message.subtype} is_error=${message.is_error} num_turns=${message.num_turns} ` +
          `total_cost_usd=${message.total_cost_usd} stop_reason=${message.stop_reason ?? "(none)"}`,
      );
    }
  }

  runLog.info("run complete — outcome is the specialist's own tracker write, not this runner's to narrate");
}

main().catch(async (err) => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  log.error(`run failed before completing: ${message}`);

  // Best-effort: STORY_ID may not even be readable if loadDispatchContext
  // itself threw. Only attempt the fallback comment when there's enough
  // context to know where to post it.
  const storyId = process.env.STORY_ID;
  if (storyId) {
    await postFallbackComment(storyId, LINEAR_AGENT_API_KEY, message);
  }

  process.exitCode = 1;
});
