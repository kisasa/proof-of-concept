/**
 * Entry point: connects to Temporal Cloud, registers the dispatch workflow
 * and its activities (each activity's real config-bound implementation is
 * built here — the only module that imports both the workflow's type-only
 * interface and the activities' real, non-deterministic implementations),
 * and runs until the process is stopped.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { createAwaitPullRequestOutcomeActivity } from "./activities/await-pull-request-outcome.js";
import { createAwaitSpecialistTaskActivity } from "./activities/await-specialist-task.js";
import { createCheckDependenciesActivity } from "./activities/check-dependencies.js";
import { createStoryBranch } from "./activities/create-story-branch.js";
import { createDispatchSpecialistActivity } from "./activities/dispatch-specialist.js";
import { createFindPullRequestActivity } from "./activities/find-pull-request.js";
import { createMoveStoryToTodoActivity } from "./activities/move-story-to-todo.js";
import { createPostDispatchFailedActivity } from "./activities/post-dispatch-failed.js";
import { createEditPullRequestNoticeActivity, createPostPullRequestNoticeActivity } from "./activities/pull-request-notice.js";
import { createRequestPullRequestReviewerActivity } from "./activities/request-pull-request-reviewer.js";
import { createResolveSurfacesActivity } from "./activities/resolve-surfaces.js";
import { createPostSpecialistStartedActivity, createDeleteSpecialistProgressActivity } from "./activities/specialist-progress.js";
import { createLogger } from "./logger.js";
import { loadLocalEnvFile } from "./local-env-file.js";
import { connectToTemporal } from "./temporal-connection.js";
import { loadWorkerConfig } from "./worker-config.js";

const log = createLogger("dispatch-worker");

const WORKFLOWS_PATH = fileURLToPath(new URL("./workflows/dispatch-story-workflow.ts", import.meta.url));
const WORKFLOW_BUNDLE_PATH = fileURLToPath(new URL("../dist/workflow-bundle.js", import.meta.url));

/**
 * `workflowsPath` bundles at Worker startup (webpack, every time the process
 * boots) — fine for local development, the wrong choice for production per
 * the Temporal TypeScript SDK's own guidance. `scripts/build-workflow-
 * bundle.mjs` pre-builds `dist/workflow-bundle.js` (the Dockerfile runs it at
 * image build time); this prefers that bundle when present and falls back to
 * `workflowsPath` only when running straight from source without a build
 * step (e.g. `npm run test:unit` never touches this at all — the workflow
 * itself is only imported by `worker.ts`).
 */
function workflowSource(): { workflowBundle: { codePath: string } } | { workflowsPath: string } {
  if (existsSync(WORKFLOW_BUNDLE_PATH)) {
    return { workflowBundle: { codePath: WORKFLOW_BUNDLE_PATH } };
  }
  return { workflowsPath: WORKFLOWS_PATH };
}

async function main(): Promise<void> {
  await loadLocalEnvFile();
  const config = loadWorkerConfig();

  log.info(`connecting to Temporal at ${config.temporalHost}, namespace=${config.temporalNamespace}`);
  const connection = await connectToTemporal(config);

  const source = workflowSource();
  log.info("workflowBundle" in source ? `using pre-built workflow bundle at ${WORKFLOW_BUNDLE_PATH}` : "no pre-built bundle found — bundling workflowsPath at startup (fine for dev, not for production)");

  const worker = await Worker.create({
    connection: connection,
    namespace: config.temporalNamespace,
    taskQueue: config.temporalTaskQueue,
    ...source,
    activities: {
      checkDependencies: createCheckDependenciesActivity(config),
      resolveSurfaces: createResolveSurfacesActivity(config),
      createStoryBranch: (input: Parameters<typeof createStoryBranch>[1]) => createStoryBranch(config.githubToken, input),
      dispatchSpecialist: createDispatchSpecialistActivity(config),
      postSpecialistStarted: createPostSpecialistStartedActivity(config),
      awaitSpecialistTask: createAwaitSpecialistTaskActivity(config),
      deleteSpecialistProgressComment: createDeleteSpecialistProgressActivity(config),
      findPullRequest: createFindPullRequestActivity(config),
      requestPullRequestReviewer: createRequestPullRequestReviewerActivity(config),
      postPullRequestNotice: createPostPullRequestNoticeActivity(config),
      editPullRequestNotice: createEditPullRequestNoticeActivity(config),
      awaitPullRequestOutcome: createAwaitPullRequestOutcomeActivity(config),
      postDispatchFailed: createPostDispatchFailedActivity(config),
      moveStoryToTodo: createMoveStoryToTodoActivity(config),
    },
  });

  log.info(`worker started — taskQueue=${config.temporalTaskQueue}`);
  await worker.run();
}

main().catch((err) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  log.error(`worker failed to start or crashed: ${message}`);
  process.exitCode = 1;
});
