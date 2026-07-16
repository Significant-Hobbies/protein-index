## Context

The catalog and public API already store and display nutrition facts whose basis
is `per_100g`, `per_100ml`, `per_serving`, or `unknown`. The reviewed-label
pipeline is narrower: Robotoff candidates, canonical candidate hashes, review
decisions, replay SQL, and the operator UI all assume a `nutritionPer100g`
payload. The exhaustive volume-safe extraction therefore rejected 2,866 liquid
predictions rather than risk relabeling volume as mass.

The evidence ledger is append-only and existing reviewed mass decisions are
bound to the canonical JSON representation of their candidate. Any global
candidate rename would invalidate those hashes and make exact replay fail. The
database schema already supports `per_100ml`, so this change is an application
compatibility change rather than a data migration.

## Goals / Non-Goals

**Goals:**

- Preserve direct per-100-mL label evidence without converting it to grams.
- Convert per-serving liquid predictions only when the source provides an
  explicit serving volume.
- Carry the exact mass or volume basis through candidate validation, hashing,
  review bundles, publication, provenance, API responses, and operator display.
- Preserve every existing mass candidate hash and reviewed decision.
- Keep basis-invariant protein-per-calorie metrics available for valid liquid
  nutrition.

**Non-Goals:**

- Inferring density or treating one millilitre as one gram.
- Deriving pack protein, cost per protein, or mass-serving metrics from volume
  alone.
- Automatically verifying Robotoff predictions.
- Adding a database migration or a production dependency.
- Backfilling the previously rejected liquid predictions in the same code
  change; a new source-complete extraction artifact will exercise the feature.

## Decisions

### Use a discriminated candidate union without changing mass serialization

Existing mass candidates retain `basis` plus `nutritionPer100g` exactly as they
are serialized today. Volume candidates use `basis` plus
`nutritionPer100ml`. Shared helpers expose the candidate's nutrition values and
normalized database basis to callers.

Renaming both shapes to a generic `nutrition` field was rejected because it
would change canonical hashes for already reviewed evidence. Adding both fields
to every candidate was rejected because it permits ambiguous payloads.

### Treat the value field as the normalization discriminator

`nutritionPer100g` identifies mass-normalized values and
`nutritionPer100ml` identifies volume-normalized values. `basis` retains the
model's origin (`per_100g`, `per_100ml`, or `per_serving`) for review context.
For a per-serving candidate, the chosen value field records whether conversion
used an explicit serving mass or explicit serving volume. Candidate parsing
rejects payloads with both or neither value field, or with an incompatible
basis/value-field combination.

Changing `basis` to only the final database basis was rejected because reviewers
need to see whether values were copied directly or converted from a serving.

### Derive serving volume only from explicit source evidence

The Robotoff API adapter adds `servingSizeMillilitres` to product context by
parsing the retained Open Food Facts serving quantity and unit. Direct
per-100-mL predictions normalize without conversion. Per-serving predictions
normalize to per 100 mL only when `servingSizeMillilitres` is finite and
positive. Ambiguous or absent units remain rejected with a basis-validation
outcome.

Pack quantity, product-name hints, and a 1:1 density assumption were rejected as
conversion sources because none proves the serving volume represented by the
nutrition row.

### Publish the normalized database basis, not the model-origin basis

Verified mass candidates write `nutrition_facts.basis = 'per_100g'` and volume
candidates write `basis = 'per_100ml'`. Every corresponding generic nutrient
row and selected field observation uses the same normalized basis. The original
candidate, including its `per_serving` origin when applicable, remains in the
immutable evidence decision payload.

This prevents a serving-origin candidate from producing a `per_serving` fact
whose numbers have already been normalized to 100 g or 100 mL.

### Keep protein-energy metrics basis invariant and mass economics fail closed

Protein per 100 calories, calories from protein, calories for 25 g protein, and
nutrient-per-protein ratios use quantities sharing the same label basis and
remain valid for per-100-mL facts. Pack protein, protein per rupee, cost per 25 g
protein, and price per serving require compatible pack or serving mass and stay
unavailable when those inputs are absent.

No density conversion is introduced into the metrics layer.

## Risks / Trade-offs

- **Existing hash compatibility regresses** -> Lock legacy mass hashes with
  fixtures and replay existing checked-in review bundles in tests.
- **Robotoff `_100g` field names are mistaken for mass on liquids** -> Use the
  source product's declared nutrition basis as the semantic basis and retain the
  raw model response for review.
- **A serving quantity is parsed with the wrong dimension** -> Reuse the
  dimension-aware quantity parser, require an explicit volume unit, and reject
  ambiguous values.
- **Mass-only callers accidentally read a volume candidate** -> Centralize
  value and normalized-basis access in shared exhaustive helpers rather than
  branching ad hoc in every publisher.
- **Liquid values are valid but economic metrics look incomplete** -> Return
  explicit unavailable reasons instead of fabricated pack-mass comparisons.
- **The change increases candidates but not verified coverage immediately** ->
  Keep model output review-only; verified coverage changes only after an exact
  label review decision is published.

## Migration Plan

1. Add the backward-compatible candidate union and regression fixtures.
2. Update extraction, validation, review, reconciliation, and UI paths.
3. Run unit, Worker+D1, type, build, and immutable review-bundle replay checks.
4. Publish code only after the normal clean-main and green-CI gates.
5. Run a new source-complete Robotoff extraction from the current official
   snapshot; verify terminal accounting and that volume candidates retain
   `nutritionPer100ml`.
6. Review and publish liquid candidates through the existing protected evidence
   workflow.

Rollback is a code rollback before any volume decisions are published. After a
volume decision is published, rollback must retain the union parser so the
append-only evidence ledger remains replayable; volume facts can be withdrawn
by a superseding evidence decision, not by deleting history.

## Open Questions

- Which current liquid candidates will pass exact human label review is an
  evidence question for the next extraction artifact, not an implementation
  assumption.
- Brand-owner density data could later enable mass economics for liquids, but it
  requires a separate provenance and unit-conversion capability.
