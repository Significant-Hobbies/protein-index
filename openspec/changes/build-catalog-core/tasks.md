## 1. Runtime foundation

- [x] 1.1 Scaffold the pnpm Vite + React + Cloudflare Worker project with typed build, test, and check scripts.
- [x] 1.2 Add only the documented React, Hono, Cloudflare Vite, Worker, and test dependencies and record their purpose.
- [x] 1.3 Configure local-only D1/R2 bindings, SPA asset routing, generated Worker types, and CI without provisioning cloud resources.

## 2. Catalog persistence

- [x] 2.1 Add the initial D1 migration for sources, runs, records, products, nutrition, observations, offers, ratings, and review items.
- [x] 2.2 Add constraints and indexes for normalized GTIN, source identities, idempotency hashes, search fields, and unresolved review work.
- [x] 2.3 Add an evidence-rich local fixture source and a repeatable seed/import command.

## 3. Domain correctness

- [x] 3.1 Implement GTIN normalization/check-digit validation and conservative text/quantity normalization with unit tests.
- [x] 3.2 Implement nutrition basis normalization, anomaly validation, and verification-state transitions with unit tests.
- [x] 3.3 Implement marketed and nutrition-derived protein classification with versioned evidence and unit tests.
- [x] 3.4 Implement named protein, price, serving, nutrient, and completeness metrics with unavailable reasons and unit tests.
- [x] 3.5 Implement exact-GTIN and conservative exact-composite entity resolution plus ambiguous review suggestions with unit tests.
- [x] 3.6 Implement raw and normalized ingredient parsing, ordered components, allergens/additives, verification states, and unit tests.

## 4. Source ingestion and freshness

- [x] 4.1 Define the provider adapter contract, source authority metadata, manifest format, and staging record schema.
- [x] 4.2 Implement a streaming Open Food Facts TSV/JSONL bulk-export adapter that retains India-tagged foods and emits normalized staged records and reports.
- [x] 4.3 Implement an explicitly disabled DataKart adapter that documents required commercial configuration without accepting or printing secrets.
- [x] 4.4 Implement idempotent reconciliation into local D1 with run accounting, source evidence, confidence precedence, and review-item creation.
- [x] 4.5 Add CLI commands for bounded fixture/sample sync, validation-only runs, staged output, and local apply.
- [x] 4.6 Add end-of-source coverage accounting, source-completeness proof, gap reporting, and no-cap production traversal.

## 5. Worker API

- [x] 5.1 Add health and bounded catalog-search endpoints with classification, verification, category, completeness, sort, and pagination filters.
- [x] 5.2 Add product-detail endpoint with provenance, metrics, source-specific offers/ratings, and unavailable reasons.
- [x] 5.3 Add review-queue list and durable resolution endpoints with structured validation, conflict, not-found, and internal errors.
- [x] 5.4 Add focused Worker API tests against the local D1-compatible test path.

## 6. Operator and search experience

- [x] 6.1 Build a dense accessible catalog page with trusted defaults, search/filter controls, evidence badges, and comparable metric columns.
- [x] 6.2 Build product detail that explains classification, nutrition verification, metric inputs, completeness, offers, ratings, and provenance.
- [x] 6.3 Build review queue and resolution controls that preserve evidence and clearly distinguish ambiguous identity from nutrition conflict.
- [x] 6.4 Add responsive empty, loading, error, missing, unverified, verified, and conflict states.

## 7. Scheduled official-source path

- [x] 7.1 Add weekly and manual GitHub Actions source-sync workflow with concurrency, timeouts, caching, client identification, and artifact retention.
- [x] 7.2 Make the workflow fail closed on empty/materially reduced input and upload snapshot manifest, staged data, hashes, and validation report.
- [x] 7.3 Document DataKart registration/integration inputs and the protected future apply step without configuring credentials or production writes.
- [x] 7.4 Prove scheduled mode cannot use the local sample cap and reports incomplete traversal as failure.

## 8. Verification and handoff

- [x] 8.1 Run migration and seed twice to prove schema validity and idempotency.
- [x] 8.2 Run domain/API tests, TypeScript checks, production build, and a bounded live Open Food Facts sample sync.
- [ ] 8.3 Verify catalog, detail, and review flows in the browser at desktop and mobile widths.
- [x] 8.4 Update README and PROJECT_STATUS with exact local commands, implemented features, source confidence behavior, and remaining external blockers.
- [ ] 8.5 Validate and archive the completed OpenSpec change only after every requirement and task is evidenced.
