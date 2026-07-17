## Why

The completion ledger currently exposes every active product's identity as
outstanding because no operator action can create a source-bound terminal
identity outcome. This makes the global accuracy gate permanently unreachable
even when a current authoritative product page or package label proves the
canonical identity.

## What Changes

- Add an explicit `verify_identity` operator action for any active product from
  the identity completion worklist.
- Require a current HTTPS label or authoritative-source URL and bind each
  identity verification immutably to the exact product, source record, source
  record key, and identity hash reviewed by the operator.
- Project only a still-current identity decision into the existing terminal
  identity outcome; identical retries are idempotent and conflicting decisions
  fail closed.
- Reconcile identity decisions on every source replay, removing a projected
  outcome when its product, source, or identity hash no longer matches current
  evidence and restoring it only from an exact valid decision.
- Require ambiguous `match` and `create_new` resolutions to supply the same
  evidence and create the same exact-bound identity verification; `no_match`
  remains non-terminal for active-product completion.
- Add a focused, accessible verification form to the identity completion
  worklist and show the resulting provenance without treating a GTIN or catalog
  row alone as verified.

## Capabilities

### New Capabilities

- `terminal-identity-evidence`: Evidence-required identity decisions,
  exact-binding validation, terminal projection and drift-safe replay across
  the operator API, completion ledger, and reconciliation pipeline.

### Modified Capabilities

None. The repository has no archived main specs; this capability closes the
identity lifecycle explicitly deferred by the existing completion-ledger
change.

## Impact

- Adds a forward-only D1 migration for immutable identity evidence decisions.
- Affects shared API types, local-only Worker mutations, review resolution,
  source reconciliation, completion-ledger queries, operator dashboard UI, and
  focused Worker/replay/rendered-contract tests.
- Adds no production dependency and does not apply a remote migration, publish
  data, or deploy as part of local implementation.
- Preserves the configured-source-only claim and never infers identity
  verification from GTIN presence, automatic matching, or product activation.
