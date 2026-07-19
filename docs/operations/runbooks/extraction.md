---
title: Extraction runbook
description: Recover from a failed or partial Robotoff label extraction run, and reason about cache reuse and replacement artifacts.
---

# Extraction runbook

Label extraction runs are terminal, exhaustively accounted diagnostics. A
failed run is never publishable, but its retained artifacts can be reused under
exact conditions to avoid re-downloading thousands of label images.

## When a run fails

1. **Read the outcome ledger, not the workflow conclusion.** A run that the
   workflow marks failed may still have retained successful response and
   label-asset artifacts. The outcome ledger partitions every requested
   barcode into exactly one of candidate, no-prediction, rejected, or failed
   (`ExtractionLabelOutcome` in [`shared/api.ts`](../../../shared/api.ts); the
   status enum is `EXTRACTION_OUTCOME_STATUSES` in
   [`shared/extraction-outcomes.ts`](../../../shared/extraction-outcomes.ts)).
   The completion worklist additionally tracks unattempted and stale label
   counts, but those are worklist state, not outcome-ledger partitions.
2. **Check the residual set.** A publishable artifact retains at most 10 and
   at most 0.25% residual label failures, and only allow-listed post-response
   failures (e.g. `label_http_error`, `label_declared_size_exceeded`). If the
   residual set exceeds either bound or contains non-allow-listed reasons, the
   artifact is not publishable and a replacement run is required.
3. **Do not promote failures.** A failed outcome creates no nutrition,
   ingredient, identity, or unavailable fact. It remains visible as
   outstanding retry work and outside Trusted.

## Cache reuse rules

A failed extraction diagnostic is never publishable, but its label-byte hashes
may be used as a download cache **only when all** of the following match:

- the immutable GitHub archive digest,
- the exact producer workflow and failed step,
- default-branch ancestry,
- the source snapshot,
- the request schema,
- the current adapter,
- the complete barcode partition,
- bounded failure reasons,
- canonical asset IDs, and
- current source subjects.

Any cache mismatch falls back to downloading the label again. The current
adapter still rebuilds every attempt, outcome, candidate, checksum, and
decision audit.

Extraction retry caching requires a **prior terminal non-failed outcome**
before reusing an exact API response. Failed, missing, and incomplete outcomes
refetch on the next pass; candidate, no-prediction, and rejected outcomes
retain deterministic reuse.

## Running a replacement exhaustive extraction

A replacement run is required when:

- the residual set exceeds the bounds,
- a parser/adapter change alters candidate hashes, or
- the source snapshot changed.

Dispatch the relevant `extract-robotoff` or
`extract-robotoff-ingredients` workflow with the exact `source_run_id` and
optional `expected_input_hash`. The run:

- restores retained responses and label assets where the cache key matches,
- re-downloads only incomplete evidence,
- emits bounded one-minute progress heartbeats with barcode, outcome,
  response, and label-proof counters,
- reserves fifteen minutes of job-time headroom and retains partial label-proof
  diagnostics on failure,
- accounts for every requested barcode exactly once.

## When a parser-only change ships

The reusable cache key is the source snapshot plus request schema, **not** the
adapter version. A parser-only change replays retained raw responses and
rebuilds all candidates, label proofs, and attempt ledgers under current code.
A request-schema mismatch is rejected and fetched again. A changed source
snapshot fetches current responses.

## Known unsafe runs (do not reuse)

The project has explicitly denied certain historical adapter-v5/v6 workflow
runs and artifacts because they did not retain the fetched label bytes or
produced physically impossible facts. The denied set is recorded in
[`PROJECT_STATUS.md`](../../../PROJECT_STATUS.md). Do not attempt to reuse or
republish superseded artifacts; always run a fresh adapter-v8 (nutrition) or
adapter-v3 (ingredient) extraction from a current source snapshot.

> **Unresolved:** the exact list of denied run IDs is live state. Cross-check
> `PROJECT_STATUS.md` before reusing any historical artifact.

## See also

- [Evidence pipeline](../../architecture/evidence-pipeline.md) for the full
  stage chain and cache rules.
- [Publication runbook](publication.md) for what to do once a publishable
  artifact exists.
- [Failed approaches](../../knowledge/failed-approaches.md) for the cases that
  produced these rules.
