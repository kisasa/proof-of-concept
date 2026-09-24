#!/usr/bin/env node
/**
 * Fails if the repository references a private artifact — a tracker team or
 * issue key, a client organization or repository, a person, or a named deployed
 * environment. See CONTRIBUTING.md, "No Private References".
 *
 * This is a pattern check, not a proof. It catches the shapes this repository
 * has actually leaked. When you find a new one, add a rule here rather than
 * fixing the single instance quietly: the rule was violated within an hour of
 * being written down, which is why it is enforced by a script and not by
 * memory.
 *
 * Node rather than a shell one-liner because two of the checks need a negative
 * lookahead (allow the `PROJ-` placeholder, reject every other issue-key shape)
 * and a real list of non-tracker false positives (`UTF-8`, `SHA-256`, ...).
 * `git grep -E` has no lookahead and git is not guaranteed to be built with
 * PCRE.
 *
 * Usage: node scripts/check-no-private-references.mjs
 * Exits 0 when clean, 1 with every offending line otherwise.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The only exempt paths: this file, which necessarily contains every pattern it
 * searches for, and its test file, which necessarily contains an example of
 * each. Both are listed exactly, never as a directory glob — an exemption wide
 * enough to hide a real leak behind is worse than no check. Nothing else is
 * exempt; there is no "internal only" directory in an open-source repository.
 *
 * The test file had to be added here after it failed the check on its first
 * run, which is the same self-reference the script has always had.
 */
const EXEMPT = new Set([
  "scripts/check-no-private-references.mjs",
  "scripts/check-no-private-references.test.mjs",
]);

/** Machine-written files, exempt from the shape heuristic only. */
const GENERATED = /(^|\/)package-lock\.json$/;

/**
 * Token shapes that look like an issue key but are not: encodings, hash and
 * cipher sizes, standards references. Matched case-sensitively against the
 * whole token, so `UTF-8` passes and `LET-8` does not.
 */
const NOT_TRACKER_KEYS = new Set([
  "UTF-8",
  "UTF-16",
  "UTF-32",
  "SHA-1",
  "SHA-256",
  "SHA-512",
  "MD-5",
  "AES-128",
  "AES-256",
  "RSA-2048",
  "HTTP-1",
  "HTTP-2",
  "HTTP-3",
  "ISO-8601",
  "ISO-3166",
  "ISO-4217",
  "RFC-1123",
  "RFC-3339",
  "RFC-7231",
  "IPV-4",
  "IPV-6",
  "AWS-4",
  "EC-2",
  "PKCS-1",
  "PKCS-8",
  "BASE-64",
  "CVE-2021",
  "CVE-2022",
  "CVE-2023",
  "CVE-2024",
  "CVE-2025",
  "CVE-2026",
]);

/** The approved placeholder issue-key prefix (CONTRIBUTING.md's table). */
const PLACEHOLDER_KEY = /^PROJ-\d+$/;

