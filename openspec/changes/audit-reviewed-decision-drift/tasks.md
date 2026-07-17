## 1. Audit Model and Input Validation

- [x] 1.1 Add typed deterministic report categories, findings, conflicts, provenance, and policy results
- [x] 1.2 Discover and fully validate review bundles, deduplicate identical decision IDs, and detect global ambiguity/conflicts
- [x] 1.3 Validate the selected nutrition or ingredient artifact and independently verify raw evidence, canonical candidates, and exact proof chains

## 2. Drift Classification

- [x] 2.1 Index current artifact candidates and classify each unique historical decision using the specified precedence
- [x] 2.2 Detect product-level verify ambiguity and report current candidates without decisions
- [x] 2.3 Keep redundant nutrition decisions conditional on trusted selected-projection state

## 3. Operator Interface

- [x] 3.1 Add a read-only `data:audit-decisions` CLI with deterministic JSON, concise summary, optional output path, and configurable failure categories
- [x] 3.2 Add the package command and document local and GitHub Actions usage without production writes

## 4. Verification

- [x] 4.1 Add focused tests for validation, duplicate provenance, hard conflicts, ambiguity, exact links, legacy matches, drift, missing candidates, and deterministic output
- [x] 4.2 Run the smallest relevant tests, typecheck, and OpenSpec validation
- [ ] 4.3 Run both family audits against the fresh v8 and v3 artifacts and record the real findings in `PROJECT_STATUS.md`
