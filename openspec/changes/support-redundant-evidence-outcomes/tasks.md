## 1. Evidence contract

- [x] 1.1 Add a backward-compatible `redundant` decision type and canonical parser while preserving legacy bundle bytes.
- [x] 1.2 Add exact selected-projection matching helpers for product, basis, all supported values, source content, and candidate hash.
- [x] 1.3 Add focused tests for exact matches, null/value differences, basis/product/source drift, and invalid redundant payloads.
- [x] 1.4 Add and test a forward-compatible evidence-decision table rebuild that permits nutrition redundancy while preserving existing rows, constraints, and indexes.

## 2. Decision, publication, and replay

- [x] 2.1 Extend the local review transaction to accept redundancy only against the currently selected authority-100 projection and resolve only the bound review item.
- [x] 2.2 Extend immutable bundle preparation, protected publication, postconditions, and dry-run validation with zero fact-write invariants.
- [x] 2.3 Make reconciliation replay redundant decisions idempotently and reopen evidence after source, candidate, product, basis, or selected-fact drift.
- [x] 2.4 Add Worker+D1 and publication tests proving terminal review changes without nutrient, observation, outcome, or verified-coverage changes.

## 3. API and operator experience

- [x] 3.1 Expose redundant decisions, their matched projection, and provenance through review/history API types without counting them as additional verification.
- [x] 3.2 Add an explicit operator action and confirmation state that is available only for an exact duplicate projection.
- [x] 3.3 Render redundant evidence distinctly in desktop and mobile review/history surfaces with accessible labels and no verified-count inflation.

## 4. Exhaustion and delivery

- [x] 4.1 Validate every checked-in legacy review bundle, run focused tests and `pnpm check`, and prove local unchanged replay.
- [x] 4.2 Complete rendered desktop/mobile and accessibility verification before deployment; do not migrate or publish evidence as part of the code change.
- [ ] 4.3 After compatible code is deployed separately, create source-bound redundant decisions for the two Coca-Cola images and one Local soda image and publish them through protected postconditions.
- [ ] 4.4 Re-audit the exact 258-record artifact to prove all records terminal, update `PROJECT_STATUS.md`, validate and archive the change, and publish the green repository state.
