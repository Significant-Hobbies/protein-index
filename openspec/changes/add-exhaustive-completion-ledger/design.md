## Context

The coverage endpoint aggregates broad catalog counts but does not expose the
products behind those numbers. Its current independent sums are also not a
safe partition: a stale `evidence_outcomes.outcome = 'verified'` can suppress
an outstanding fact, while a verified fact and unavailable outcome can be
double-counted. Reviews and source records are one-to-many, so joining them
directly to products would multiply ledger rows and has already shown poor D1
instruction behavior in local query-plan experiments.

The dashboard needs a product-by-product route from incomplete counts to the
next evidence action. It must remain honest about the current schema: D1 does
not retain rejected, failed, or no-prediction extraction outcomes, and identity
decisions do not yet create identity completion outcomes.

## Goals / Non-Goals

**Goals:**

- Account for every active product exactly once for a selected field family.
- Make the accounting fail closed when current facts and outcomes disagree.
- Give operators deterministic, mutually exclusive work lanes using only
  evidence that D1 actually retains.
- Keep the endpoint bounded and predictable for the full current catalog.
- Add an attractive, responsive drill-down without duplicating product detail.

**Non-Goals:**

- Claim that configured sources equal the complete Indian food market.
- Infer `not_declared` or `not_applicable` from missing API/OCR values.
- Claim a label was rejected, failed, or produced no prediction when those
  extraction outcomes are not persisted in D1.
- Add terminal-outcome mutation controls or redefine identity verification.
- Materialize a second product ledger or deploy/apply remote migrations.

## Decisions

### Derive one strict state per product and family

A shared completion CTE will classify each active product as `verified`,
`terminal_unavailable`, or `outstanding`. Nutrition and ingredient facts are
verified only when their current status is `verified` and authority is 100.
Unavailable outcomes close a gap only when the corresponding current fact is
not verified and a non-empty evidence URL is present. A stale verified outcome,
an unavailable outcome beside a verified fact, or other fact/outcome mismatch
remains outstanding in `evidence_inconsistent`.

Identity continues to use explicit identity evidence outcomes. Because the
current identity workflow does not write them, the ledger will expose those
rows as outstanding rather than silently treating a GTIN or catalog row as
verified.

This strict CASE expression is the source of truth for both coverage totals and
ledger summaries. It guarantees:

`verified + terminal unavailable + outstanding = active products`

Alternative considered: keep the independent aggregate sums. Rejected because
they can overlap or omit products and therefore cannot prove completion.

### Use honest, mutually exclusive action lanes

Outstanding rows use this precedence:

1. `evidence_inconsistent`
2. `conflict_resolution`
3. `review_ready`
4. `structured_evidence_review`
5. `label_evidence_review`
6. `source_evidence_needed`

The ledger does not name extraction attempt outcomes. A product with a current
family label image and no open candidate is `label_evidence_review` whether the
image has never been processed or an automated attempt was inconclusive. This
is a valid next action without inventing provenance.

Alternative considered: persist extraction outcomes in this change. Rejected
for this slice because publishing every adapter outcome and binding label bytes
is an ingestion capability with its own migration and lifecycle semantics.

### Pre-aggregate one-to-many evidence once

Open reviews and best source evidence are aggregated into one row per product
before joining active products. The list query never uses correlated review
subqueries and never joins raw review/source rows into the paginated result.
Candidate counts are limited to open, source-bound Robotoff nutrition or
ingredient candidate reviews; generic coverage gaps are not candidates.

Alternative considered: per-row scalar subqueries. Rejected after a local
representative query required about ten times the D1 instructions of a single
pre-aggregated review scan.

### Keep page pagination but make ordering deterministic

The endpoint follows existing app contracts with `page` and `pageSize`, capped
at 100, and orders by lane priority, normalized brand, normalized product name,
then product ID. This supports direct page navigation in the current UI while
remaining stable for an unchanged result set.

Alternative considered: introduce cursor pagination immediately. Deferred
because the existing client and APIs use page pagination; evidence decisions
can change rows between any multi-request traversal regardless. The response
includes the latest completed source-run time as source context, not as a
ledger-mutation or publication version.

### Reuse product detail and existing evidence workflows

Ledger rows return a bounded identity/evidence summary, not full product facts.
The dashboard reuses the existing product drawer and links into the evidence
queue where an open review exists. Coverage state cards become real drill-down
controls; desktop uses a compact table and mobile uses stacked cards.

### Add indexes only after query-plan evidence

Migration `0007` already supports the pre-aggregation's `status` filter. The
implementation will record `EXPLAIN QUERY PLAN` coverage and add migration
`0009` only if the final query still scans reviews or needs a temporary plan
that materially increases work. No speculative index is added.

## Risks / Trade-offs

- [Extraction attempt detail is unavailable] -> Use the honest label-review
  lane and plan a separate source/hash-bound extraction-outcome capability.
- [Unavailable outcomes are mutable projections] -> Treat contradictions as
  outstanding and never infer terminal outcomes; add immutable terminal
  decisions in a later evidence-lifecycle change.
- [Identity cannot currently reach verified] -> Expose the real outstanding
  count and retain identity completion as a visible blocker.
- [Offset pagination can drift across evidence decisions] -> Return the latest
  completed source-run time as honest context, use a total deterministic order,
  and reset the UI to page one when filters change. A durable ledger mutation
  version remains a later schema capability.
- [Full-family summary scans all active products] -> Execute a fixed number of
  set-based queries, cap result rows, test query plans, and avoid N+1 work.

## Migration Plan

1. Add the shared classifier/SQL contract and focused tests.
2. Add the read-only API and dashboard drill-downs.
3. Run local migration/query-plan checks; add an index migration only if proven
   necessary.
4. Run full checks, browser/mobile/accessibility verification, and update
   `PROJECT_STATUS.md`.
5. Commit and push the verified local slice. Remote migration/deployment stays
   pending explicit production action.

Rollback is code-only unless a proven index migration is added; an index can be
dropped in a later forward migration. The endpoint is additive and existing
coverage fields remain backward compatible.

## Open Questions

- Persisting exact extraction outcomes and current label-content hashes remains
  a separate ingestion change.
- Immutable `not_declared`/`not_applicable` decisions remain a separate
  evidence-lifecycle change.
- Identity resolution must define and write a terminal identity outcome before
  global completion can become reachable.
