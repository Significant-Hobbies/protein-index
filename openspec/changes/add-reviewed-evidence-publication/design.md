## Context

Robotoff extraction creates immutable source records and nutrition-validation
review items. A local review can update `nutrition_facts`, `field_observations`,
and `evidence_outcomes`, but the decision itself is not a first-class durable
record and cannot be exported or replayed. Re-importing the same candidate can
therefore reopen work, while production remains intentionally read-only.

The existing release architecture already favors checksummed artifacts, exact
source accounting, manual GitHub workflows, protected production environments,
and D1 post-write verification. Reviewed evidence should use the same pattern
without introducing remote mutation credentials or trusting model output.

## Goals / Non-Goals

**Goals:**

- Bind every verify or reject decision to the exact candidate and source content
  reviewed by the operator.
- Make decisions portable, deterministic, reviewable in Git, and replay-safe.
- Fail publication when source evidence has changed or a normalized value no
  longer passes current validation.
- Preserve the public read-only boundary and manual production approval.
- Make unchanged rejected candidates stay resolved without treating rejection as
  terminal unavailable nutrition.

**Non-Goals:**

- Automatically verify predictions because multiple sources agree.
- Copy raw label images into Git or D1.
- Add public production mutations or configure an identity provider.
- Bulk-approve candidates without a per-candidate human decision and evidence
  URL.
- Treat a rejected prediction as proof that nutrition is absent from the pack.

## Decisions

### Store evidence decisions separately from review queue state

A new `evidence_decisions` table records source id/key, source-record id and
content hash, product id, candidate hash, field family, verify/reject decision,
normalized payload, evidence URL, rationale, reviewer, timestamp, and active
state. The candidate hash is SHA-256 over a canonical subset containing the
prediction id, barcode, image id and URL, model/version, observation timestamp,
basis, confidence, and normalized values.

Review queue rows remain operational state. They can be regenerated; durable
decisions cannot be inferred from whether a row happens to be resolved.

Alternative: export mutated `nutrition_facts` directly. Rejected because it
loses the reviewed candidate identity and cannot prove that values still match
the source evidence.

### Export deterministic, version-controlled decision bundles

`data:review:export` reads active local decisions through Wrangler's local D1
interface and writes:

```text
review-decisions/<bundle-id>/
  manifest.json
  decisions.jsonl
  checksums.sha256
```

Records are sorted by decision id. The manifest contains schema version, source
run/candidate counts, decision counts, creation time, and the hash of the JSONL
ledger. Raw images remain external evidence URLs. The resulting small bundle is
committed through an ordinary reviewed PR, giving the human ledger durable Git
history without committing source-response archives.

Alternative: authenticate the hosted mutation endpoint. Deferred because it
adds identity configuration and a higher-risk internet-facing write path, while
the current review volume can use an offline lane.

### Validate with current code and pin the bundle commit

The manual publication workflow runs from current trusted `main`, requires an
exact decision-bundle commit, verifies that commit is an ancestor of `main`, and
extracts only the named bundle files from that commit. It does not execute code
from the bundle commit. The operator also supplies the expected decision-ledger
hash.

Validation checks portable paths and checksums, unique decision ids, supported
schema, verify/reject semantics, HTTPS evidence, candidate/source hashes,
product GTIN linkage, normalized nutrition, and a zero-drift match against the
current remote `source_records` row. Any mismatch rejects the whole bundle.

### Apply decisions idempotently and verify postconditions

The publisher generates SQL only after validation. It upserts durable decisions,
resolves the exact review item, and—for verify decisions only—upserts verified
nutrition, generic nutrient values, selected field observations, and the
nutrition evidence outcome. Reject decisions resolve only that candidate and do
not clear independently sourced facts.

The workflow compares expected and applied counts and queries verified facts,
evidence outcomes, durable decisions, and unresolved candidate rows after the
write. Reapplying an identical bundle is a no-op; conflicting reuse of a
decision id fails.

### Reconciliation consults durable candidate decisions

When unchanged candidate evidence is imported again, reconciliation reuses its
active decision. Verified facts are reconstructed from the decision payload if
needed, and rejected candidates are not requeued. If the source content or
candidate hash changes, the prior decision does not apply and a new review is
required.

## Risks / Trade-offs

- **A stale label remains reachable but is no longer current** → Source and
  candidate hashes prevent silent data drift, while the reviewer rationale must
  explicitly attest current packaging; periodic freshness review remains
  necessary.
- **A decision bundle is hand-edited** → Deterministic hashes, schema validation,
  Git review, exact commit pinning, and the protected production environment
  fail closed before D1 writes.
- **Partial SQL application creates inconsistent evidence** → Use D1 batch/file
  execution with explicit transaction boundaries where supported and require
  post-write count checks; preserve the prior bundle for idempotent retry.
- **Thousands of decisions create repository growth** → Bundles contain only
  compact decision JSON, not source responses or images, and are append-only.
- **Validation rules improve after review** → Publication always reruns the
  current validator; decisions that no longer pass require re-review.

## Migration Plan

1. Add the durable decision table without changing existing read behavior.
2. Write decisions during local candidate resolution and prove verify/reject
   semantics with Worker+D1 integration tests.
3. Add deterministic export and bundle-validation fixtures.
4. Make reconciliation reuse unchanged decisions and test replay/drift behavior.
5. Add the manual protected publication workflow and dry-run it with synthetic
   decisions before any real bundle.
6. Export reviewed real candidates, merge the bundle, publish it, and verify live
   coverage deltas.

Rollback stops new publications and deploys the prior Worker. Durable decisions
and evidence remain append-only audit records; a correcting decision supersedes
an active record instead of deleting history.

## Open Questions

- Whether review bundles should later move from Git history to signed release
  assets once decision volume becomes materially large.
- Which organization identity should replace `local_operator` when authenticated
  remote review is eventually introduced.
