## 1. Completion Accounting

- [x] 1.1 Add shared completion family, state, lane, item, summary, filter, and response contracts.
- [x] 1.2 Implement one strict mutually exclusive state classifier and lane precedence for identity, nutrition, and ingredients.
- [x] 1.3 Refactor coverage totals and completion status to use the strict accounting contract and expose contradictions/snapshot context backward compatibly.

## 2. Completion Ledger API

- [x] 2.1 Implement set-based D1 ledger summary and page queries with pre-aggregated open reviews and deterministic source evidence.
- [x] 2.2 Add validated `/api/completion-ledger` family, state, lane, search, page, and bounded page-size filters.
- [x] 2.3 Inspect the final D1 query plan and add a focused index migration only if existing indexes do not support the bounded query.

## 3. Dashboard Drill-down

- [x] 3.1 Add the typed client request and App state for filtered, paginated completion rows.
- [x] 3.2 Turn coverage totals into semantic family/state/lane controls with the exact accounting equation and snapshot context.
- [x] 3.3 Build dense desktop and one-column mobile worklist views with evidence/review actions and existing product-drawer integration.
- [x] 3.4 Add accessible loading, error, result-count, focus, status, and pagination behavior without color-only meaning.

## 4. Verification

- [x] 4.1 Add classifier and Worker tests for exact partitions, stale/contradictory evidence, all lanes, inactive exclusion, and cross-endpoint agreement.
- [x] 4.2 Add Worker tests for validation, deterministic pagination, no join multiplication, and bounded query behavior.
- [x] 4.3 Run focused tests, typecheck, full check, strict OpenSpec validation, and release preflight.
- [x] 4.4 Verify the dashboard in desktop and mobile browsers, including keyboard/accessibility behavior and evidence/product drill-downs.
- [x] 4.5 Update `PROJECT_STATUS.md` with shipped local behavior, measured counts, remaining extraction/terminal/identity gaps, and production blockers.

## 5. Publication

- [x] 5.1 Commit and push the verified implementation without applying remote migrations or deploying.
- [ ] 5.2 After explicit production approval, apply all pending migrations, deploy, and prove live coverage/ledger invariants before marking the feature complete.