const RULES = [
  {
    /**
     * Case-insensitive on purpose: a branch name derived from an issue key
     * (`let-58`, `aip-101-refund-endpoint`) is the same leak in lower case,
     * and the uppercase-only version of this rule walked past thirteen of
     * them in test fixtures. The shape heuristic below stays uppercase-only —
     * lower case would match every `utf-8` and `node-22` in the tree.
     */
    label: "tracker issue keys (use PROJ-<n> instead)",
    pattern: /\b(?:LET|STPDEV|AIP|TARJAY|MGMT)-\w+/gi,
  },
  {
    /**
     * The catch-all for key shapes not yet seen. Skips generated lock files:
     * their SPDX license identifiers (`BSD-3-Clause`, `MPL-2.0`, `CC-BY-4.0`)
     * are indistinguishable from an issue key by shape alone, and nothing in a
     * lock file is authored here — the named rules above still scan them, which
     * is what would catch a private package or registry.
     */
    label: "possible tracker issue key (only PROJ-<n> is allowed)",
    pattern: /\b[A-Z]{2,8}-\d{1,5}\b/g,
    ignore: (token) => NOT_TRACKER_KEYS.has(token) || PLACEHOLDER_KEY.test(token),
    skipGenerated: true,
  },
  {
    label: "client or engagement org / repo names",
    pattern:
      /\bSTPDEV\b|Streamline[- ]?Payments|le-tarjay|team-tarjay|team-target|(?:Le|Team)[ -]?Tar[gj]|Targét|StreamPay|streampay|Management\.[Ww]eb|Management-Angular|management-web|[Pp]ay[Nn]ow|vt-web|VirtualTerminal|virtualterminal/g,
  },
  {
    label: "people — names, emails, GitHub logins, tracker user ids",
    pattern:
      /Dieruf|ddieruf|daviddieruf|Marroqu|Rodriguez|V[aá]zquez|jmarroquin|cvazquez|@kisasa\.io|b13c0f8d-ac46-48ff-b1a2-1df7da3caa33/g,
  },
  {
    /**
     * Bare first names. Added after a scrub that removed every full name and
     * email still left 68 first-name references in the design ledger — the
     * named-person rule above matched none of them, because attribution in
     * prose is almost always first-name-only ("the architect's own framing"
     * started life as a first name). Use the role, not the person.
     */
    label: "people — bare first names (use the role instead)",
    pattern: /\b(?:David|Julie|Jes[uú]s|Cristian|Michael)\b/g,
  },
  {
    /**
     * Any `kisasa-` prefix at all. This rule has now been widened twice: an
     * enumeration of two names missed a third four lines away, and
     * `kisasa-[a-z]+` then missed `kisasa-${environmentName}` because an
     * interpolation is not a lowercase letter. Match the prefix and nothing
     * else — every narrowing attempt has cost a leak.
     */
    label: "named deployed environments",
    pattern: /kisasa-|ud8ke/g,
  },
  {
    /**
     * Authorship credit in `README.md` and the project's own branding are
     * deliberate and allowed. A repo coordinate, email address, ARN or
     * namespace built from the same word is not.
     */
    label: "kisasa used as a coordinate rather than as authorship",
    pattern: /(?:github|gitlab)\/kisasa|kisasa\/[a-z]|["']kisasa["']/gi,
  },
  {
    /**
     * The bare domain as a configuration value. Skips markdown: authorship
     * credit in `README.md` links to it deliberately, and that is allowed —
     * a domain in a config value or in code is not.
     *
     * Added after `cdktf.json` turned out to hold five identifying values no
     * rule here matched — a capitalised AWS profile, this domain, a hosted
     * zone id, an account number and a state bucket. Two of those are now
     * covered; an account number and a zone id are digits and a rule for them
     * would flag every unrelated number in the tree. That gap is the argument
     * for keeping deployment config out of the repository entirely rather
     * than trying to pattern-match it, which is why `cdktf.json` is now
     * gitignored with a committed template beside it.
     */
    label: "private domain used as a configuration value",
    pattern: /kisasa\.io/g,
    skipMarkdown: true,
  },
  {
    /**
     * The org name baked into a code identifier or filename. Added after the
     * first full sweep missed `KisasaStack` and `stacks/kisasa-stack.ts` — the
     * base class every infrastructure stack extends — because every other rule
     * looked for the word in a coordinate, an email or an ARN, never in
     * PascalCase or a kebab-case filename.
     */
    label: "org name used as a code identifier or filename",
    pattern: /Kisasa[A-Z]\w*|kisasa-[a-z]+\.ts/g,
  },
];

/**
 * Tracked files plus untracked files that are not ignored. Untracked matters:
 * a new file written but not yet `git add`ed is exactly what a pre-commit run
 * of this check is for, and the tracked-only version passed locally on a file
 * that then failed in CI once it was committed (2026-09-02).
 */
function trackedFiles() {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter((path) => path.length > 0 && !EXEMPT.has(path));
}

function isProbablyBinary(contents) {
  return contents.includes("\u0000");
}

/**
 * The pure half: given a path and its contents, what does each rule find? Split
 * out from the filesystem walk so the rules can be tested against a string
 * without a git checkout — see check-no-private-references.test.mjs, where
 * every widening this check has needed is pinned as a regression test.
 *
 * `path` is not just a label: two rules opt out by path shape (a generated lock
 * file, a markdown file), so the same line can be a finding in one file and
 * allowed in another.
 */
export function findingsIn(path, contents) {
  const found = [];
  if (isProbablyBinary(contents)) return found;

  const generated = GENERATED.test(path);
  const markdown = path.endsWith(".md");
  const lines = contents.split("\n");

  for (const rule of RULES) {
    if (rule.skipGenerated === true && generated) continue;
    if (rule.skipMarkdown === true && markdown) continue;
    lines.forEach((line, index) => {
      const matches = line.match(rule.pattern);
      if (matches === null) return;
      const offending = rule.ignore === undefined ? matches : matches.filter((m) => !rule.ignore(m));
      if (offending.length === 0) return;
      found.push({
        label: rule.label,
        path: path,
        line: index + 1,
        text: line.trim().slice(0, 160),
        tokens: [...new Set(offending)],
      });
    });
  }

  return found;
}

function findings() {
  const found = [];
  for (const path of trackedFiles()) {
    let contents;
    try {
      contents = readFileSync(join(REPO_ROOT, path), "utf8");
    } catch {
      continue;
    }
    found.push(...findingsIn(path, contents));
  }
  return found;
}

/**
 * Only when run as a command. Importing this module — which the test suite
 * does — must not scan a repository or exit the process.
 */
function main() {
  const found = findings();

  if (found.length === 0) {
    process.stdout.write("No private references found.\n");
    process.exit(0);
  }

  const byLabel = new Map();
  for (const finding of found) {
    const bucket = byLabel.get(finding.label) ?? [];
    bucket.push(finding);
    byLabel.set(finding.label, bucket);
  }

  for (const [label, bucket] of byLabel) {
    process.stdout.write(`\n== ${label} — ${bucket.length} ==\n`);
    for (const finding of bucket) {
      process.stdout.write(`${finding.path}:${finding.line}: [${finding.tokens.join(", ")}] ${finding.text}\n`);
    }
  }

  process.stdout.write(
    `\n${found.length} private reference(s) found. See CONTRIBUTING.md, "No Private References",\n` +
      "for the approved placeholders. Keep the observation, drop the anchor.\n",
  );
  process.exit(1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
