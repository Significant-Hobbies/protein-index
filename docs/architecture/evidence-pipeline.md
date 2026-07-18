---
title: Evidence pipeline
description: The path from a raw source row to a verified, published fact, and every fail-closed gate along the way.
---

# Evidence pipeline

The pipeline is a chain of fail-closed gates. Each stage either produces a
checksummed, auditable artifact or stops the run. No stage silently promotes
unverified data to verified.

## Stages

### 1. Source staging (`source-sync`)

- Streams the official Open Food Facts TSV export to exhaustion (no search-API
  discovery).
- Records compressed input hash, byte size, upstream `Last-Modified`, and
  end-of-file evidence.
- Reconciles every India-tagged row to either a staged product or an
  exclusion-ledger entry with reason codes and evidence hash.
- Fails before publishing a new continuity baseline if the snapshot is empty,
  capped, incomplete, corrupt, or more than 20% below the last complete
  snapshot.
- Output: checksummed staged-products + exclusion-ledger artifact. No D1 write.

### 2. Enrichment (`enrich-open-food-facts`)

- Runs on the exact source-complete barcode set from a successful source-sync.
- Multi-code batches, identifies the client, stays within the documented search
  limit, retries transient failures, splits persistent failures, resumes from
  saved response artifacts.
- Separately accounts for enriched, unchanged, not-found, rejected, and failed
  barcodes.
- Bounded: 240-minute job ceiling, 30-second per-call timeout, bounded retries
  before recursive batch splitting, official single-product endpoint fallback.
- Output: checksummed richer-response artifact. No D1 write.

### 3. Label extraction (`extract-robotoff`, `extract-robotoff-ingredients`)

- Runs on every source product with a nutrition/ingredient label image.
- Resumable per barcode; identifies the client; observes the documented request
  limit; records every eligible barcode exactly once as candidate, no-prediction,
  rejected, or failed.
- Bounded networking: 30-second per-image deadline, byte and chunk limits,
  same-run validated asset reuse across transient retry passes.
- Basis-safe: volume labels (`per_100ml`) and mass labels (`per_100g`) remain
  dimensionally separate. Unitless sodium is rejected, not assumed grams.
- Output: checksummed candidate artifact + immutable extraction outcome ledger.
  No D1 write. Model output never becomes verified nutrition.

### 4. Human review (`review-decisions/`)

- An operator reviews the current label image against the exact normalized
  candidate.
- Verification applies that exact candidate with its provenance. Rejection
  isolates the candidate from existing facts.
- Corrected nutrition transcription preserves the original candidate and stores
  the reviewed projection separately.
- Decisions are bundled into checksummed, commit-pinned bundles under
  `review-decisions/`. The active set is `review-decisions/active-bundles.json`;
  historical/superseded bundles remain immutable on disk for audit history.
- Output: committed review bundles. No D1 write yet.

### 5. Drift audit (`pnpm data:audit-decisions`)

- Before any publication, audit the checked-in active decision set against one
  exact, checksum-validated artifact.
- Read-only; suitable for GitHub Actions. Validates the full artifact and each
  bundle, collapses identical historical copies, fails closed on conflicting
  decision identities or inconsistent exact proof.
- Reports drift plus current candidates that still need review. A legacy
  decision that semantically matches fresh evidence is never upgraded in place.
- Output: drift report. No D1 write.

### 6. Publication (manual dispatch + explicit confirm)

- A separately dispatched workflow revalidates the artifact, source/cohort
  accounting, portable checksums, immutable run identity, and authority
  boundary before generating idempotent SQL.
- Refuses pending migrations. Community observations remain unverified; model
  output remains review-only; reviewed decisions are never accepted from the
  fresh-evidence path.
- Writes idempotent D1 import, queries product/run/source-record counts,
  records exact pre/post state and live health/catalog checks for 90 days.
- Output: D1 evidence ledger updated. Replay is idempotent.

## Cache and replay rules

- The reusable cache key is the **source snapshot plus request schema**, not
  the parser adapter version. Parser-only changes replay retained raw
  responses and rebuild all candidates under current code.
- A changed source snapshot fetches current responses; a request-schema
  mismatch is rejected and fetched again.
- A failed extraction diagnostic is never publishable, but its label-byte
  hashes may be used as a download cache when an exact set of conditions match
  (immutable GitHub archive digest, exact producer workflow and failed step,
  default-branch ancestry, source snapshot, request schema, current adapter,
  complete barcode partition, bounded failure reasons, canonical asset IDs,
  current source subjects). Any cache mismatch falls back to downloading.
- Extraction retry caching requires a prior terminal non-failed outcome before
  reusing an exact API response. Failed, missing, and incomplete outcomes
  refetch on the next pass.

## See also

- [Operations / jobs](../operations/jobs/README.md) for the per-workflow
  reference.
- [Publication runbook](../operations/runbooks/publication.md) for the
  step-by-step operator procedure.
- [Failed approaches](../knowledge/failed-approaches.md) for the cases that
  produced these gates.
