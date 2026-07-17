## Context

The dashboard currently separates verified facts from review-only extraction
candidates, but D1 does not retain complete extraction accounting. Nutrition and
ingredient extraction artifacts contain one aggregate outcome per GTIN while a
single Robotoff response can reference several label images. Publication imports
staged candidates and discards `no_prediction`, `rejected`, and `failed` rows.

Existing artifacts are not sufficient to repair that gap. They retain source
URLs, Robotoff response JSON, semantic candidate hashes, and artifact checksums,
but not the bytes or SHA-256 digest of each label image. A URL hash, Robotoff
fingerprint, response checksum, or source-record content hash is not a label
content hash. Legacy outcomes therefore cannot become current extraction
evidence without downloading and hashing the exact label bytes.

The completion ledger must remain fail-closed. Extraction outcomes are workflow
evidence that route outstanding work; they do not verify a nutrition or
ingredient fact and cannot prove that information is absent from a label.

## Goals / Non-Goals

**Goals:**

- Persist immutable label assets and extraction attempts for nutrition and
  ingredients with exact source, product, image, byte hash, extractor, request
  schema, run, and artifact provenance.
- Preserve per-image candidate, rejected, failed, and no-prediction accounting
  without losing mixed outcomes behind a GTIN-level aggregate.
- Make artifact validation, import, and replay complete, transactional,
  idempotent, and fail-closed under source or label drift.
- Route one product/family completion row to the highest-priority honest action
  while returning bounded counts for every current and stale label outcome.
- Bind future extraction candidate source content and review decisions to the
  exact label bytes that produced them.

**Non-Goals:**

- Automatically verify model output or infer `not_declared` or
  `not_applicable` from an extraction result.
- Claim that historical v7 nutrition or v2 ingredient artifacts contain label
  byte hashes, or manufacture hashes from their URLs.
- Publish a production migration, deploy the Worker, or import production data
  as part of this local change.
- Store public copies of label image bytes in D1.
- Redesign the three terminal product states (`verified`,
  `terminal_unavailable`, and `outstanding`).

## Decisions

### Model the query, immutable images, and per-image results separately

Migration `0009` adds four related records:

1. `extraction_runs` extends an existing ingestion run with field family,
   request-schema hash, artifact digest, adapter/model metadata, parent source
   snapshot, and accepted/completeness state.
2. `label_evidence_assets` identifies immutable bytes by canonical subject
   source record, product, field family, stable source image identity, requested
   and effective HTTPS URLs, lowercase SHA-256, byte length, media type, and
   fetch time.
3. `extraction_attempts` records the source-complete barcode query, response or
   error evidence hash, aggregate status and counts, reasons, attempt time, and
   whether this accepted attempt is the current one for the subject/family.
4. `extraction_attempt_labels` links requested and prediction images to an
   attempt and records each image's outcome, prediction/candidate/rejection
   counts, conflict flag, reasons, and candidate hashes.

An attempt is not a fact. `candidate`, `no_prediction`, `rejected`, and `failed`
are allowed only in the extraction ledger. The existing `evidence_outcomes`
table remains reserved for human/authoritative terminal decisions.

Alternatives considered:

- Reusing `evidence_outcomes` was rejected because it has terminal semantics and
  one mutable row per product/family.
- One extraction row per GTIN was rejected because it collapses several images
  and mixed outcomes.
- One extraction row with a JSON image array was rejected because D1 cannot
  enforce referential integrity, bounded joins, or exact replay at image level.

### Bind attempts to the canonical subject source and exact label bytes

Every attempt references the canonical Open Food Facts source record that
provided the product context and stores its content hash. A current attempt must
still map to the same active product, subject content hash, selected label set,
and exact label-byte hashes. Same URL with different bytes is drift. Different
URLs with the same bytes are equivalent only when the source image identity or
revision proves they are the same asset.

The stable asset identifier and attempt identifier are deterministic hashes of
their immutable natural keys. Imports use insert-or-ignore followed by exact
equality checks; a key collision with different content aborts the transaction.
Historical rows are never updated or deleted. Only the accepted, fully validated
run advances current pointers after all rows have been inserted successfully.

Candidate source-record content hashes will include the label asset ID and byte
hash. Semantic candidate hashes remain based on normalized candidate values.
That lets existing review decisions remain value-specific while their source
content binding becomes byte-specific.

### Hash images while streaming and retain portable proof

Adapters fetch the exact HTTPS label variant shown to reviewers through a shared
streaming helper. It validates an image media type, rejects an oversized declared
length, hashes each chunk with SHA-256, enforces a hard byte cap, and discards the
chunks. The process uses bounded memory and records requested URL, effective URL,
digest, bytes, media type, and fetch time in a checksummed label ledger.

Extraction workflows retain the portable ledger and checksums. Future replay can
restore those proofs without another upstream request when the complete artifact
identity matches. Image bytes need not enter D1. A missing, malformed,
unfetchable, or oversized label causes the attempt artifact to fail closed and
prevents it from advancing current/source-complete state.

