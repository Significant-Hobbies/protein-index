## 1. Immutable Decision Model

- [x] 1.1 Add a forward D1 migration for immutable exact-bound identity evidence decisions and indexes
- [x] 1.2 Add shared identity decision types, canonical validation, deterministic identity, and idempotency/conflict helpers
- [x] 1.3 Add migration and focused helper tests for valid, malformed, identical, and conflicting decisions

## 2. Worker Mutation and Completion Contract

- [x] 2.1 Add a local-only product identity-verification endpoint that derives and validates the current source binding
- [x] 2.2 Atomically insert the immutable decision and project one verified identity outcome with exact provenance
- [x] 2.3 Require `match` and `create_new` review resolutions to create the same evidence-bound identity verification while preserving `no_match` behavior
- [x] 2.4 Make identity completion require a matching current decision/source/outcome chain and route contradictions to `evidence_inconsistent`
- [x] 2.5 Add Worker+D1 tests for success, validation, idempotency, conflicts, ambiguous resolution atomicity, and completion partition changes

## 3. Drift-Safe Reconciliation

- [x] 3.1 Project exact current identity decisions during source replay without mutating historical decisions
- [x] 3.2 Revoke only the stale source-bound projection and deterministically retain or restore a valid alternate source decision
- [x] 3.3 Add replay tests for unchanged input, identity drift, source relinking, and multiple-source fallback

## 4. Operator Experience

- [x] 4.1 Add typed client support and an accessible source-bound identity verification form to the completion worklist
- [x] 4.2 Refresh coverage and the identity ledger after success, and preserve the outstanding row with a visible error after failure
- [x] 4.3 Add rendered desktop/mobile interaction and accessibility contract tests

## 5. Verification and Handoff

- [x] 5.1 Run focused tests, migration replay, typecheck, full unit and Worker suites, build, and OpenSpec validation
- [x] 5.2 Verify the identity workflow visually on desktop and mobile without horizontal overflow or inaccessible controls
- [ ] 5.3 Update `PROJECT_STATUS.md`, commit, and push the verified local feature while leaving remote migration/deploy pending approval
