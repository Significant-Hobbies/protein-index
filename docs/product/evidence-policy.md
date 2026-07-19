---
title: Evidence policy
description: The four evidence states, trust boundaries, and the rules that govern promotion and revocation.
---

# Evidence policy

Nutrition and ingredients have independent states. Source completeness is
separate from nutrition accuracy, and extraction outcome accounting is separate
from verification completeness.

## Evidence states

Each of nutrition and ingredients is in exactly one of:

- `missing` — no usable observation exists.
- `unverified` — a source supplied a plausible observation.
- `verified` — a reviewer verified the current package label or an approved
  authoritative source under an explicit policy.
- `conflict` — plausible observations disagree and require review.

A fifth nutrition-only state, `machine_verified`, exists for the offline
automated label-verification lane. It must never claim human or brand
verification. It is typed as `NutritionEvidenceStatus = EvidenceStatus |
"machine_verified"` in [`shared/api.ts`](../../shared/api.ts) (the base
four-state `EvidenceStatus` lives in
[`shared/types.ts`](../../shared/types.ts)). See
[automated-label-verification](../../openspec/changes/automated-label-verification/proposal.md).

## Trust boundaries

- **Trusted** requires exact current identity, authority-100 verified
  nutrition, and terminal ingredient evidence. Contradictions fail closed.
- **Discovery** requires structured nutrition that passes validation. Community
  evidence stays visibly unverified. Missing or conflicting values are
  withheld.
- Failure-only products remain outstanding and outside Trusted. A failed
  extraction is not positive or negative evidence and does not revoke separate
  exact-current verified or terminal evidence for the same product.

## Non-promotion rules

- Open Food Facts observations remain `unverified`. Completing an import does
  not verify them.
- Robotoff records remain review-only candidates with no selected facts.
- Extraction confidence alone never increases verified coverage.
- Existing verified rows cannot be overwritten by fresh evidence, and verified
  counts cannot increase through the fresh-evidence publication path.
- A legacy decision that semantically matches fresh evidence is never upgraded
  in place: immutable exact extraction linkage requires a newly reviewed
  decision.

## Physical basis

Reviewed label evidence preserves its physical basis:

- Mass candidates use per 100 g.
- Liquid candidates use per 100 mL.
- Serving rows are normalized only from an explicit serving quantity of the
  same dimension.
- Millilitres are never converted to grams without separate density evidence.
- Protein per 100 calories remains comparable across both mass and volume
  bases; pack-mass and price metrics stay unavailable without compatible mass
  evidence.

## Source/hash binding

Verified decisions are bound to exact source content and canonical candidate
hashes. Source drift revokes verified trust. Identity evidence must match the
current source URL or exact retained current-label bytes; GTIN or catalog
presence alone never marks identity verified.

## See also

- [Sources](sources.md) for per-source trust posture.
- [Decision log](../architecture/decisions/README.md) for the ADRs behind
  fail-closed publication and immutable evidence.
- [`shared/types.ts`](../../shared/types.ts) for the canonical type
  definitions of `EvidenceStatus` and evidence records.
