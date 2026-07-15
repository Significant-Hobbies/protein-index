## 1. Evidence-aware protein ranking

- [x] 1.1 Return validation-passing discovery metrics for unverified structured nutrition while withholding missing and conflicting values
- [x] 1.2 Make all-food discovery ordered by protein per 100 kcal the dashboard default, retain a protein-cohort scope, and retain verified-only Trusted mode
- [x] 1.3 Emphasize protein per 100 kcal and its evidence state on desktop rows, mobile cards, and product detail
- [x] 1.4 Remove Cloudflare and deployment-provider language from the consumer interface
- [x] 1.5 Add Worker and UI-level tests for default filters, ordering, unavailable inputs, and evidence labels

## 2. Rich Open Food Facts enrichment

- [x] 2.1 Implement a documented multi-code API adapter with stable identification, bounded batches, serialized rate limiting, retry, and resumable artifacts
- [x] 2.2 Parse richer nutrition, ingredients, quantities, images, quality tags, and timestamps into separate source-attributed staged records
- [x] 2.3 Account for every requested barcode as enriched, unchanged, not found, rejected, or failed and fail publication on unexplained gaps
- [x] 2.4 Add fixtures and tests for API omissions, transient failures, resume, nutrition validation, and CSV-to-API enrichment
- [x] 2.5 Add a GitHub Actions enrichment job that starts from the checksummed source-complete barcode set and uploads reviewable artifacts

## 3. Label extraction candidates

- [x] 3.1 Implement a Robotoff prediction parser that retains image, model, confidence, basis, unit, raw entities, and source timestamps
- [x] 3.2 Normalize only explicit per-100-g values or unambiguous per-serving values with a valid serving mass
- [x] 3.3 Create review candidates for valid label extraction and validation items for ambiguous, conflicting, or impossible output
- [x] 3.4 Add tests for multiple-image conflicts, confidence thresholds, unit conversion, serving-basis rejection, and raw-evidence preservation

## 4. Coverage and completion gate

- [x] 4.1 Extend coverage data with structured nutrition, label-image, extraction-candidate, verified, terminal-unavailable, and outstanding counts
- [x] 4.2 Implement a completion check that fails while any active product lacks terminal verified nutrition or ingredient evidence
- [x] 4.3 Surface the completion gate and outstanding evidence counts without conflating source exhaustion with verified completeness
- [x] 4.4 Record the stricter data-completion goal and current blockers in PROJECT_STATUS.md

## 5. Backfill, publication, and release

- [x] 5.1 Run and inspect a bounded live enrichment sample against current official responses
- [x] 5.2 Run the full configured-barcode enrichment and verify checksums, accounting, deltas, and validation outcomes
- [x] 5.3 Publish only a reviewed complete enrichment artifact through the guarded D1 path
- [x] 5.4 Run unit, Worker integration, type, build, OpenSpec, startup, and release-guard checks
- [x] 5.5 Deploy the updated Worker and verify live APIs, default ranking, evidence states, mutation denial, and security headers
- [ ] 5.6 Complete sanctioned desktop/mobile rendered visual and accessibility verification
- [ ] 5.7 Keep this change and the product goal open until the completion gate reports no outstanding unverified product evidence
