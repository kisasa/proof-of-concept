/**
 * Regression tests for the reference check's rules.
 *
 * Every case below is something the check once walked past. It has been
 * widened eight times, each time because a rule precise enough to avoid false
 * positives was also precise enough to miss the next instance — and until now
 * not one of those fixes had a test, so nothing stopped a later edit from
 * quietly re-narrowing a pattern and reopening a leak already paid for.
 *
 * The negative cases matter as much as the positive ones: two widenings had to
 * be walked back because they flagged ordinary content, and a rule everyone
 * mutes is worse than a narrow one that holds.
 *
 * node:test and node:assert rather than vitest, deliberately. This check runs
 * in CI with no dependency install — that is what makes it unskippable — and
 * its tests should not be the thing that reintroduces one.
 *
 * Run: node --test scripts/
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { findingsIn } from "./check-no-private-references.mjs";

/** Does any rule flag this line, in a file at this path? */
function flags(line, path = "src/example.ts") {
  return findingsIn(path, line).length > 0;
}

test("catches an organization-prefixed resource name", () => {
  assert.ok(flags('name: formatName(`kisasa-specialist-${config.environmentName}`),'));
});

test("catches that prefix followed by an interpolation, not just lowercase letters", () => {
  // The rule was `kisasa-[a-z]+` and walked past this, four lines from a name
  // it did catch, because `${` is not a lowercase letter.
  assert.ok(flags('name: `kisasa-${environmentName}`,'));
});

test("catches the organization name as a code identifier or filename", () => {
  assert.ok(flags("export abstract class KisasaStack extends TerraformStack {"));
  assert.ok(flags('import { KisasaStack } from "./kisasa-stack";'));
});

test("catches a bare first name used as attribution", () => {
  // The person rule matched full names and email addresses, and missed 68
  // first-name references in the design ledger. Attribution in prose is almost
  // always first-name-only.
  assert.ok(flags("David caught a gap the terminology sweep didn't touch", "docs/design-ledger.md"));
  assert.ok(flags("Julie advocates a full-stack story", "docs/design-ledger.md"));
});

test("catches an issue key in lower case, as a branch name", () => {
  assert.ok(flags('storyBranch: "aip-101-refund-endpoint",'));
  assert.ok(flags('"Could not read epic branch \\"let-58\\" in example-org/example-app"'));
});

test("catches an issue key whose suffix is not a number", () => {
  // `STPDEV-XXX`, a placeholder in a skill file. The rule required digits.
  assert.ok(flags("Reference the epic as STPDEV-XXX in the story body"));
});

test("catches the sandbox team by name, including the accented spelling", () => {
  assert.ok(flags("confirmed live against Le Targét's team state list"));
  assert.ok(flags("a synthetic engagement built for Team Targét"));
});

test("catches the private domain used as a configuration value", () => {
  assert.ok(flags('"domain-name": "kisasa.io",'));
});

test("allows the approved placeholder key", () => {
  assert.ok(!flags('storyId: "PROJ-101",'));
  assert.ok(!flags("- PROJ-42 — Add refund data model", "skills/story-contract/SKILL.md"));
});

test("allows token shapes that only look like issue keys", () => {
  assert.ok(!flags('const encoding = "UTF-8";'));
  assert.ok(!flags("// hashed with SHA-256, per RFC-3339 timestamps"));
});

test("allows SPDX licence identifiers in a generated lock file", () => {
  // The shape heuristic cannot tell `BSD-3-Clause` from an issue key, so it
  // skips machine-written files. The named rules still scan them.
  assert.ok(!flags('      "license": "BSD-3-Clause"', "dispatch-worker/package-lock.json"));
  assert.ok(flags('      "resolved": "https://github.com/kisasa/private-pkg"', "dispatch-worker/package-lock.json"));
});

test("allows authorship credit in markdown, but not the same domain in code", () => {
  assert.ok(!flags("Built by [Kisasa](https://kisasa.io)", "README.md"));
  assert.ok(flags('const host = "kisasa.io";', "src/config.ts"));
});

test("does not flag the ordinary word target", () => {
  assert.ok(!flags("// the target repo is cloned fresh per run"));
});

test("reports the path and line it found, so a failure is actionable", () => {
  const found = findingsIn("src/example.ts", "clean line\nname: `kisasa-${env}`,\n");
  assert.equal(found.length, 1);
  assert.equal(found[0].path, "src/example.ts");
  assert.equal(found[0].line, 2);
});
