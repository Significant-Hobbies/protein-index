## Context

Current label candidates are intentionally review-only. A local benchmark found
that macOS Vision OCR transcribed two nutrition labels correctly, including
qualifiers, while a 32B local vision-language model reproduced the nutrition
tables but invented words in an ingredient declaration that was curved and
partially obscured. This design therefore treats the local model as evidence,
not an authority.

## Goals / Non-Goals

**Goals:**

- Automate only facts supported by current, immutable label bytes.
- Make every automatic decision reproducible from an image hash, extractor
  versions, prompt hash, normalized outputs, and deterministic validators.
- Fail closed for partial images, conflicting outputs, unavailable text, and
  non-nutrition fields.
- Keep the ingestion lane local and cost-free at inference time.

**Non-Goals:**

- Inferring ingredients, nutrients, allergens, product identity, or values not
  visibly declared on a label.
- Replacing official manufacturer/GS1 sources when available.
- Making retailer offers, ratings, or current availability automatic.
- Claiming human or manufacturer verification for machine-derived facts.

## Decisions

### Two independent extraction paths

macOS Vision OCR is the deterministic primary text extractor because it is
fast, local, and performed best in the benchmark. Qwen3-VL 32B Instruct is the
independent image-aware cross-check. The pipeline normalizes only formatting
differences (for example `per 100g` to `per_100g`); it never repairs a word or
numeric value. A model-only path is rejected because the benchmark confused
energy units on a smaller model and hallucinated obscured ingredient text on a
larger model.

### Field-family-specific acceptance

Nutrition is eligible only when both paths produce the same declared basis and
all required core values, both values occur in the OCR text, label text is not
edge-clipped, and existing macro/calorie/unit validation passes. Ingredients
are eligible only when both paths locate a bounded `INGREDIENTS` declaration,
the declaration starts and ends visibly within the image, and normalized text
agrees exactly. Missing or conflict fields remain missing; they do not block
the publication of separately accepted nutrition.

### Distinct evidence status and provenance

Introduce `machine_verified` rather than reusing `verified`. Each accepted
fact records image content SHA-256, current label revision, OCR engine/version,
model identifier/digest, prompt hash, two raw outputs, normalized result, and
validator version. Consumer UI describes this as “machine-verified from label”
and retains the exact label evidence link. Existing human-reviewed facts keep
their current `verified` state and authority.

### Local job boundary and durable artifacts

The extractor runs in a local command (and later a self-hosted GitHub Actions
runner only if one exists). It writes checksummed artifacts; D1 receives only
accepted projections and concise provenance, not model weights or raw images.
Image hashes cache attempts so identical bytes are never reprocessed.

## Risks / Trade-offs

- [Shared OCR/model error] → Require literal OCR-token support, independent
  agreement, image-boundary checks, and nutrition arithmetic validation.
- [Curved/cropped ingredient declaration] → Require visible start/end bounds
  and exact agreement; otherwise preserve a missing ingredient fact.
- [Local model drift] → Pin model digest and prompt hash in each artifact;
  rerun a fixed benchmark before model upgrades.
- [High local hardware demand] → Run Qwen only on images prequalified by OCR;
  cache by content hash and cap concurrency at one model invocation.
- [Status confusion] → Keep human `verified` and `machine_verified` separate
  in API/UI filtering and never combine them as one trust tier.

## Migration Plan

1. Add types, schema/provenance, and validators without publishing facts.
2. Implement a local benchmark command with fixed known labels and an
   acceptance report.
3. Run a dry extraction artifact over retained label images; publish nothing
   until the report meets the exact acceptance threshold.
4. Enable guarded, idempotent publication of accepted machine evidence only.
5. Roll back by disabling the publisher; retained artifacts and facts remain
   image-bound and can be invalidated on label revision drift.

## Open Questions

- Whether CI has an approved self-hosted macOS runner; GitHub-hosted runners
  cannot execute the local model without a paid/managed machine.
- The benchmark threshold and size required before a machine-verified release.
- Whether product detail UI needs a separate machine-evidence filter or a
  compact provenance badge.
