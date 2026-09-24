/**
 * The wording of every notice the workflow posts on a pull request during
 * revision rounds. Pure string builders with no imports, for the same reason
 * `describe-failure.ts` is: the workflow runs in Temporal's deterministic
 * sandbox and can import this, while the activity that actually posts these
 * strings cannot be imported there at all.
 *
 * The wording is the product. A developer reads these instead of reading the
 * pipeline, so each one says what happened, what remains, and what the
 * pipeline will and will not do next.
 *
 * **None of them says what the specialist did.** That is the specialist's own
 * reply in its own words, in the thread the review was left in — the app
 * reports only that a round ran (CLAUDE.md, Layering).
 */

export function revisionRoundStartedNotice(round: number, cap: number): string {
  return (
    `**Revision round ${round} of ${cap}** _(automated)_\n\n` +
    `Dispatching the specialist against this review. It replies here itself when the round ends.`
  );
}

export function revisionRoundFinishedNotice(round: number, cap: number): string {
  const remaining = cap - round;
  const remainingLine =
    remaining === 0 ? "No rounds remaining." : `${remaining} of ${cap} round${remaining === 1 ? "" : "s"} remaining.`;
  return (
    `**Revision round ${round} of ${cap} — finished** _(automated)_\n\n` +
    `${remainingLine} What changed is in the specialist's own reply, not here — this line only records that the round ran.`
  );
}

/**
 * Posted the moment the cap is spent, not when a fourth review arrives. A
 * developer who submits one and hears nothing cannot tell a spent cap from a
 * broken pipeline, and by then it is too late to tell them.
 */
export function revisionRoundsExhaustedNotice(cap: number): string {
  return (
    `**No revision rounds remaining** _(automated)_\n\n` +
    `All ${cap} rounds have been used. A further "request changes" review on this PR will not dispatch the specialist. ` +
    `This PR is still being watched for merge or close.\n\n` +
    `${cap} rounds usually means the story was mis-shaped rather than the code being wrong. Closing this PR, adjusting ` +
    `the story and re-running is often cheaper than carrying on here — delete the story branch first, since a ` +
    `re-dispatch refuses to build on an abandoned attempt.`
  );
}

/**
 * Posted once, when the PR opens, if the story's mover could not be resolved
 * to a GitHub login. Without it the revision loop is silently off: the
 * developer requests changes, nothing happens, and nothing says why.
 *
 * Names the person, not their email. The mapping is keyed by email and the
 * worker's own log line carries it, but this comment lands in the target
 * repository and does not need to.
 */
export function reviewerUnmatchedNotice(moverName: string | null): string {
  const who = moverName ? `"${moverName}"` : "whoever moved this story to In Progress";
  return (
    `**Revision requests are off for this story** _(automated)_\n\n` +
    `${who} could not be matched to a GitHub login, so a "request changes" review here cannot be attributed to the ` +
    `reviewer-of-record and will not dispatch the specialist. Adding the mapping to \`REVIEWER_EMAIL_TO_GITHUB_LOGIN\` ` +
    `turns this on for future stories. Reviewing and merging this PR are unaffected.`
  );
}

/**
 * The revision round itself failed — an infrastructure failure, not the
 * specialist declining the work. The tracker gets the same message through
 * `postDispatchFailed`; this is its PR-side twin, because the person waiting
 * on the round is reading the PR.
 */
export function revisionRoundFailedNotice(round: number, cap: number, failure: string): string {
  return (
    `**Revision round ${round} of ${cap} failed** _(automated)_\n\n` +
    `${failure}\n\n` +
    `Nothing further will run on this PR — the story has been moved back to Todo. Reviewing and merging are unaffected.`
  );
}
