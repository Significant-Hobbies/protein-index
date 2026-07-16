## Why

The exhaustive nutrition-label run rejected 2,866 liquid-product predictions because reviewed candidates can represent only mass-normalized nutrition. Milk, lassi, shakes, yoghurt, protein water, sauces, and similar products need first-class per-100-mL evidence so accurate labels are not discarded or incorrectly treated as grams.

## What Changes

- Add a volume-specific reviewed nutrition candidate shape that preserves per-100-mL values without changing hashes for existing mass candidates.
- Normalize direct per-100-mL Robotoff evidence and per-serving volume evidence only when an explicit serving volume is available; never assume density or convert millilitres to grams.
- Teach evidence validation, review bundles, reconciliation, local review mutation, and provenance publication to persist verified liquid nutrition with `basis = 'per_100ml'`.
- Display the exact candidate basis in the operator UI and keep protein-per-calorie metrics available because they are basis-invariant.
- Keep pack-mass, serving-mass, cost-per-protein, and price-per-serving metrics unavailable when their required mass inputs do not exist.
- Preserve all existing reviewed mass decisions and candidate hashes unchanged.

## Capabilities

### New Capabilities

- `volume-nutrition-evidence`: Basis-safe extraction, review, verification, publication, and display of per-100-mL nutrition evidence.

### Modified Capabilities

None. The repository has no archived main specs; earlier change-local mass-only requirements remain historical context.

## Impact

- Affects shared nutrition-candidate types and hashing, Open Food Facts staging context, Robotoff parsing, review decision SQL, reconciliation, Worker review mutation, dashboard candidate rendering, tests, README, and `PROJECT_STATUS.md`.
- Uses the existing `nutrition_facts.basis` and `nutrient_values.basis` columns; no schema migration or new production dependency is required.
- Changes future liquid-label artifacts and review candidates only. Existing mass evidence, reviewed decisions, API routes, and database rows remain compatible.
