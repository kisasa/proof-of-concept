---
name: poc-conventions-writing
description: Writes the short, structure-only CONVENTIONS.md a proof-of-concept surface needs before its first specialist dispatch. Use when setting up a PoC repo or a new surface in one, or when an architect asks for PoC conventions, "set up conventions for this PoC", or "initialize this surface for the PoC pipeline".
---

# PoC conventions writing

DRAFT — unvalidated; prompt engineering happens against real PoC runs

Every PoC surface gets a short `CONVENTIONS.md` before its first dispatch.
Specialists read it before writing code and imitate what it says. It is cheap
to write at the start and expensive to fix once code has set the pattern.

A PoC's conventions cover **structure only**:

- layering
- where boundaries sit
- naming
- where tests go, if any are written
- the shortcut-marking rule

Tests are not required on a PoC; the demo gate is what verifies it works. But
a specialist who does write one should put it where the next one will look.

Everything else a production conventions file adds (test requirements and
coverage, error handling, performance, observability, style) is left out on
purpose. The
point is to keep specialists from inventing a new structure every run, not to
raise the quality bar. If the PoC graduates, this file is rewritten for full
development (see `graduation-packaging`).

## Who does what

The architect decides and the agent writes. Ask the architect in prose; they
never fill in a template. You draft the file from their answers, show it to
them, and revise it until they say it is right. A draft nobody confirmed is
not a convention.

## Where the file goes

- **One file per surface.** Put it at the surface's root:
  `<path>CONVENTIONS.md`, where `<path>` is the surface's `path` in the
  `Surfaces` registry. A surface at the repo root gets `CONVENTIONS.md`.
- **Keep the default location.** The registry's `conventions` field can point
  elsewhere, but the dispatcher does not tell the specialist that path. A file
  anywhere but the default is only found if the specialist reads the registry
  itself.
- **Commit it before the first story on that surface is dispatched.** Commit
  it to the branch that stories branch from.

## Before asking anything

Read what exists, so you ask only what the code cannot answer:

- the hypothesis brief, especially the demo path and the faked-by-design list
- the `Surfaces` registry, if it exists
- the repository, if it has code: its top-level layout, how its existing
  modules are layered, and the naming it already uses

In a repo that already has code, **describe what is there**. Propose changes
only where the existing structure would stop the demo path from being built.
Conventions that contradict the code in front of the specialist lose to the
code.

## The interview

Ask only what you could not settle from reading. Use a short numbered list,
so answers can refer to numbers. Offer a recommended answer with each
question, so the architect can reply "yes" or change one word.

1. **Layering.** What are the layers of this surface, and which way do
   dependencies point? For example: routes call services, services call data
   access, and nothing calls upward.
2. **Boundaries.**
   - Where does this surface end? What does it own, and what does it reach
     through another surface's contract?
   - Where do the stubs from the faked-by-design list live? Behind the same
     interface the real integration will use, so replacing a stub later does
     not touch its callers.
3. **Naming.** What case and pattern do files, directories, and exported
   symbols use? Where does a new feature's code go? Name the directory a
   specialist should create files in.
4. **Tests.** If a specialist writes a test, where does it go, what is it
   named, and what command runs it? Follow the surface's existing test setup
   if it has one. If it has none, recommend the stack's usual default rather
   than inventing one. This says where tests go, not that any are required.
5. **Anything a specialist must never do on this surface.** For example: add
   a dependency without saying so in the hand-back, or write outside the
   surface's path.

## The file

```markdown
# <Surface> conventions (PoC)

This is a proof of concept. These conventions cover structure only. They are
rewritten if the PoC graduates.

## Layering

<The layers, top to bottom, and the one rule about which way calls go.>

## Boundaries

<What this surface owns. What it reaches only through another surface's
contract, which is the epic's API map. Where stubs live and the interface
they sit behind.>

## Naming

<File, directory, and symbol conventions. Where new feature code goes.>

## Tests

Tests are optional on this PoC; the demo gate verifies it. If you write one:

<Where it goes, how it is named, and the command that runs it.>

## Shortcuts

Every shortcut is marked where it lives, with a comment in the file's own
syntax:

    POC-SHORTCUT: SC-###

and has a row in the project's shortcut ledger. A marker with no row, or a
row with no marker, is a defect. Prefer a stub behind a real interface over a
real integration anything on the faked-by-design list names.

## Never

<The architect's short list, if any.>
```

The **Shortcuts** section is the same on every surface. Copy it as written;
the `shortcut-marking` skill is the source of truth for the rule.

## Quality bar

Before you ask the architect to confirm, check the draft:

- Every section is present. An empty **Never** is fine and says "None."
- Each rule is concrete enough that two specialists would put the same code in
  the same place.
- Nothing in it requires tests, and nothing in it is a performance or style
  rule. Saying where tests go is not a requirement to write them.
- It agrees with the code already in the repository.

## Open

- **No lane runs this skill yet.** An architect runs it in their own session
  when setting up a repo or surface. Whether Intake or Specification should
  run it instead is undecided.
