/**
 * Generic activation runner. Every agent lane (Intake, Specification, Decompose,
 * and any lane registered after them) runs through this same function — what
 * varies is the AgentLaneConfig passed in, not the runner.
 *
 * With Claude holding direct MCP access to both the tracker (Linear) and, for
 * lanes with codebaseAccess, the product codebase (GitHub), there is no
 * verdict object and no applyAsk/applyCheckpoint/applyShaped, and no
 * client-side tool loop either — the app declares no tools of its own. Claude
 * reads the thread and the code, decides, and posts/labels/creates/moves via
 * its own MCP tool calls, all resolved server-side within one Anthropic call.
 * This function's only job is to assemble that one call, post the one
 * courtesy "working on it" comment right before opening it (see
 * tracker-notifier.ts — some runs take minutes before Claude's own first
 * tracker write), and catch the two failure modes the app itself must report.
 *
 * VERIFY before relying on this in production (unconfirmed against the current
 * @anthropic-ai/sdk MCP connector surface as of this rewrite):
 *   - The beta header name/value this SDK version expects for the MCP connector.
 *   - The exact shape of an mcp_tool_result error block (field name for the
 *     error flag) — assumed `is_error`, mirroring ToolResultBlockParam.
 *   - Linear's hosted MCP server URL and its auth mechanism — assumed a bearer
 *     token via `authorization_token`, using the same LINEAR_AGENT_API_KEY the
 *     rest of the app uses; Linear's remote MCP server may require OAuth
 *     instead of a personal API key.
 *   - GitHub's hosted MCP server URL and auth mechanism — assumed a bearer
 *     token via `authorization_token`, using a PAT (GITHUB_TOKEN) with
 *     Contents: Read; GitHub's remote server may require OAuth instead.
 *
 * Failure handling is fail-fast and narrow, per the design ledger's write-path
 * collapse: three cases post the error comment — (a) the Anthropic call
 * itself throws (timeout, 5xx, network failure, or a stream that dropped with
 * no error frame and no message — the last of these retried up to
 * maxStreamRetries times first, since nothing was produced or written on that
 * attempt and retrying it is safe), (b) an mcp_tool_result
 * error block appears in the final response — unless that same write, against
 * the same target, was retried later in the conversation and succeeded (see
 * findMcpError) — or (c) the run is still paused (stop_reason: "pause_turn")
 * after maxPauseContinuations resumes — the server's own MCP tool-call loop
 * hit its round-trip cap more times than we chase. (The activation-started
 * comment above is the one deliberate departure from that collapse — a
 * progress courtesy, not a failure report.)
 * Explicitly out of scope: a run that reads the tracker, decides not to act,
 * and posts nothing — there is no error to catch there, and the ledger
 * records that gap as accepted, not deferred.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { AgentLaneConfig } from "./agent-lane.js";
import type { AgentFn, Pass } from "./tracker-event.js";
import { buildSystemBlocks, renderActivationPrompt, type SystemBlock } from "./prompt-assembly.js";
import { activationConfig } from "./activation-config.js";
import trackerNotifier, { pickPatienceQuip } from "./tracker-notifier.js";
import { createLogger, type Logger } from "./logger.js";
import { envOr } from "./env.js";
import { readFile } from "node:fs/promises";

// The exact string @anthropic-ai/sdk's MessageStream throws when the SSE
// connection ends with no message_stop and no error frame — confirmed
// against the installed SDK's own MessageStream.ts, thrown with no `cause`,
// so a direct message match is reliable rather than needing describeError's
// formatting. Distinct from a timeout (which throws a different, aborted
// error) or an explicit API error (which sets stream.errored) — this is the
// "nothing was produced, nothing was written, safe to retry" case.
const STREAM_ENDED_WITHOUT_MESSAGE = "stream ended without producing a Message with role=assistant";

const LINEAR_MCP_URL = envOr("LINEAR_MCP_URL", "https://mcp.linear.app/mcp");
const LINEAR_AGENT_API_KEY = process.env.LINEAR_AGENT_API_KEY ?? "";
const GITHUB_MCP_URL = envOr("GITHUB_MCP_URL", "https://api.githubcopilot.com/mcp/");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const PRODUCT_CONTEXT_PATHS = (process.env.PRODUCT_CONTEXT_PATHS ?? "")
  .split(",")
  .map((p) => p.trim())
  .filter((p) => p.length > 0);

type McpServerConfig = { type: "url"; url: string; name: string; authorization_token: string };

const LINEAR_MCP_SERVER: McpServerConfig = {
  type: "url",
  url: LINEAR_MCP_URL,
  name: "linear",
  authorization_token: LINEAR_AGENT_API_KEY,
};

const GITHUB_MCP_SERVER: McpServerConfig = {
  type: "url",
  url: GITHUB_MCP_URL,
  name: "github",
  authorization_token: GITHUB_TOKEN,
};

// The tracker is attached on every activation; the product codebase only for
// lanes that read it. Which repo/org/ref to read is never the app's to know —
// the agent discovers and records the repo base per surface itself.
function mcpServersFor(lane: AgentLaneConfig): McpServerConfig[] {
  return lane.codebaseAccess ? [LINEAR_MCP_SERVER, GITHUB_MCP_SERVER] : [LINEAR_MCP_SERVER];
}

// System blocks (agent file + skills) are static per lane for the process
// lifetime — loaded once on first activation, not re-read from disk per run.
const systemBlockCache = new Map<string, Promise<SystemBlock[]>>();
function getSystemBlocks(lane: AgentLaneConfig): Promise<SystemBlock[]> {
  let cached = systemBlockCache.get(lane.name);
  if (!cached) {
    cached = buildSystemBlocks(lane.agentFile, lane.skills);
    systemBlockCache.set(lane.name, cached);
  }
  return cached;
}

// Reads and truncates each product context file. Unreadable files are skipped —
// product context is always optional. Loaded once; the file list is fixed for
// the process lifetime.
let productContextsPromise: Promise<string[]> | null = null;
function getProductContexts(): Promise<string[]> {
  if (!productContextsPromise) {
    productContextsPromise = Promise.all(
      PRODUCT_CONTEXT_PATHS.map(async (p) => {
        try {
          const raw = await readFile(p, "utf8");
          const limit = activationConfig.limits.productContextCharsPerFile;
          return raw.length > limit ? raw.slice(0, limit) + "\n…[truncated]" : raw;
        } catch {
          return null;
        }
      }),
    ).then((results) => results.filter((r): r is string => r !== null));
  }
  return productContextsPromise;
}

// Observed 2026-07-15: a run whose overall result was a full success (Claude
// recovered from two transient read timeouts — list_comments, get_document —
// tried other paths, and still completed its real write) still got reported
// as a failure, because an is_error block from either abandoned read was
// still sitting in the final content array. The ledger's own rationale for
// this check is narrower than "any error anywhere": "Claude attempted a
// tracker WRITE and failed, and its own final text can't be trusted to say
// so." A failed read Claude visibly worked around is not that — only a
// failed write is. Tool names observed in practice follow a verb prefix
// convention (get_/list_/search_ read, save_/create_/add_/remove_/update_/
// delete_ write); an unrecognized name is treated as a write, erring toward
// over-reporting rather than silently swallowing a real failure.
const MCP_WRITE_TOOL_PREFIXES = ["save_", "create_", "add_", "remove_", "update_", "delete_"];

export type ToolUseRecord = { name: string; input: Record<string, unknown> };

// Keys, in priority order, that observed MCP write tools use to name their
// target (save_comment's issueId, save_project's projectId, save_document's
// documentId, and a generic id/entityId elsewhere). Used only to confirm a
// later retry of the same tool actually targets the same entity as the one
// that failed — matching on tool name alone would risk swallowing an
// unrelated write's real failure just because some other write happened to
// share a tool name (e.g. Decompose creating several stories with repeated
// save_issue calls, one per story).
const TARGET_ID_KEYS = ["issueId", "projectId", "documentId", "id", "entityId"];

function sameTarget(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const key of TARGET_ID_KEYS) {
    if (key in a || key in b) return a[key] !== undefined && a[key] === b[key];
  }
  return false;
}

// True if any of the known target-id keys carries a real (non-empty) value.
// A failed call with none of them set — e.g. an empty string where a real id
// belongs — has no target for sameTarget to compare against in the first
// place, which is itself evidence the call was incomplete/corrupted rather
// than a deliberate write to some other specific entity.
function hasUsableTarget(input: Record<string, unknown>): boolean {
  return TARGET_ID_KEYS.some((key) => {
    const value = input[key];
    return value !== undefined && value !== "";
  });
}

// Observed 2026-07-17: a pause_turn boundary landed mid-argument-stream on a
// save_comment call, corrupting one field (body came back as a non-string,
// tripping the MCP server's own validation) — a real is_error result, but an
// artifact of where the pause fell, not of anything Claude decided. Claude
// noticed the failure on resume, retried the identical save_comment against
// the same issueId with corrected arguments, and that retry succeeded — yet
// the leftover error block from the corrupted first attempt was still enough
// to fail the run under the write-is-always-fatal rule above, producing a
// confusing "Pipeline error" comment on an activation that had, in fact,
// completed its intended write. A write failure is now tolerated in exactly
// this one shape: the same tool, targeting the same entity, retried later in
// the conversation with a result that succeeded — never on tool name alone,
// which would risk swallowing an unrelated write's real failure.
export function findMcpError(
  content: Anthropic.ContentBlock[],
  allToolUses?: Map<string, ToolUseRecord>,
): string | null {
  const blocks = content as unknown as {
    type: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    tool_use_id?: string;
    is_error?: boolean;
    content?: unknown;
  }[];

  // Tool uses visible in this same content array — a retry landing in the
  // same round as the failure it corrected (the common case) is found here.
  const localToolUses = new Map<string, ToolUseRecord>();
  for (const block of blocks) {
    if (block.type === "mcp_tool_use" && block.id && block.name) {
      localToolUses.set(block.id, { name: block.name, input: block.input ?? {} });
    }
  }
  // Falls back to the local map alone when the caller has no cross-round
  // history to offer (e.g. every existing unit test) — the failed call's own
  // tool_use block is then expected to be in this same array too.
  const toolUses = allToolUses ?? localToolUses;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || block.type !== "mcp_tool_result" || !block.is_error) continue;

    const failedUse = block.tool_use_id ? toolUses.get(block.tool_use_id) : undefined;
    const toolName = failedUse?.name;
    const isWrite = toolName ? MCP_WRITE_TOOL_PREFIXES.some((prefix) => toolName.startsWith(prefix)) : true;
    if (!isWrite) continue;

    if (toolName && failedUse) {
      // Observed 2026-07-29: a save_comment call came back as just
      // `{"issueId": ""}` — no body, no real target — and was rejected by
      // the MCP server's own schema validation. Claude retried immediately
      // with a complete, correctly-targeted call (`projectId`, not
      // `issueId`, since the target was a project) and that retry
      // succeeded — but sameTarget requires the same key with the same
      // value, and an empty issueId matches nothing, so the run was still
      // reported as failed on top of a comment that had, in fact, posted
      // fine. When the failed call has no usable target at all, there is
      // nothing for sameTarget to meaningfully compare — the absence of a
      // real target is itself the signal that this was a corrupted/
      // incomplete call, not a deliberate write to some other entity, so a
      // same-tool success afterward is accepted as recovery on tool name
      // alone. A failed call that DOES carry a real target still requires
      // sameTarget to match, same as always — this only loosens the check
      // for the shape where there was no target to begin with.
      const failedHasTarget = hasUsableTarget(failedUse.input);
      const recovered = blocks.slice(i + 1).some((later) => {
        if (later.type !== "mcp_tool_result" || later.is_error) return false;
        const retryUse = later.tool_use_id ? localToolUses.get(later.tool_use_id) : undefined;
        if (retryUse?.name !== toolName) return false;
        return failedHasTarget ? sameTarget(failedUse.input, retryUse.input) : true;
      });
      if (recovered) continue;
    }

    return JSON.stringify(block.content ?? block);
  }
  return null;
}

// Observed 2026-07-20: a single decompose run against one epic posted the exact
// same save_comment — same issueId, byte-identical body — twice, 219ms apart.
// Both calls succeeded (no is_error block on either), so findMcpError had
// nothing to flag; the only visible symptom was two duplicate comments on the
// issue, found by reading the thread directly. Root cause unconfirmed —
// possibly the same pause_turn-boundary fragility findMcpError's write-retry
// tolerance above already documents, this time duplicating a call instead of
// corrupting one. This check doesn't try to prevent or undo a duplicate
// write; it only makes one visible in the trace log instead of silently
// absorbed, the same way a duplicate is nothing to look past.
export function findDuplicateWrites(
  content: Anthropic.ContentBlock[],
  allToolUses: Map<string, ToolUseRecord>,
): ToolUseRecord[] {
  const blocks = content as unknown as { type: string; tool_use_id?: string; is_error?: boolean }[];
  const successfulWrites: ToolUseRecord[] = [];
  for (const block of blocks) {
    if (block.type !== "mcp_tool_result" || block.is_error) continue;
    const use = block.tool_use_id ? allToolUses.get(block.tool_use_id) : undefined;
    if (use && MCP_WRITE_TOOL_PREFIXES.some((prefix) => use.name.startsWith(prefix))) {
      successfulWrites.push(use);
    }
  }
  const duplicates: ToolUseRecord[] = [];
  successfulWrites.forEach((a, i) => {
    for (const b of successfulWrites.slice(i + 1)) {
      if (a.name === b.name && sameTarget(a.input, b.input) && JSON.stringify(a.input) === JSON.stringify(b.input)) {
        duplicates.push(b);
      }
    }
  });
  return duplicates;
}

// The failed call whose corrupted-then-retried shape findMcpError tolerates
// (see above) is often split across a pause_turn boundary: the original,
// erroring tool_use lives in an earlier round already pushed into `messages`,
// while its retry lives in the final round's own content. Scans every
// assistant turn seen so far, plus the final response, into one id-keyed map
// so the failed call's target can be recovered regardless of which round it
// was in.
function collectToolUses(
  messages: Anthropic.MessageParam[],
  finalContent: Anthropic.ContentBlock[],
): Map<string, ToolUseRecord> {
  const byId = new Map<string, ToolUseRecord>();
  const record = (block: unknown) => {
    const b = block as { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
    if (b?.type === "mcp_tool_use" && b.id && b.name) {
      byId.set(b.id, { name: b.name, input: b.input ?? {} });
    }
  };
  for (const msg of messages) {
    if (msg.role !== "assistant" || typeof msg.content === "string") continue;
    for (const block of msg.content) record(block);
  }
  for (const block of finalContent) record(block);
  return byId;
}

// err.message alone drops the useful part of errors like undici's "terminated"
// (a raw connection drop) — the real reason is usually in .cause, sometimes
// nested a few levels (socket error → connection reset → OS errno). Walks the
// whole chain into one line rather than the top-level message only.
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [`${err.name}: ${err.message}`];
  let cause = (err as Error & { cause?: unknown }).cause;
  while (cause !== undefined && cause !== null) {
    if (cause instanceof Error) {
      parts.push(`${cause.name}: ${cause.message}`);
      cause = (cause as Error & { cause?: unknown }).cause;
    } else {
      parts.push(JSON.stringify(cause));
      break;
    }
  }
  return parts.join(" — caused by ");
}

async function postErrorComment(
  log: Logger,
  lane: AgentLaneConfig,
  entityId: string,
  traceId: string,
  message: string,
): Promise<void> {
  await trackerNotifier.postErrorComment(entityId, lane.entityType, traceId, message);
  log.error(`error on entity ${entityId}: ${message}`);
}

/**
 * Runs one activation to conclusion: assembles the prompt, makes the one
 * Anthropic call with the tracker (and, for codebaseAccess lanes, GitHub) MCP
 * servers attached, and reports the one fail-fast error comment on either
 * enumerated failure mode. Returns nothing — every other outcome is Claude's
 * own tracker write, not this function's to narrate.
 */
