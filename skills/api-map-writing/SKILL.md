---
name: api-map-writing
description: What a well-formed PoC API map looks like, the architect-approved contract between surfaces for one claim epic. Use when producing, regenerating, or reviewing an API map.
---

# API map writing

DRAFT — unvalidated; prompt engineering happens against real PoC runs

The API map is a document attached to a claim epic and regenerated in place.
It records the contract the claim's demo steps cross between surfaces. In a
PoC it is kept light but kept anyway: it is cheap now, and if the idea
graduates it becomes the contract full development starts from, as-is.

There are **architect rows only**. A PoC has no designer rows.

## Contents

For each boundary the claim crosses:

| Field | Content |
|---|---|
| Surfaces | Which surface calls which, by registry name |
| Operation | The endpoint, event, or function boundary, by name and shape |
| Request | Fields and types, only as far as the demo path uses them |
| Response | Fields and types, success and the demo path's failure cases only |
| Real or faked | `real`, or the faked-by-design entry it is stubbed against |

## Quality bar

- Every boundary the claim's demo steps cross appears once.
- Anything faked names the brief's faked-by-design entry it relies on, so the
  stub has a documented shape to be replaced against.
- Nothing is specified beyond what the demo path exercises. Breadth is
  full-development work.
