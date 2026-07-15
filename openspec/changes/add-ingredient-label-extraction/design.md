## Context

The catalog currently has 5,246 community ingredient statements and zero
verified ingredient statements. A substantial subset of active products retains
an ingredient-label image, but no bounded pipeline extracts or reviews those
images. Robotoff's official ingredient detector exposes `ner` predictions from
the `ingredient_detection` model with the source image, exact OCR entity text,
confidence, language, bounding box, parsed ingredients, and known/unknown
counts. Live samples demonstrate that even very high entity confidence can
contain material OCR errors, so model output is evidence, not verification.

The nutrition evidence path already provides resumable official-source
collection, immutable source records, review items, candidate hashes, durable
verify/reject decisions, deterministic bundles, and protected D1 publication.
Ingredients should extend that architecture without weakening its fail-closed
or public read-only boundaries.

## Goals / Non-Goals

**Goals:**

- Exhaust every distinct valid GTIN with a retained ingredient-label image in a
  selected source-complete snapshot and account for every terminal outcome.
- Preserve enough official Robotoff evidence to reproduce and audit each
  candidate without treating OCR or parser output as authoritative.
- Let an operator compare the label image, exact extracted text, and parsed tree,
  then verify exact label text, correct OCR against the visible label, or reject
  the candidate.
- Persist and replay exact evidence-bound ingredient decisions, while reopening
  review when the source record or candidate changes.
- Publish reviewed ingredient evidence through the existing commit-pinned,
  checksummed, protected production lane and prove its exact effects.
- Keep the project completion gate red until every active product has terminal
  verified ingredient evidence and the other completion families are also
  complete.

**Non-Goals:**

- Infer an ingredient statement from product names, similar products, category
  averages, nutrition, or brand marketing.
- Automatically verify text because model confidence is high, most ingredients
  are recognized, or community text agrees.
- Claim that a Robotoff prediction represents the newest package without a
  human current-label attestation.
- Verify allergens or precautionary declarations that are not visibly supported
  by the reviewed label evidence.
- Add public production mutations, generic third-party OCR, or a new production
  dependency.

## Decisions

### Query the official image-prediction API and retain raw outcomes

The collector queries the official Robotoff image-prediction endpoint by GTIN
with `type=ner` and `model_name=ingredient_detection`. The eligible cohort is
the sorted set of distinct, valid configured GTINs whose selected product record
has an HTTPS ingredient-image URL. Each GTIN reaches exactly one terminal
accounting state: candidate, no prediction, rejected, or failed after bounded
retry.

Responses and outcomes are written as resumable per-GTIN artifacts. A manifest
records the selected source snapshot, cohort hash, counts, request policy, model
distribution, start/end timestamps, and file checksums. Exact outcome counts
must equal the input cohort before an artifact can be published.

Alternative: request every catalog GTIN. Rejected because the official model
operates on packaging images and image-less requests add rate and ambiguity
without increasing label evidence.

### Represent extraction and reviewer-confirmed text separately

An immutable ingredient candidate contains:

- prediction id, normalized barcode, image id and HTTPS image URL;
- model name/version and observation timestamp;
- exact entity text and entity confidence;
- detected language and confidence;
- finite bounding box coordinates;
- parsed ingredient tree and total/known/unknown counts returned by Robotoff.

Its SHA-256 candidate hash covers a canonical version of all those fields. A
verify decision additionally contains `reviewedText`, which is the exact text
the human can read on the label. It may equal the extracted text or contain
explicit OCR corrections. The original candidate remains unchanged, and the
decision rationale records why a correction was necessary. Normalized
ingredients are derived deterministically from `reviewedText`, never substituted
from the model's parsed tree.

Alternative: make the reviewer accept or reject the OCR text byte-for-byte.
Rejected because it would force clearly readable OCR mistakes to remain wrong
or discard otherwise usable current label evidence.

### Fail malformed candidates and surface uncertainty without erasing evidence

Candidate admission requires a matching valid GTIN, HTTPS Open Food Facts image,
the expected ingredient model, valid timestamps, a non-empty reasonably bounded
entity, a finite in-range confidence at or above the configured admission
threshold, language metadata, finite bounding box, and internally consistent
ingredient counts. The threshold and collection policy are recorded in the
manifest.

A low recognized-ingredient fraction is a warning, not an automatic rejection,
because Indian ingredient names may be absent from Robotoff's taxonomy. Parsed
tree/count discrepancies, multiple materially different candidates, current
community disagreement, and low language confidence raise visible review
warnings. Exact duplicate candidates may collapse by candidate hash; different
text or images remain distinct and cannot be bulk-approved.

### Extend the durable decision family with a forward migration

A new migration rebuilds `evidence_decisions` so `field_family` accepts both
`nutrition` and `ingredients`, preserving all existing rows and indexes. Shared
decision types become a discriminated union. Nutrition payloads remain valid and
unchanged; ingredient payloads bind the immutable candidate plus reviewed text.

