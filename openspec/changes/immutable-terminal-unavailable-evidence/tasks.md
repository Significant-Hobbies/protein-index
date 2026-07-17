## 1. Immutable decision contract

- [x] 1.1 Add a forward D1 migration for append-only nutrition/ingredient terminal evidence decisions, supersession edges, and current-decision indexes.
- [x] 1.2 Add shared canonical types and validation for outcomes, exact source/label bindings, idempotency, and same-lineage supersession.
- [x] 1.3 Add migration and helper tests for valid decisions, malformed evidence, replay, conflicting corrections, and immutable history.

## 2. Local review and projection

- [x] 2.1 Add a bounded endpoint that enumerates exact current source and label evidence for one product and family.
- [x] 2.2 Add a local-only terminal-decision endpoint that re-derives the binding and atomically inserts the decision plus deterministic projection.
- [x] 2.3 Derive projection fallback across agreeing sources and fail closed when valid sources disagree.
- [x] 2.4 Add Worker+D1 tests for source evidence, label bytes, replay, supersession, contradictions, and mutation denial.

## 3. Replay and completion truth

- [x] 3.1 Reconcile current terminal decisions after source replay without mutating or deleting historical rows.
- [x] 3.2 Make completion exact-join current immutable terminal decisions and treat legacy naked projections as inconsistent/outstanding.
- [x] 3.3 Prove source drift, label drift, product relinking, alternate-source fallback, verified-fact contradiction, and exact family accounting.

## 4. Operator experience

- [x] 4.1 Add typed client contracts for eligible evidence, terminal decisions, history, and structured errors.
- [x] 4.2 Add an accessible completion-worklist evidence picker with outcome definitions, rationale, confirmation, and stale/contradictory history.
- [x] 4.3 Refresh coverage and ledger state after success while preserving the outstanding row and entered rationale after failure.
- [x] 4.4 Add responsive UI/API contract tests for source evidence, exact labels, terminal states, contradictions, and remote mutation denial.

## 5. Verification and delivery

- [x] 5.1 Run focused migration, domain, Worker, reconciliation, completion, and UI tests, then full type/test/build checks.
- [x] 5.2 Complete rendered desktop/mobile interaction and accessibility verification without horizontal overflow or console errors.
- [ ] 5.3 Update `PROJECT_STATUS.md`, validate and archive the OpenSpec change, commit and push the green local feature, and leave production migration/deploy pending explicit approval.
