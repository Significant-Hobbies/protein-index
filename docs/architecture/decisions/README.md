---
title: Decision log
description: Index of the architectural decisions that shape Protein Index, with pointers to the full OpenSpec proposals.
---

# Decision log

This is a distilled index of the architectural decisions (ADRs) that shape
Protein Index. Each entry states the decision, the reason, and points to the
full OpenSpec proposal under [`openspec/changes/`](../../../openspec/changes/)
for the original context. Decisions are listed roughly in dependency order, not
chronological order.

The full proposal, design, and task breakdown for each change live in
`openspec/changes/<slug>/{proposal,design,tasks}.md`. Archived changes live in
`openspec/changes/archive/` and their distilled spec in
`openspec/specs/<slug>/spec.md`.

## ADR-001 — Canonical product is not a retailer listing

**Decision:** The product record is canonical and GTIN-first. Retailer
listings, offers, and ratings are observations attached to that record, never
the source of identity by themselves.

**Why:** Indian protein-product data is fragmented across brand labels, open
catalogs, and retailer listings that disagree about identity, nutrition, pack
size, price, and ratings. A trustworthy normalization core must keep product
identity separate from retailer observations or the product produces
precise-looking but invalid comparisons.

**Source:** [`openspec/changes/build-catalog-core/proposal.md`](../../../openspec/changes/build-catalog-core/proposal.md)

## ADR-002 — Four independent evidence states

**Decision:** Nutrition and ingredients each have independent states:
`missing`, `unverified`, `verified`, `conflict`. Non-verified nutrition is
excluded from trusted rankings by default.

**Why:** Source completeness is not nutrition accuracy. Completing an import
does not verify the contributed values.

**Source:** [`openspec/changes/build-catalog-core/proposal.md`](../../../openspec/changes/build-catalog-core/proposal.md); see also [evidence policy](../../product/evidence-policy.md).

## ADR-003 — Producer and publication are strictly separated

**Decision:** Successful producer workflows retain checksummed artifacts but do
not trigger a credentialed D1 write. Publication is always a separate, explicitly
dispatched workflow with hard confirmation input.

**Why:** Defense in depth. The producer path has no production credentials; the
publication path revalidates everything before any write. This prevents a
runaway producer from promoting unverified data.

**Source:** [`openspec/changes/automate-fresh-catalog-publication/proposal.md`](../../../openspec/changes/automate-fresh-catalog-publication/proposal.md); see also [publication runbook](../../operations/runbooks/publication.md).

## ADR-004 — Model output is review-only, never auto-verified

**Decision:** Robotoff and any model output enters the review queue and never
becomes verified nutrition by itself. Extraction confidence alone never
increases verified coverage.

**Why:** OCR and vision-language models can transcribe accurately but also
invent text. Verification requires a human reviewer (or, for the machine lane,
an evidence-grade acceptance contract, not a confidence threshold).

**Source:** [`openspec/changes/add-label-evidence-extraction/proposal.md`](../../../openspec/changes/add-label-evidence-extraction/proposal.md), [`openspec/changes/automated-label-verification/proposal.md`](../../../openspec/changes/automated-label-verification/proposal.md).

## ADR-005 — Append-only, source/hash-bound evidence decisions

**Decision:** Evidence decisions are append-only, bound to exact source content
and canonical candidate hashes. Verified/rejected replay is idempotent. Source
drift revokes trust; a legacy decision is never upgraded in place.

**Why:** Auditability and replay safety. The same checksummed artifact must be
replayable through the protected workflow after investigation without double-
counting or silently changing decisions.

**Source:** [`openspec/changes/add-reviewed-evidence-publication/proposal.md`](../../../openspec/changes/add-reviewed-evidence-publication/proposal.md), [`openspec/changes/exact-label-decision-reattestation/proposal.md`](../../../openspec/changes/exact-label-decision-reattestation/proposal.md).