This keeps replay, audit, bundle, and publication semantics consistent across
evidence families. A separate ingredient-only decision table was considered but
rejected because it would duplicate candidate uniqueness, source drift, export,
and publication rules.

### Apply verified ingredients as source-linked facts

A verified ingredient decision atomically upserts the exact `reviewedText` into
`ingredient_statements` with verified/high/authority-100 status, rebuilds that
source's `product_ingredients` rows using the deterministic local parser, selects
an `ingredients.raw` field observation, records an ingredient evidence outcome,
and resolves only the matching review item. Derived additive or allergen rows
may be written only when the deterministic parser can trace them to exact text;
their evidence status remains distinguishable from the verified raw statement.

A rejection resolves only that candidate. It does not delete community
ingredients, mark ingredients absent, or create terminal `not_declared` or
`not_applicable` evidence.

### Replay only exact decisions and invalidate drifted trust

Reconciliation reuses an active ingredient decision only when source id/key,
source-record id, source content hash, product id, candidate hash, and field
family all match. An unchanged verify decision reconstructs missing verified
facts; an unchanged rejection stays resolved. A changed source record,
prediction, image, extracted text, or reviewed candidate invalidates the match,
downgrades stale selected ingredient facts to conflict, removes the stale
verified ingredient outcome, and opens a new review item.

### Extend bundles and protected publication compatibly

Review bundle schema evolves to a discriminated nutrition/ingredients union.
Readers remain compatible with existing nutrition-only bundles. Validation
recomputes candidate hashes, validates reviewed text and deterministic parsing,
checks exact remote source-record content, and rejects the whole bundle on any
error. Current trusted `main` code, an ancestor commit pin, expected ledger hash,
explicit remote confirmation, and protected environment approval remain
mandatory.

Postconditions are field-family aware: ingredient publication checks durable
decisions, verified statements, normalized rows, field observations, evidence
outcomes, and unresolved matching review items. Reapplying identical decisions
is idempotent.

### Keep completion distinct from extraction coverage

The dashboard reports ingredient-image cohort extraction, review, and verified
coverage separately. A complete extraction run does not improve the verified
count by itself. Product ingredient completion requires an active, non-drifted
terminal evidence outcome (`verified`, `not_declared`, or `not_applicable`) for
every active product. The project-level goal remains incomplete while identity,
nutrition, or ingredients have any outstanding product.

## Risks / Trade-offs

- **High-confidence OCR is wrong** → Never auto-verify; show the image beside
  exact OCR and require reviewer-confirmed text.
- **Reviewer corrections become untraceable** → Preserve immutable extracted
  text, corrected reviewed text, candidate hash, rationale, reviewer, and time.
- **Robotoff coverage is sparse** → Account no-prediction outcomes explicitly
  and retain them as gaps for manual label transcription or authoritative feeds.
- **Indian ingredient names lower taxonomy recognition** → Treat the known
  fraction as a warning rather than a hard correctness proxy.
- **Multiple package images disagree** → Keep distinct candidates and require
  explicit human selection; never select solely by upload or model timestamp.
- **A table rebuild loses decisions** → Copy and count all existing rows in a
  forward-only migration, recreate indexes, and prove nutrition replay in D1
  integration tests before remote migration.
- **Mixed bundles regress nutrition publication** → Preserve schema-1 readers,
  add nutrition-only regression fixtures, and fail unknown field families closed.
- **Reviewed labels later become stale** → Source/candidate drift reopens review;
  expose evidence observation/verification dates and add an explicit freshness
  policy before claiming time-bounded market currency.

## Migration Plan

1. Add ingredient candidate types, canonical hashing, validation fixtures, and a
   bounded official live sample without changing production data.
2. Add resumable extraction, exact cohort accounting, manifests, checksums, and
   a manually triggered GitHub workflow; validate a bounded artifact first.
3. Add the forward D1 decision migration and prove row preservation plus existing
   nutrition behavior with Worker+D1 integration tests.
4. Add reconciliation, evidence-first review UI, verify/correct/reject decisions,
   replay, and drift invalidation locally.
5. Extend deterministic bundles and protected publication with backward-
   compatible nutrition fixtures and ingredient postconditions.
6. Run and validate the complete ingredient-image cohort, publish only its
   reviewed source records, then review and publish a bounded real decision set.
7. Verify exact live coverage deltas, perform desktop/mobile/accessibility review,
   and deploy only after the existing release guard passes.

Rollback stops new ingredient publications and deploys the previous Worker.
Durable decisions remain append-only audit evidence; a correcting decision
supersedes an active record rather than deleting history. If the migration itself
fails validation, no remote publication proceeds and the prior database remains
the source of truth.

## Open Questions

- What evidence-age policy should define "current label" once enough reviewed
  history exists to measure package turnover by category?
- Whether a future authenticated reviewer should annotate Robotoff upstream as
  well as recording the local evidence decision.
- Whether separately photographed allergen declarations need their own evidence
  family instead of remaining derived or review warnings.
