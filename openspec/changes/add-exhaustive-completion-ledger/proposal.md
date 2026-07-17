## Why

Coverage totals currently say how many active products are incomplete, but they
do not expose an exhaustive, reachable worklist explaining what evidence exists
and what must happen next. That makes the completion gate impossible to operate
or audit product by product even though nutrition and ingredient accuracy are
the product's core promise.

## What Changes

- Add a paginated completion-ledger API that accounts for every active product
  across identity, nutrition, and ingredients exactly once per field family.
- Classify outstanding work into deterministic action lanes: review ready,
  conflict resolution, label extraction needed, and source evidence needed;
  preserve verified and evidence-backed unavailable terminal states distinctly.
- Return current fact state, terminal outcome, label/source evidence links, and
  open-review/candidate counts without promoting unverified data.
- Add family, state, and lane filters with deterministic ordering and bounded
  page sizes suitable for the full catalog.
- Make coverage totals and ledger counts share one accounting contract, proving
  `verified + terminal unavailable + outstanding = active products` for every
  field family.
- Add dashboard drill-downs from completion cards into a dense, responsive,
  accessible operator worklist with direct product, evidence, and review paths.
- Add focused D1 indexes only where query-plan evidence shows the exhaustive
  ledger needs them; do not add a materialized shadow ledger or dependency.

## Capabilities

### New Capabilities

- `exhaustive-completion-ledger`: Product-by-product completion accounting,
  action-lane classification, API pagination, invariants, and dashboard
  drill-downs for identity, nutrition, and ingredients.

### Modified Capabilities

None. The repository has no archived main specs yet; existing coverage response
fields remain backward compatible.

## Impact

- Affects D1 completion queries and indexes, `worker/coverage.ts`, a new bounded
  Worker route/module, shared API types, the client API, coverage dashboard UI,
  responsive styles, Worker+D1 tests, and `PROJECT_STATUS.md`.
- Adds no production dependency and does not apply a remote migration or deploy
  as part of implementation.
- Does not claim market completeness, manufacture missing evidence, or turn a
  catalog row into a verification task without a traceable evidence state.