## ADR-006 — Mass and volume are dimensionally separate

**Decision:** Mass candidates use `per_100g`; liquid candidates use `per_100ml`.
Serving rows normalize only from an explicit serving quantity of the same
dimension. Millilitres are never converted to grams without density evidence.

**Why:** A 70 mL serving mislabeled as 70 g doubles protein and energy. Robotoff
can encode a photographed per-100-mL column with `_100g` keys. Treating these as
interchangeable produces physically impossible facts.

**Source:** [`openspec/changes/support-volume-nutrition-evidence/proposal.md`](../../../openspec/changes/support-volume-nutrition-evidence/proposal.md); see also [failed approaches](../../knowledge/failed-approaches.md).

## ADR-007 — Strict Trusted gate requires three-way agreement

**Decision:** Trusted products require exact-current identity, authority-100
verified nutrition, and terminal ingredient evidence, all agreeing.
Contradictions fail closed.

**Why:** A product with verified nutrition but stale identity, or verified
nutrition but missing terminal ingredients, is not a trustworthy comparison
target. The gate is conjunctive, not best-effort.

**Source:** [`openspec/changes/immutable-terminal-unavailable-evidence/proposal.md`](../../../openspec/changes/immutable-terminal-unavailable-evidence/proposal.md), [`openspec/changes/terminal-identity-evidence/proposal.md`](../../../openspec/changes/terminal-identity-evidence/proposal.md).

## ADR-008 — Bounded residual extraction, fail-closed accounting

**Decision:** A publishable extraction artifact retains at most 10 and at most
0.25% residual label failures, and only allow-listed post-response failures.
Upstream model/API failures, unknown reasons, incomplete accounting, or either
exceeded bound remain run-fatal.

**Why:** Complete outcome accounting is separate from verification
completeness. A run that silently drops failures hides evidence gaps. The
bounds are small enough to surface real problems and large enough to tolerate
transient label-host errors.

**Source:** [`openspec/changes/accounted-extraction-exceptions/proposal.md`](../../../openspec/changes/accounted-extraction-exceptions/proposal.md), [`openspec/changes/persist-extraction-outcome-ledger/proposal.md`](../../../openspec/changes/persist-extraction-outcome-ledger/proposal.md).

## ADR-009 — Cache key is source snapshot + request schema, not adapter version

**Decision:** The reusable response cache key is the source snapshot plus
request schema. Parser-only changes replay retained raw responses and rebuild
all candidates under current code. A request-schema mismatch is rejected and
fetched again.

**Why:** Lets us fix parser bugs without re-downloading the entire source,
while preventing a schema change from silently serving stale responses.

**Source:** [`openspec/changes/add-ingredient-label-extraction/proposal.md`](../../../openspec/changes/add-ingredient-label-extraction/proposal.md); see also [evidence pipeline](../evidence-pipeline.md).

## ADR-010 — Official brand discovery is a no-cost, robots-respecting lane

**Decision:** Add a no-cost ingestion lane for explicitly configured official
Indian brand sitemaps, with robots-policy checks and bounded, resumable
traversal. Unmatched products become discovery records, not canonical facts.

**Why:** The Open Food Facts India slice under-represents protein snacks and
newer products. Broadening discovery must not treat a retailer page, inferred
nutrition, or unverified market signal as canonical.

**Source:** [`openspec/changes/official-brand-discovery/proposal.md`](../../../openspec/changes/official-brand-discovery/proposal.md), [`openspec/changes/protein-branded-discovery/proposal.md`](../../../openspec/changes/protein-branded-discovery/proposal.md).

## How to add an entry

1. Write the proposal under `openspec/changes/<slug>/` using the `spec-driven`
   skill.
2. After the change ships and the spec is archived, add a distilled entry here
   with the decision, the reason, and a link to the proposal.
3. Keep entries to ~10 lines. The proposal is the source of truth; this log is
   an index.
