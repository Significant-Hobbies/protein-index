---
title: Decision log
description: Durable architectural decisions that shape Protein Index.
---

# Decision log

These architectural decision records state the durable decision and its reason.
They are listed roughly in dependency order, not chronological order. The
repository is retired, so historical planning artifacts have been removed;
`PROJECT_STATUS.md`, these ADRs, and the implementation remain authoritative.

## ADR-001 — Canonical product is not a retailer listing

**Decision:** The product record is canonical and GTIN-first. Retailer
listings, offers, and ratings are observations attached to that record, never
the source of identity by themselves.

**Why:** Indian protein-product data is fragmented across brand labels, open
catalogs, and retailer listings that disagree about identity, nutrition, pack
size, price, and ratings. A trustworthy normalization core must keep product
identity separate from retailer observations or the product produces
precise-looking but invalid comparisons.

## ADR-002 — Four independent evidence states

**Decision:** Nutrition and ingredients each have independent states:
`missing`, `unverified`, `verified`, `conflict`. Non-verified nutrition is
excluded from trusted rankings by default.

**Why:** Source completeness is not nutrition accuracy. Completing an import
does not verify the contributed values.

## ADR-003 — Producer and publication are strictly separated

**Decision:** Successful producer workflows retain checksummed artifacts but do
not trigger a credentialed D1 write. Publication is always a separate, explicitly
dispatched workflow with hard confirmation input.

**Why:** Defense in depth. The producer path has no production credentials; the
publication path revalidates everything before any write. This prevents a
runaway producer from promoting unverified data.

See also [publication runbook](../../operations/runbooks/publication.md).

## ADR-004 — Model output is review-only, never auto-verified

**Decision:** Robotoff and any model output enters the review queue and never
becomes verified nutrition by itself. Extraction confidence alone never
increases verified coverage.

**Why:** OCR and vision-language models can transcribe accurately but also
invent text. Verification requires a human reviewer (or, for the machine lane,
an evidence-grade acceptance contract, not a confidence threshold).

## ADR-005 — Append-only, source/hash-bound evidence decisions

**Decision:** Evidence decisions are append-only, bound to exact source content
and canonical candidate hashes. Verified/rejected replay is idempotent. Source
drift revokes trust; a legacy decision is never upgraded in place.

**Why:** Auditability and replay safety. The same checksummed artifact must be
replayable through the protected workflow after investigation without double-
counting or silently changing decisions.

## ADR-006 — Mass and volume are dimensionally separate

**Decision:** Mass candidates use `per_100g`; liquid candidates use `per_100ml`.
Serving rows normalize only from an explicit serving quantity of the same
dimension. Millilitres are never converted to grams without density evidence.

**Why:** A 70 mL serving mislabeled as 70 g doubles protein and energy. Robotoff
can encode a photographed per-100-mL column with `_100g` keys. Treating these as
interchangeable produces physically impossible facts.

See also [failed approaches](../../knowledge/failed-approaches.md).

## ADR-007 — Strict Trusted gate requires three-way agreement

**Decision:** Trusted products require exact-current identity, authority-100
verified nutrition, and terminal ingredient evidence, all agreeing.
Contradictions fail closed.

**Why:** A product with verified nutrition but stale identity, or verified
nutrition but missing terminal ingredients, is not a trustworthy comparison
target. The gate is conjunctive, not best-effort.

## ADR-008 — Bounded residual extraction, fail-closed accounting

**Decision:** A publishable extraction artifact retains at most 10 and at most
0.25% residual label failures, and only allow-listed post-response failures.
Upstream model/API failures, unknown reasons, incomplete accounting, or either
exceeded bound remain run-fatal.

**Why:** Complete outcome accounting is separate from verification
completeness. A run that silently drops failures hides evidence gaps. The
bounds are small enough to surface real problems and large enough to tolerate
transient label-host errors.

## ADR-009 — Cache key is source snapshot + request schema, not adapter version

**Decision:** The reusable response cache key is the source snapshot plus
request schema. Parser-only changes replay retained raw responses and rebuild
all candidates under current code. A request-schema mismatch is rejected and
fetched again.

**Why:** Lets us fix parser bugs without re-downloading the entire source,
while preventing a schema change from silently serving stale responses.

See also [evidence pipeline](../evidence-pipeline.md).

## ADR-010 — Official brand discovery is a no-cost, robots-respecting lane

**Decision:** Add a no-cost ingestion lane for explicitly configured official
Indian brand sitemaps, with robots-policy checks and bounded, resumable
traversal. Unmatched products become discovery records, not canonical facts.

**Why:** The Open Food Facts India slice under-represents protein snacks and
newer products. Broadening discovery must not treat a retailer page, inferred
nutrition, or unverified market signal as canonical.

## How to add an entry

Do not add entries while the project is retired. After explicit reactivation,
record each durable architecture decision here with its reason and keep
`PROJECT_STATUS.md` synchronized.
