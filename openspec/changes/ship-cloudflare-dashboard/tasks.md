## 1. Release design and data behavior

- [x] 1.1 Inspect current catalog API defaults, summary data, and all UI states against the live-snapshot evidence profile.
- [x] 1.2 Add tested dashboard summary and explicit trusted-versus-discovery behavior without weakening verification rules.
- [x] 1.3 Add production runtime metadata and keep anonymous review mutations fail-closed.

## 2. Dashboard experience

- [x] 2.1 Refine the dashboard shell, visual identity, source-health summary, navigation, and responsive hierarchy without new production dependencies.
- [x] 2.2 Refine catalog search, trust controls, desktop comparison table, mobile product cards, empty/error/loading states, and pagination behavior.
- [x] 2.3 Refine product detail so identity, evidence, nutrition, ingredients, metric inputs, provenance, and missing data are scannable and honest.
- [x] 2.4 Keep coverage and review views useful but secondary, with production read-only state clearly communicated.
- [ ] 2.5 Verify keyboard behavior, semantic labels, focus management, contrast, reduced motion, and phone/desktop layout behavior.

## 3. Snapshot publication

- [x] 3.1 Add a publication command that accepts an existing staged snapshot and manifest and validates checksums, continuity, terminal evidence, and accounting before SQL generation.
- [x] 3.2 Add explicit local/remote targets, idempotent import execution, and post-import D1 count verification with tests.
- [x] 3.3 Add a protected/manual GitHub publication workflow that selects a successful source artifact and never makes the weekly retrieval job a direct production write.

## 4. Cloudflare release readiness

- [x] 4.1 Add the guarded repository deploy entrypoint and production preflight covering generated types, checks, build, startup check, and Wrangler dry run.
- [x] 4.2 Validate Wrangler configuration against the installed schema and latest Worker types; replace placeholder bindings only with provisioned resource identifiers.
- [x] 4.3 Update README and PROJECT_STATUS with trust modes, publication commands, resource topology, rollback, and exact deployment gates.

## 5. Verification and deployment

- [x] 5.1 Run unit and Worker tests, type generation/check, production build, Worker startup check, and Wrangler dry run.
- [x] 5.2 Commit and push a clean synced main branch, wait for green CI, and pass the fleet deployment guard.
- [x] 5.3 Confirm Cloudflare identity, create only missing D1 and private R2 resources, apply remote migrations, and verify bindings.
- [x] 5.4 Publish the reviewed complete Open Food Facts snapshot to remote D1 and verify ingestion, product, evidence, and coverage counts.
- [x] 5.5 Deploy the Worker and verify live root, health, catalog, detail, coverage, SPA fallback, and anonymous mutation denial.
- [ ] 5.6 Verify the live dashboard at desktop and mobile widths in the sanctioned in-app browser, then record the deployment URL and residual evidence limitations.
