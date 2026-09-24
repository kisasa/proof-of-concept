/**
 * Hands the next step back to a developer instead of leaving a story
 * sitting in "In Progress" once dispatch has stopped without completing it —
 * confirmed live (2026-08-07): a story's board state stayed "In Progress"
 * after its specialist reported "Waiting" on its blocker, even though the
 * workflow itself had already finished. CLAUDE.md's own dispatch primitive
 * is "status (a gate — human-moved)... In-Process is the human dispatch
 * act" — a story with nothing running shouldn't visually claim otherwise,
 * and the next move (retry, or not) is the developer's to make, not a
 * workflow's to wait on.
 *
 * "Todo" is this team's actual configured name for the tracker's To-Do
 * status (confirmed live against the tracker's own state list, 2026-08-07) —
 * the same engagement-specific-literal category as specialist-dispatch.ts's
 * own "In Progress", not CLAUDE.md's hyphenated "To-Do" framework
 * vocabulary. Best-effort, like the other courtesy activities
 * (postDispatchFailed, specialist-progress.ts): a missing/renamed status or
 * a Linear error here must never fail the dispatch outcome it's just trying
 * to reflect on the board.
 */

import { log } from "@temporalio/activity";
import { getIssue, findStateIdByName, updateIssueState, linearApiUrl } from "../tracker.js";
import type { WorkerConfig } from "../worker-config.js";

const TODO_STATUS_NAME = "Todo";

export function createMoveStoryToTodoActivity(config: WorkerConfig) {
  return async function moveStoryToTodo(storyId: string): Promise<void> {
    try {
      const baseUrl = linearApiUrl();
      const story = await getIssue(storyId, config.linearAgentApiKey, baseUrl);
      const stateId = await findStateIdByName(story.teamId, TODO_STATUS_NAME, config.linearAgentApiKey, baseUrl);
      if (!stateId) {
        log.warn(`No "${TODO_STATUS_NAME}" status found for this story's team — leaving its status unchanged`, { storyId });
        return;
      }
      await updateIssueState(storyId, stateId, config.linearAgentApiKey, baseUrl);
    } catch (err) {
      log.warn(`Failed to move story back to ${TODO_STATUS_NAME}: ${err instanceof Error ? err.message : String(err)}`, { storyId });
    }
  };
}
