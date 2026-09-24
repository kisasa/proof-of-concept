/**
 * Loads skill markdown files from the top-level skills/ directory and returns
 * them as Anthropic system prompt content blocks. Skills are portable expertise —
 * shared across agent types, not specific to any one agent.
 *
 * Each skill lives at skills/<name>/SKILL.md — the Claude Skills convention,
 * and now the only copy. This loader used to read a parallel
 * skills/<name>/<name>.md kept in sync by hand; that duplicate is removed
 * (docs/design-ledger.md, 2026-08-23), because two hand-synced copies of the
 * same instructions is a silent-divergence hazard and the mechanism is about
 * to carry per-surface skills as well.
 *
 * Each agent declares the skill names it needs. This loader resolves those names
 * to files and returns one content block per skill, ready to spread into the
 * system array of an Anthropic Messages API call.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SKILLS_DIR = fileURLToPath(new URL("../../skills/", import.meta.url));

export type SkillBlock = { type: "text"; text: string };

export async function loadSkills(names: string[]): Promise<SkillBlock[]> {
  if (names.length === 0) return [];
  return Promise.all(
    names.map(async (name) => {
      const text = await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
      return { type: "text" as const, text: text };
    }),
  );
}
