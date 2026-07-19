## Context

The catalog and product drawer currently expose a broad evidence-review model.
The consumer product goal is a fast macro comparison.

## Goals / Non-Goals

**Goals:**

- Show protein, carbs, fat, fibre, calories, and protein density directly.
- Remove consumer-facing expandable technical detail.

**Non-Goals:**

- Change API evidence, source retention, ingestion, or operator review tools.
- Claim catalog completeness beyond the configured source runs.

## Decisions

- Replace comparison-table evidence and completeness columns with macro columns.
- Keep a compact drawer for identity, five macros, and protein density only.
- Preserve all provenance in the backend and operator surfaces rather than
  deleting it.

## Risks / Trade-offs

- [Less consumer-visible provenance] → Macro values remain source-aware in the
  data model and the dashboard continues to state the nutrition basis.
