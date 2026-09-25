---
name: hypothesis-brief-writing
description: The structure and quality bar of a hypothesis brief, the document that defines one proof of concept. Use when producing, regenerating, or checking a brief.
---

# Hypothesis brief

DRAFT — unvalidated; prompt engineering happens against real PoC runs

A hypothesis brief is a document attached to the PoC's tracker project. The
agent writes it and regenerates it in place; humans answer in the thread, in
prose. It has six sections, in this order.

## 1. Hypothesis

What is being proven, in one or two sentences, phrased so it can be proven or
disproven.

- Weak: a sentence that names a product area and no outcome.
- Strong: a sentence naming who can do what, against what, that is not
  possible today.

## 2. Audience and verdict owner

Who the PoC is for, and the **one** person who signs the verdict. Name a
single person. A list of people, or a team, is a gap to ask about.

## 3. Demo path

The ordered sequence of user-visible steps that, if they work, prove the
hypothesis. This is the spine of the project: epics are cut from it, and the
demo gate watches it.

- Number the steps.
- Each step is something a person can watch happen: an action and its
  visible result.
- A step that cannot be watched, such as "the data is consistent", is a gap.

## 4. Faked by design

The explicit list of what will be stubbed, mocked, hardcoded, or skipped,
known before work starts. Typical entries are integrations, auth,
multi-tenancy, data volume, and error handling beyond the demo path. Each
entry says what it stands in for. Shortcuts found later go in the shortcut
ledger instead; this list is what was decided up front.

## 5. Layout references

Screenshots only, attached to this document. A live site is captured as
screenshots at intake, because specialists have no web access. Design is loose
by intent, so these show layout, not a settled visual design.

## 6. Out of scope

What the PoC will not attempt, even as a fake.

## Quality bar

A brief is complete when all of these hold:

- every section is present
- the verdict owner is one person
- every demo-path step can be watched
- every fake names what it stands in for

Mark a gap inline as **Open:** with the question. Do not fill a gap with a
guess.