export function createActivationRunner(lane: AgentLaneConfig): AgentFn {
  const log = createLogger(lane.name);

  return async function run(
    entityId: string,
    pass: Pass,
    entityTitle: string | null,
    traceId: string,
    _actor,
  ): Promise<void> {
    const reqLog = log.child(traceId);
    reqLog.info(`run — entity=${entityId} pass=${pass}`);

    // Constructing the client needs nothing computed inside the try, and
    // living out here lets `stream`'s type derive from it without importing
    // MessageStream from the SDK's internal (non-re-exported) module path.
    const client = new Anthropic({ timeout: activationConfig.requestTimeoutMs });

    // Declared outside the try so the catch block can still report on it —
    // request_id and receivedMessages are exactly what's needed to diagnose
    // a mid-stream drop (e.g. "terminated"), and are only available on the
    // stream object itself, not on whatever error it throws.
    let stream: ReturnType<typeof client.messages.stream> | undefined;

    // Cleared in the finally below on every exit path — success, MCP error,
    // or a thrown exception — so a finished or failed run never keeps ticking.
    let progressTimer: ReturnType<typeof setInterval> | undefined;

    // request_id/errored/aborted/receivedMessages are only available on the
    // stream object itself, not on whatever error it throws — this is the
    // only way to tell, on a mid-stream failure, how far the run got (did it
    // even connect? did content start arriving?) versus dying with nothing.
    // warn, not trace: a run that failed needs this visible without having
    // pre-set LOG_LEVEL=trace before the failure happened — observed
    // 2026-08-13, where the only way to see this was to
    // deliberately re-trigger the same failure a second time with trace
    // logging already turned on.
    function logStreamDiagnostics(message: string): void {
      if (!stream) return;
      reqLog.warn(
        `${message} — request_id=${stream.request_id ?? "(none)"} errored=${stream.errored} ` +
          `aborted=${stream.aborted} receivedMessages=${stream.receivedMessages.length}`,
      );
      if (stream.receivedMessages.length > 0) {
        reqLog.trace(`last received message: ${JSON.stringify(stream.receivedMessages.at(-1))}`);
      }
    }

    try {
      reqLog.trace(`loading system blocks (agent file + ${lane.skills.length} skill(s)) and product context`);
      const [systemBlocks, productContexts] = await Promise.all([getSystemBlocks(lane), getProductContexts()]);
      reqLog.trace(`loaded ${systemBlocks.length} system block(s), ${productContexts.length} product context file(s)`);

      const templateFile = pass === "first" ? lane.templates.first : lane.templates.followUp;
      reqLog.trace(`selected template "${templateFile}" for pass "${pass}"`);
      const placeholders = lane.buildPlaceholders(pass, entityId, entityTitle);
      reqLog.trace(`built placeholders: ${JSON.stringify(placeholders)}`);
      const userMessageParts = [await renderActivationPrompt(templateFile, placeholders)];
      for (const ctx of productContexts) {
        userMessageParts.push(`\nProduct context:\n${ctx}`);
      }
      const userMessage = userMessageParts.join("\n");
      reqLog.trace(`assembled user message, ${userMessage.length} chars`);

      const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];
      const mcpServers = mcpServersFor(lane);
      reqLog.trace(`attaching MCP server(s): [${mcpServers.map((s) => s.name).join(", ")}]`);

      const { input_tokens } = await client.messages.countTokens({
        model: lane.model,
        system: systemBlocks,
        messages: messages,
      } as unknown as Anthropic.MessageCountTokensParams);

      log.debug(`entity ${entityId}: ${input_tokens} input tokens`);
      if (input_tokens > activationConfig.maxInputTokens) {
        throw new Error(
          `context too large for entity ${entityId}: ${input_tokens} tokens exceeds limit of ${activationConfig.maxInputTokens}`,
        );
      }

      const params = {
        model: lane.model,
        max_tokens: activationConfig.maxOutputTokens,
        thinking: { type: "adaptive" },
        output_config: { effort: activationConfig.effort },
        system: systemBlocks,
        mcp_servers: mcpServers,
        messages: messages,
      } as unknown as Anthropic.MessageStreamParams;

      // Posted before opening the stream, not after Claude's first move —
      // some runs take minutes before Claude makes its own first tracker
      // write, and a human watching the tracker should see something
      // immediately rather than silence until then. Never blocks the run:
      // the notifier swallows its own failures. One quip per activation,
      // reused across every progress update on this run rather than
      // reshuffled underneath the reader each tick.
      const timeoutMinutes = Math.round(activationConfig.requestTimeoutMs / 60_000);
      const quip = pickPatienceQuip();
      const progressCommentId = await trackerNotifier.postActivationStarted(
        entityId,
        lane.entityType,
        traceId,
        lane.name,
        timeoutMinutes,
        quip,
      );

      // Keeps that same comment current for however long the run actually
      // takes, rather than posting a new one each tick. No-ops if the post
      // above failed (nothing to update) — never blocks or fails the run.
      // callStartedAt/attempt are reset inside callOnce() itself, not here —
      // each pause_turn resume opens a brand new HTTP request against
      // requestTimeoutMs, so the elapsed/remaining math this timer reports
      // must track the current attempt's own clock, not the very first
      // call's. Observed 2026-07-20: before this, the comment kept showing
      // "~0m left before timeout" for over an hour into a multi-continuation
      // run, because the displayed countdown never reset even though the
      // underlying per-request timeout did.
      let callStartedAt = Date.now();
      let attempt = 0;
      if (progressCommentId) {
        progressTimer = setInterval(() => {
          void trackerNotifier.updateActivationProgress(
            progressCommentId,
            traceId,
            lane.name,
            Date.now() - callStartedAt,
            timeoutMinutes,
            quip,
            attempt,
          );
        }, activationConfig.progressUpdateIntervalMs);
      }

      // Non-streaming .create() is refused by the SDK once max_tokens/thinking
      // make a run long enough to plausibly exceed 10 minutes — exactly the
      // case here. .stream().finalMessage() satisfies that requirement and
      // still hands back the same assembled Message once the run concludes;
      // nothing downstream (error scanning, content-block inspection) needs
      // to know the transport was streaming.
      async function callOnce(): Promise<Anthropic.Message> {
        for (let streamAttempt = 0; ; streamAttempt++) {
          attempt++;
          callStartedAt = Date.now();
          reqLog.trace(`calling Anthropic messages.stream, model=${lane.model} (attempt ${attempt})`);
          stream = client.messages.stream(params, { headers: { "anthropic-beta": "mcp-client-2025-04-04" } });

          // Raw visibility into what Anthropic actually sent, event by event —
          // the only way to tell, on a mid-stream failure, how far the run got
          // (did it even connect? did content start arriving?) versus dying
          // with nothing. Trace-only: at full verbosity, not the default.
          stream.on("connect", () => reqLog.trace(`stream connected, request_id=${stream?.request_id ?? "(none)"}`));
          stream.on("streamEvent", (event: Anthropic.MessageStreamEvent) => {
            reqLog.trace(`stream event: ${JSON.stringify(event).slice(0, 500)}`);
          });

          try {
            return await stream.finalMessage();
          } catch (err) {
            const isStreamDrop = err instanceof Error && err.message === STREAM_ENDED_WITHOUT_MESSAGE;
            if (!isStreamDrop || streamAttempt >= activationConfig.maxStreamRetries) throw err;
            logStreamDiagnostics(
              `stream dropped with no error/abort/message — retrying (${streamAttempt + 1}/${activationConfig.maxStreamRetries})`,
            );
          }
        }
      }

      let response = await callOnce();
      reqLog.trace(
        `response received: stop_reason=${response.stop_reason} content block types=[${response.content.map((b) => b.type).join(", ")}]`,
      );

      // The Anthropic API resolves MCP tool calls in its own server-side loop,
      // which has an internal round-trip cap; a task needing more calls than
      // that returns stop_reason: "pause_turn" instead of finishing. Resuming
      // means re-sending the conversation with the paused assistant turn
      // appended — no new user message — and the server picks up where it
      // left off. Observed 2026-07-16: a large Intake run doing many
      // existing-issue lookups paused mid-loop with a transient read timeout
      // sitting in that round's content; treating the pause as terminal
      // misreported an in-progress run as failed before Claude ever got the
      // chance to retry or recover — the same false-positive class the
      // write-vs-read check below already exists to avoid, just crossing a
      // pause/resume boundary this runner didn't used to know about.
      let continuations = 0;
      while (response.stop_reason === "pause_turn" && continuations < activationConfig.maxPauseContinuations) {
        continuations++;
        reqLog.trace(
          `stop_reason=pause_turn — resuming (continuation ${continuations}/${activationConfig.maxPauseContinuations})`,
        );
        messages.push({ role: "assistant", content: response.content });
        response = await callOnce();
        reqLog.trace(
          `response received: stop_reason=${response.stop_reason} content block types=[${response.content.map((b) => b.type).join(", ")}]`,
        );
      }

      if (response.stop_reason === "pause_turn") {
        reqLog.trace(`still paused after ${continuations} continuation(s) — reporting incomplete`);
        await postErrorComment(
          reqLog,
          lane,
          entityId,
          traceId,
          `run did not complete within ${activationConfig.maxPauseContinuations} continuation(s) of the server's MCP tool-call loop (still pause_turn)`,
        );
        return;
      }

      const allToolUses = collectToolUses(messages, response.content);
      const mcpError = findMcpError(response.content, allToolUses);
      if (mcpError) {
        reqLog.trace("mcp_tool_result error block found");
        await postErrorComment(reqLog, lane, entityId, traceId, `MCP tool call failed: ${mcpError}`);
        return;
      }
      reqLog.trace("no mcp_tool_result error block found");

      const duplicateWrites = findDuplicateWrites(response.content, allToolUses);
      if (duplicateWrites.length > 0) {
        reqLog.warn(
          `entity ${entityId}: ${duplicateWrites.length} duplicate successful write(s) detected — ` +
            duplicateWrites.map((d) => `${d.name}(${JSON.stringify(d.input)})`).join("; "),
        );
      }

      // No client-side tools were declared, so a tool_use block here means the
      // model tried to call something outside its attached MCP servers —
      // unexpected, and worth surfacing rather than silently dropping.
      const unexpectedToolUse = response.content.find((b) => b.type === "tool_use");
      if (unexpectedToolUse) {
        reqLog.trace("unexpected client-side tool_use block found");
        await postErrorComment(
          reqLog,
          lane,
          entityId,
          traceId,
          `model attempted a client-side tool call, but this lane declares none: ${JSON.stringify(unexpectedToolUse)}`,
        );
        return;
      }
      reqLog.trace("no unexpected tool_use block found — run concluded cleanly");

      // The activation-started comment is a courtesy for a run in progress —
      // once it's done, Claude's own comments narrate the outcome and a
      // lingering "still going" line just reads as stuck. Only reached on
      // this clean-success path; every failure return above leaves the
      // comment in place as a trace of how long the run ran before the
      // error comment posted.
      if (progressCommentId) {
        if (progressTimer) clearInterval(progressTimer);
        await trackerNotifier.deleteComment(progressCommentId, traceId);
      }
    } catch (err) {
      const message = describeError(err);
      logStreamDiagnostics("stream diagnostics");
      reqLog.trace(`run threw before completing: ${message}`);
      await postErrorComment(reqLog, lane, entityId, traceId, message);
    } finally {
      if (progressTimer) clearInterval(progressTimer);
    }
  };
}
