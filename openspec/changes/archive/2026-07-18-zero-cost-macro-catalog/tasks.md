## 1. Local macro refresh

- [x] 1.1 Implement a deterministic, non-publishing local refresh orchestrator with run manifests, source outcomes, phase selection, and bounded label queue output.
- [x] 1.2 Add focused orchestration tests for complete, incomplete, and bounded refresh outcomes without network or D1 mutation.
- [x] 1.3 Add a portable local wrapper and macOS launchd template with lock, logs, and user-configured data path.

## 2. Macro-first catalog surface

- [x] 2.1 Remove cost sorting and current-offer fields from consumer catalog projections while preserving evidence storage.
- [x] 2.2 Remove offer and price/cost presentation from catalog and product-detail UI, retaining protein-per-100-calorie as the default comparison.
- [x] 2.3 Clarify source-bounded coverage and evidence-gap language in consumer-facing API/UI surfaces.

## 3. Verification and handoff

- [x] 3.1 Add API, UI, and local-refresh regression coverage for price-free macro comparison and source-bounded outcomes.
- [x] 3.2 Run focused checks, full `pnpm check`, and strict OpenSpec validation.
- [x] 3.3 Document the local no-cost refresh and scheduler install/uninstall flow without changing deployment or publication controls.
