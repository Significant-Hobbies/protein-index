## Context

`evidence_outcomes` has one mutable row per product and field family. It is a
useful read projection, but it cannot prove the lifecycle of a terminal
unavailable claim. The extraction ledger deliberately does not infer
`not_declared` or `not_applicable`, and current review decisions cover verified,
rejected, and redundant candidates rather than a reviewer-confirmed absence.

The new lifecycle must preserve history, bind the decision to evidence that the
server knows is current, survive replay, and avoid one drifting source erasing a
different valid source.

## Goals / Non-Goals

**Goals:**

- Make every terminal-unavailable state traceable to an immutable human
  decision and exact current source or label evidence.
- Support correction through append-only supersession without mutating history.
- Keep multiple independent source decisions and select a deterministic current
  projection only when they agree.
- Revoke trust automatically when any identity, source-content, product-link,
  or label-byte binding no longer matches.
- Preserve the completion invariant without treating a cache row as truth.

**Non-goals:**

- Treat missing structured fields, failed OCR, or no model prediction as proof
  that a declaration is absent.
- Create identity-family unavailable decisions.
- Automatically decide terminal state or publish production data.

## Decisions

### Store append-only terminal decisions separately

A forward migration adds `terminal_evidence_decisions` for nutrition and
ingredients. Each row stores the decision ID, outcome, source record identity
and content hash, canonical product ID, evidence kind, optional exact label
asset and byte hash, rationale, reviewer, timestamp, and an optional
`supersedes_decision_id`.

The table has no mutable `active` flag. A decision is a current head when no
later row supersedes it. A supersession must target the same product, family,
source binding, and evidence lineage. A unique supersession edge prevents two
competing replacements of the same decision.

Reusing candidate `evidence_decisions` was rejected because terminal absence is
not tied to a model candidate hash. Mutating `evidence_outcomes` directly was
rejected because it loses history and alternate-source evidence.

### Accept only server-enumerated evidence

The API first lists eligible evidence for one product and family. A source
option carries the exact current source-record ID, key, content hash, product
link, source URL, observation time, and authority. A label option additionally
carries a retained label-asset ID and content SHA-256 that is exactly joined to
the same source record, source content, product, and family.

The mutation sends the selected opaque evidence identity and its optimistic
hashes. The server re-derives the option in the transaction. It does not accept
an arbitrary URL as authoritative evidence.

`not_declared` means the reviewer inspected the complete applicable declaration
and the selected family is absent. `not_applicable` means the selected evidence
explicitly establishes that the family does not apply. Neither may be inferred
from an empty field, extraction failure, or missing candidate.

### Derive truth from exact current decision chains

A terminal decision is current only when all of these still match:

- source ID, record key, record ID, and content hash;
- canonical product ID and current source-record link;
- selected field family;
- for label evidence, label asset ID, byte hash, source binding, and product;
- no current descendant supersedes the decision.

The completion ledger exact-joins those current decisions. It classifies a
family as terminal unavailable only when at least one valid current decision
exists, all valid current decisions agree on the outcome, and no verified or
conflicting fact contradicts them. Otherwise it remains outstanding in the
`evidence_inconsistent` lane.

### Keep the outcome row as a deterministic cache

`evidence_outcomes` remains the consumer-facing projection. Reconciliation
selects the valid agreeing decision with highest source authority, then newest
decision time, then decision ID. It upserts that projection or removes only the
terminal projection when no valid decision remains. Immutable decision rows are
never deleted.

If source A drifts while source B still has a valid agreeing decision, source B
becomes the projection. Drift in one source therefore cannot erase independent
valid evidence. If valid sources disagree between `not_declared` and
`not_applicable`, no terminal projection is trusted and the worklist exposes the
contradiction.

### Make review local-only and explicit

The local operator endpoint validates the current evidence binding and inserts
the immutable decision plus its deterministic projection in one D1 transaction.
Exact replay returns the existing result. A conflicting duplicate without an
explicit supersession fails before any write.

The completion worklist shows the evidence preview, outcome definitions,
rationale, explicit confirmation, prior decision history, and source drift.
Remote production continues to deny mutations.

## Risks / Trade-offs

- **A reviewer treats missing data as not declared** -> show the exact evidence,
  require a rationale and confirmation, and prohibit automated creation.
- **Two sources disagree** -> fail closed and expose the contradiction instead
  of choosing a convenient result.
- **A correction erases history** -> append a validated superseding decision;
  never update or delete the prior row.
- **Source refresh changes an otherwise identical page** -> exact content drift
  intentionally requires re-review; an independent valid source can still keep
  the family terminal.
- **Legacy naked outcomes exist** -> retain them for diagnostics but exclude
  them from strict completion until backed by an immutable decision.

## Migration Plan

1. Add the append-only schema, shared validation, and migration tests.
2. Add eligible-source and terminal-decision Worker endpoints with transaction
   and replay tests.
3. Add reconciliation projection/fallback and strict completion joins.
4. Add the local operator flow and responsive contract tests.
5. Run full checks and local rendered verification, then update project status.
6. Leave production migration and deployment pending an explicit release.

Rollback before production is code-only. After terminal decisions exist, any
rollback must retain the table reader and strict completion logic so immutable
history remains interpretable.
