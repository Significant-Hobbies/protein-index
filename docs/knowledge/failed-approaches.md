---
title: Failed approaches
description: Reusable record of approaches that did not work, the symptom that exposed them, and the rule that now prevents them.
---

# Failed approaches

A durable record of approaches that were tried and rejected, the symptom that
exposed them, and the rule that now prevents them. Each entry is sourced from
the durable timeline in [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) or an
OpenSpec change. Add new entries when a fix lands; do not delete historical
ones.

## Treating Open Food Facts parse success as verification

- **Symptom:** Live ranking audit caught contradictory community energy values;
  protein-energy and severe full-macro conflicts produced impossible rankings.
- **Failed approach:** Promoting parsed Open Food Facts nutrition to
  label-verified facts because the import completed.
- **Rule:** Open Food Facts observations remain `unverified`. Conflicts are
  marked and withheld from metrics. See [evidence policy](../product/evidence-policy.md).
- **Source:** `PROJECT_STATUS.md` 2026-07-16 entry; ADR-002.

## Assuming 1 mL weighs 1 g for liquid labels

- **Symptom:** A 70 mL serving mislabeled as 70 g doubled protein and energy
  (Amul Malai Paneer: 50 g serving treated as per-100-g, yielding 624 kcal and
  40 g protein). Cream Pot kulfi candidates were rejected for the same reason.
- **Failed approach:** Converting millilitres to grams without density
  evidence.
- **Rule:** Mass and volume are dimensionally separate. Serving rows
  normalize only from an explicit serving quantity of the same dimension. See
  ADR-006.
- **Source:** `PROJECT_STATUS.md` 2026-07-16 entries; ADR-006.

## Trusting Robotoff's `_100g` keys for volume labels

- **Symptom:** Robotoff's model encoded a photographed per-100-mL column with
  `_100g` keys. The mass-based verified-candidate schema accepted them as
  per-100-g.
- **Failed approach:** Trusting the JSON key shape over the declared basis.
- **Rule:** Volume-label model candidates fail closed when the schema is
  mass-based. Declared basis and the first explicit quantity unit take
  precedence. See ADR-006.
- **Source:** `PROJECT_STATUS.md` 2026-07-16 entries.

## Backfilling total sugar from a serving-column added-sugar value

- **Symptom:** Whyte Farms Paneer had a 0 g added-sugar declaration mapped into
  an undeclared total-sugar field.
- **Failed approach:** Backfilling an absent per-100-g total-sugar field from
  a serving-column sugar value.
- **Rule:** Label normalization refuses to backfill total sugar from serving-
  column sugar. Added sugar must not masquerade as total sugar.
- **Source:** `PROJECT_STATUS.md` 2026-07-16 entries.

## Letting a serving conversion that matches the source anchor verify nutrition

- **Symptom:** Serving-only liquid candidates whose unconverted values matched
  the per-100-g source anchor but whose alleged serving mass created material
  disagreement.
- **Failed approach:** Using the source anchor as a verification path.
- **Rule:** The source anchor can only reject a suspect conversion; it cannot
  promote or verify nutrition. Serving-only candidates fail closed on material
  disagreement.
- **Source:** `PROJECT_STATUS.md` 2026-07-16 entries.

## Unbounded upstream requests consuming the workflow window

- **Symptom:** API enrichment run `29480067998` hit the 120-minute job limit
  on a stalled official-source request.
- **Failed approach:** No per-call timeout on upstream requests.
- **Rule:** 30-second per-call timeout, bounded retries before recursive batch
  splitting, batch progress emission, 240-minute job ceiling with extra time
  only for explicit retries.
- **Source:** `PROJECT_STATUS.md` 2026-07-16 entries.

## `runner.temp` in job-level `env`

- **Symptom:** The automatic router never received the ingredient completion
  event because `runner.temp` is unavailable in job-level `env`.
- **Failed approach:** Referencing `runner.temp` in job-level `env`.
- **Rule:** Evidence initialization uses `RUNNER_TEMP` in the first runner
  step and persists the path through `GITHUB_ENV`. A regression contract test
  covers the invalid context placement.
- **Source:** `PROJECT_STATUS.md` 2026-07-16 entries.

## SQL whitespace compaction inside quoted evidence payloads

- **Symptom:** Pre-publication validation rejected a bundle; quote-aware
  compaction had mangled quoted evidence payloads.
- **Failed approach:** Naive whitespace compaction across the whole SQL
  payload.
- **Rule:** Quote-aware compaction preserves exact strings inside quoted
  evidence. Both the first corrected publication and exact replay prove
  unchanged counts.
- **Source:** `PROJECT_STATUS.md` 2026-07-16 entries.

## Coverage endpoint latency from a full review-queue scan

- **Symptom:** Production coverage timed out; a correlated full review-queue
  scan on the JSON-backed review ledger triggered a D1 CPU reset.
- **Failed approach:** Filtering the growing JSON-backed review ledger without
  indexes.
- **Rule:** Migration `0007` adds status/type/priority and product/source
  indexes. The coverage endpoint batches a single source-bounded candidate
  aggregate. A status-indexed equivalent preserves the exact count while
  reducing query duration from 3.55s to 0.34s.
- **Source:** `PROJECT_STATUS.md` 2026-07-16 entries; migration `0007`.

## Promoting a legacy decision in place when fresh evidence matches

- **Symptom:** Drift audits found historical decisions that semantically
  matched fresh evidence but had stale source envelopes.
- **Failed approach:** Upgrading the legacy decision in place.
- **Rule:** Immutable exact extraction linkage requires a newly reviewed
  decision. The legacy decision is rebound to current source hashes via a new
  bundle, not mutated.
- **Source:** ADR-005; `PROJECT_STATUS.md` drift-audit entries.

## See also

- [Decision log](../architecture/decisions/README.md) for the ADRs that
  codified these rules.
- [Learnings](learnings.md) for cross-cutting operational lessons.
