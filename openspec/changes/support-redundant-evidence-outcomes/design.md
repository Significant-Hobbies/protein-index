## Context

Review decisions are bound to an exact source record, source-content hash,
candidate hash, product, GTIN, and evidence image. Verification writes selected
product facts; rejection resolves only the candidate. Three remaining liquid
candidates exactly match projections already verified from different images for
the same products, so neither existing outcome models their evidence truthfully.

## Goals / Non-Goals

**Goals:**

- Terminate exact duplicate evidence without changing selected facts.
- Fail closed unless the candidate projection exactly equals an active verified
  projection for the same product, field family, and physical basis.
- Preserve append-only decisions, immutable bundles, replay, and source drift
  behavior across existing and new outcomes.

**Non-Goals:**

- Fuzzy or tolerance-based duplicate matching.
- Treating conflicting images, variants, or historical label revisions as redundant.
- Publishing the three decisions or changing live facts in this code change.

## Decisions

### Add a third evidence decision, not a special rejection rationale

`redundant` is a first-class terminal decision. Encoding it as rejection would
make audits claim valid evidence was invalid; encoding it as verification would
repeat product-level writes and weaken one-product/one-selected-projection
invariants.

### Validate against selected authority-100 facts at decision time and replay

The system reconstructs the candidate's normalized projection and requires
canonical equality with the currently selected verified nutrition projection
for the same product and basis. All supported keys, including explicit nulls,
must match. Approximate numeric equality was rejected because label revisions
and conversion differences are meaningful evidence conflicts.

### Resolve the review item without writing product facts

Publication records the append-only decision and marks only the bound review
item resolved. It MUST NOT insert nutrient facts, field observations, or replace
the existing evidence outcome/provenance. Replay revalidates redundancy; source
or selected-fact drift dismisses trust and reopens the evidence for review.

### Keep legacy bundles byte-compatible

Existing verify/reject payloads and canonical lines do not change. The parser
accepts the new decision value only with the duplicate-match invariant, and
bundle checksums cover it normally.

## Risks / Trade-offs

- **Selected facts later change** → replay revalidates exact equality and reopens
  stale redundant evidence instead of silently preserving the terminal state.
- **Two similar variants share a GTIN incorrectly** → require existing canonical
  product and source bindings; identity conflicts remain separate review work.
- **Coverage counts overstate verification** → redundant outcomes count as
  terminal review evidence, never as additional verified products or facts.
- **Concurrent publication changes selected facts** → validate and write inside
  the existing atomic transaction and fail before decision insertion on mismatch.

## Migration Plan

1. Add backward-compatible types, validation, replay, and transaction behavior.
2. Add bundle/publication and Worker+D1 regression coverage, including all
   immutable legacy bundles.
3. Add operator/API display and exact local replay proof.
4. Deploy compatible code only after rendered verification; then create and
   separately publish the three redundant decisions through protected gates.

Rollback before redundant publication is a normal code revert. After publication,
rollback must retain the redundant-decision parser and no-op replay behavior.

## Open Questions

- Ingredient evidence can reuse the same exact redundant outcome later, but the
  first implementation should prove nutrition semantics on the three audited
  liquid records.
