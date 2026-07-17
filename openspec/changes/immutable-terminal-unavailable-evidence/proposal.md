## Why

The completion ledger can display `not_declared` and `not_applicable`, but those
states currently come from one mutable row in `evidence_outcomes`. There is no
review workflow that proves who inspected which current source or exact label,
and a later upsert can erase the history. That makes terminal-unavailable data
the remaining weak link in an otherwise immutable evidence system.

## What Changes

- Add append-only, source/hash-bound decisions for nutrition or ingredients
  that are explicitly `not_declared` or `not_applicable`.
- Let an operator choose only a server-enumerated current source record or exact
  retained label asset; arbitrary URLs are not accepted as proof.
- Derive terminal completion from the current immutable decision chain and use
  `evidence_outcomes` only as a deterministic projection/cache.
- Fail closed on source drift, product relinking, contradictory decisions, or a
  coexisting verified/conflicting fact, while retaining a valid alternate
  source decision when one source drifts.
- Add a bounded local-only review API and accessible completion-worklist action
  for recording and inspecting terminal evidence.

## Scope

**In scope:** nutrition and ingredient terminal decisions, exact source and
label bindings, append-only supersession, deterministic projection, replay,
completion-ledger integration, local operator UI, and focused migration/API/UI
tests.

**Out of scope:** inferring absence from OCR/API omissions; identity outcomes;
automated decisions; authentication or multi-review approval; production
migration, publication, or deployment.

## Impact

- Adds one forward D1 migration and a local mutation endpoint.
- Changes completion classification to require a current immutable terminal
  decision rather than trusting a naked projected outcome.
- Existing verified outcomes and legacy terminal rows remain visible but do not
  satisfy the strict completion gate until backed by a valid decision.
- Production remains unchanged until separately approved migration and deploy.