Alternatives considered:

- `arrayBuffer()` was rejected because large images would make memory usage
  proportional to the complete response.
- URL hashes and Robotoff fingerprints were rejected because neither proves the
  exact bytes.
- Re-fetching only during publication was rejected as the sole proof because an
  upstream image can change between extraction and publication.

### Validate complete artifacts before any D1 mutation

Family-specific validators require:

- exact cohort accounting and one subject attempt per eligible source record;
- exact requested/prediction label accounting and a valid SHA-256 for every
  linked current asset;
- matching prediction, candidate, rejection, failure, reason, and staged-record
  counts;
- checksums for responses, cohort, outcomes, labels, staged records, report, and
  manifest;
- current adapter/model and request-schema versions;
- the expected repository, workflow, branch, head SHA, artifact digest, and
  canonical parent OFF snapshot;
- an artifact not listed in the immutable supersession deny policy; and
- zero unexplained or duplicate rows.

The importer writes run, assets, attempts, links, candidate source records, and
reviews in one SQL transaction. Publication pre/postconditions prove exact count
deltas, zero fact or terminal-decision promotion, active-pointer advancement,
and replay idempotence. Failed/incomplete artifacts can remain portable
diagnostics but cannot become an accepted current run.

### Derive completion actions from exact current evidence

The Worker aggregates exact current label outcomes into one product/family row.
Extraction outcomes never change the three product states. Outstanding work uses
this precedence:

1. `evidence_inconsistent`
2. `conflict_resolution`
3. `review_ready`
4. `retry_extraction`
5. `run_extraction`
6. `manual_label_review`
7. `structured_evidence_review`
8. `source_evidence_needed`

`review_ready` requires an exact open candidate review whose source record,
content hash, candidate hash, family, product, attempt, and label asset match.
The primary action points to that candidate review, never a more highly ranked
coverage-gap review. Mixed images use the highest action while returning all
candidate, no-prediction, rejected, failed, unattempted, stale, and conflict
counts.

Verified or terminal-unavailable completion is current only when its provenance
or immutable decision still matches the current source/asset content and no
current material contradiction exists. A failed extra image does not revoke a
matching verified fact, but source coverage remains incomplete until that image
is reconciled.

### Keep the API bounded and the UI explicit

Completion items return a bounded extraction summary and a bounded label list;
larger evidence sets use a paginated detail endpoint. The dashboard presents
action language such as “Retry automated extraction” or “Transcribe label
manually,” never “terminal failed.” Multiple labels render as a semantic list
with ordinal, source time, outcome text, and uniquely named links. Counts and
status are never conveyed by color alone.

## Risks / Trade-offs

- **Label downloads increase extraction time and bandwidth** -> Deduplicate exact
  URLs, retain portable hashes for replay, enforce a byte cap, and keep current
  rate-limited sequencing.
- **The upstream image may change between extraction and review** -> Treat a
  byte mismatch as drift and route to `run_extraction`; never silently reuse the
  old attempt.
- **Legacy artifacts cannot populate the new current lanes** -> Preserve them as
  historical candidate evidence and schedule a fresh bounded label-hash run.
- **Multiple images can multiply query rows** -> Aggregate with fixed set-based
  queries, cap inline assets, paginate detail, and test one-row-per-product
  invariants.
- **An old but valid artifact can overwrite newer evidence** -> Require exact
  lineage/digest policy, deny superseded artifacts, and advance current pointers
  monotonically only after complete validation.
- **A source-content change unrelated to the label can stale an attempt** -> Fail
  closed because serving size, basis, and pack context can change interpretation;
  a replay can quickly restore currency when the evidence is still equivalent.

## Migration Plan

1. Add forward-only local migration `0009` with immutable tables, constraints,
   indexes, and nullable extraction linkage for future evidence decisions.
2. Extend adapters and portable artifact validators; regenerate fixtures and
   prove streaming, tamper rejection, complete accounting, and legacy fail-closed
   behavior.
3. Extend transactional SQL generation, publication lineage checks, replay
   postconditions, and extraction/publication workflows.
4. Extend completion queries, API contracts, and dashboard actions only after
   image-bound attempts exist locally.
5. Run focused tests, full checks, a local release preflight, and browser/a11y
   verification. Commit and push the reviewed local change.
6. Only after fresh production approval, apply pending migrations in order,
   publish a newly generated byte-hash-complete artifact, verify exact production
   postconditions, and deploy the Worker.

Rollback is application-level: stop reading the additive tables and leave their
immutable rows intact. No down migration or destructive data removal is needed.

## Open Questions

- Whether private retention of image bytes in R2 is contractually permitted for
  each source; the initial implementation stores only cryptographic metadata in
  D1 and uses the workflow artifact for portable proof.
- Whether a later extractor should process label images directly instead of
  querying Robotoff by barcode. The ledger supports both without changing its
  terminal evidence semantics.
