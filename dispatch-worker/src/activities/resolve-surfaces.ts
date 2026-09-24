/**
 * Resolves the story's surfaces to one repo, ref, and set of surface records
 * from the surface registry: the epic's `Surfaces (override)` document layered
 * on the project's `Surfaces` document (see surface-registry.ts, and
 * docs/design-ledger.md 2026-09-02). Replaces the per-epic `Repo base —`
 * comment parser and its four defensive patches; the registry is agent-
 * written from a confirmed answer, so a malformed record is a bug to report,
 * not a typo to work around.
 *
 * A missing surface, an inactive surface, a repo/ref mismatch between a
 * story's surfaces, or a malformed registry is a pipeline-setup problem, not
 * something retrying can fix — so `ApplicationFailure.nonRetryable`, with a
 * message actionable on its own (the workflow's catch-all posts it verbatim
 * to the story).
 */

import { ApplicationFailure } from "@temporalio/activity";
import { getIssueDocuments, getProjectDocuments, linearApiUrl, type TrackerDocument } from "../tracker.js";
import type { WorkerConfig } from "../worker-config.js";
import {
  EPIC_OVERRIDE_TITLE,
  PROJECT_REGISTRY_TITLE,
  SurfaceRegistryParseError,
  mergeRegistries,
  parseRegistryDocument,
  resolveSurfaces,
  type ResolvedTarget,
  type SurfaceRecord,
} from "./surface-registry.js";
import type { Surface } from "./types.js";

export type { RepoBase, ResolvedTarget, SurfaceRecord } from "./surface-registry.js";

function findByTitle(documents: readonly TrackerDocument[], title: string): TrackerDocument | null {
  const wanted = title.trim().toLowerCase();
  return documents.find((d) => d.title.trim().toLowerCase() === wanted) ?? null;
}

/**
 * Pure: given the epic's documents and the project's documents, produce the
 * effective registry. Split out so the parse-and-merge path is testable
 * without mocking Linear.
 */
export function buildEffectiveRegistry(
  epicDocuments: readonly TrackerDocument[],
  projectDocuments: readonly TrackerDocument[],
): SurfaceRecord[] {
  const project = parseRegistryDocument(findByTitle(projectDocuments, PROJECT_REGISTRY_TITLE)?.content);
  const override = parseRegistryDocument(findByTitle(epicDocuments, EPIC_OVERRIDE_TITLE)?.content);
  return mergeRegistries(project, override);
}

export function createResolveSurfacesActivity(config: WorkerConfig) {
  return async function resolveSurfacesActivity(epicId: string, surfaces: Surface[]): Promise<ResolvedTarget> {
    const baseUrl = linearApiUrl();
    const epic = await getIssueDocuments(epicId, config.linearAgentApiKey, baseUrl);
    const projectDocuments = epic.projectId ? await getProjectDocuments(epic.projectId, config.linearAgentApiKey, baseUrl) : [];

    let registry: SurfaceRecord[];
    try {
      registry = buildEffectiveRegistry(epic.documents, projectDocuments);
    } catch (error) {
      if (error instanceof SurfaceRegistryParseError) {
        throw ApplicationFailure.nonRetryable(
          `Epic ${epicId}: the surface registry could not be read — ${error.message}. ` +
            `Fix the "${PROJECT_REGISTRY_TITLE}" document on the project (or "${EPIC_OVERRIDE_TITLE}" on the epic); ` +
            `the agents write these documents, so a malformed record means an agent wrote it wrong.`,
          "MalformedSurfaceRegistry",
        );
      }
      throw error;
    }

    if (registry.length === 0) {
      throw ApplicationFailure.nonRetryable(
        `Epic ${epicId}: no surface registry found. Expected a "${PROJECT_REGISTRY_TITLE}" document on the project ` +
          `(or "${EPIC_OVERRIDE_TITLE}" on the epic) carrying a \`\`\`surfaces block. The Specification Agent writes it ` +
          `once the architect confirms where each surface lives.`,
        "MissingSurfaceRegistry",
      );
    }

    const result = resolveSurfaces(registry, surfaces);
    if (!result.ok) {
      throw ApplicationFailure.nonRetryable(`Epic ${epicId}: ${result.reason}`, "UnresolvedSurface");
    }
    return result.target;
  };
}
