## Context

Nutrition evidence decisions currently store a canonical Robotoff candidate as
their payload and bind it to the source content hash and candidate hash. A
verification publishes those exact model values; any omission or error forces a
rejection even when the reviewer can read the complete package label. This is
especially costly for per-100-mL evidence: 30 of the first 40 reviewed images
were rejected, commonly because sodium or fibre was omitted or a per-serving
row was normalized incorrectly.

The decision ledger is append-only. Existing decisions and 47 checked-in review
bundles must retain their canonical JSON and hashes. The database already stores
mass and volume nutrition bases and `evidence_decisions.payload_json` is a JSON
envelope, so corrected transcription can be added without a schema migration.

## Goals / Non-Goals

**Goals:**

- Let a human reviewer transcribe every supported value visible on the exact
  bound label and explicitly select `per_100g` or `per_100ml`.
- Preserve the original model candidate, candidate hash, source content hash,
  and image as immutable evidence.
- Publish the reviewed projection atomically through local review, immutable
  bundles, protected publication, and reconciliation replay.
- Preserve byte-for-byte compatibility for existing candidate-only decisions.
- Make corrections visible and auditable in the operator UI, API, field
  provenance, and evidence outcome.

**Non-Goals:**

- Automatically correcting model output or verifying OCR without a person.
- Inferring density, converting between grams and millilitres, or deriving
  undeclared nutrients.
- Expanding the supported projection beyond the current eight calorie/macro
  fields in this change.
- Applying a production migration or publishing reviewed decisions as part of
  the code change.

## Decisions

### Add an optional reviewed projection without changing legacy payloads

Candidate-only decisions retain their current payload exactly. A corrected
nutrition decision uses an envelope containing the original canonical
`candidate` plus a `reviewedProjection` discriminated by `per_100g` or
`per_100ml`. Shared helpers return the effective projection: the reviewed one
when present, otherwise the original candidate values.

Replacing every payload with a new envelope was rejected because it would
invalidate existing canonical JSON. Mutating the candidate itself was rejected
because it would sever the candidate hash from the model evidence.

### Keep candidate hash and source hash as the publication binding

The decision remains bound to the original candidate hash, source record, source
content hash, product, GTIN, and evidence image. The reviewed projection is
canonicalized inside the decision ledger and therefore covered by the bundle
checksum. Publication fails if the source or original candidate drifts.

A second hash for the reviewed projection is unnecessary because the existing
decision ID, canonical ledger line, and bundle checksum already bind its exact
contents.

### Use an explicit fixed-field reviewed projection

The corrected shape contains an explicit physical basis and all eight supported
keys: calories, protein, carbohydrate, sugar, fat, saturated fat, fibre, and
sodium. Calories and protein must be finite numbers; every other field is a
finite non-negative number or explicit `null`. Both physical bases, missing
keys, non-finite values, negative values, and dimension conversion are rejected.

The UI requires the reviewer to attest through the rationale that every
supported declaration was transcribed and undeclared fields were left null.
The system cannot infer from pixels whether a declaration was overlooked, so
the exact image remains visible beside the form.

### Corrected transcription is verification-only

A reviewed projection is accepted only with a `verify` decision. Rejections
retain the unchanged candidate as their payload and rationale. This avoids
creating corrected data that is never selected and keeps rejection semantics
compatible.

### Publish one effective projection everywhere

Local Worker transactions, review SQL generation, reconciliation replay,
nutrition facts, generic nutrient rows, selected field observations, evidence
outcomes, API detail, and metrics all use the same shared effective-projection
helper. Every selected row receives the reviewed basis and authority 100 in the
same transaction.

Ad hoc branching in each publisher was rejected because mass/volume and legacy/
corrected combinations would drift.

### Present candidate and reviewed values side by side

The operator UI pre-fills an editable reviewed projection from the candidate,
lets the reviewer select mass or volume basis, highlights changed fields, and
shows explicit nulls. Submission uses a separate corrected-verification action;
the existing exact-candidate verification remains available.

## Risks / Trade-offs

- **A reviewer mistypes a label value** → require side-by-side image and
  candidate display, explicit basis, field validation, changed-field summary,
  rationale, and confirmation before submission.
- **Existing bundles stop parsing** → preserve the legacy payload variant and
  run every checked-in immutable bundle through regression tests.
- **A correction is applied after source drift** → retain exact source and
  candidate binding and fail publication before any write.
- **Mass and volume are confused** → use a discriminated reviewed projection,
  never expose a density conversion, and render the selected basis prominently.
- **A later code rollback cannot read published corrections** → do not publish
  corrected decisions until the compatible reader is deployed; any rollback
  after publication must retain the corrected-payload parser.

## Migration Plan

1. Add backward-compatible decision parsing, canonicalization, validation, and
   effective-projection helpers with legacy bundle fixtures.
2. Update local review, publication SQL, reconciliation, API, and UI paths.
3. Run focused unit/Worker tests, all immutable bundle validation, typecheck,
   build, and a local exact-replay proof.
4. Publish code only after normal CI and rendered dashboard verification.
5. Create corrected decisions from exact images, then publish through the
   existing protected source/hash and postcondition workflow.

Before any corrected decision is published, rollback is a normal code revert.
After publication, rollback must keep the corrected-decision reader and effective
projection helper so append-only evidence remains replayable.

## Open Questions

- Full micronutrient transcription should reuse this envelope pattern later,
  but requires a separate generic nutrient editor and validation spec.
- Dual-review or four-eyes approval may be appropriate for high-traffic products
  after reviewer identity and authentication are added; it is not required for
  the current local operator workflow.
