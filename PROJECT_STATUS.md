# Protein Index — PROJECT STATUS

Last updated: 2026-07-16

## Why / What

Protein Index is a normalized Indian protein-product intelligence database. It
turns fragmented catalog, label, retailer, and brand data into comparable
canonical products with source-aware nutrition, offers, ratings, confidence,
and protein-value metrics.

**Users:** Indian shoppers comparing protein foods, and operators reviewing or
correcting product data.

**IN scope:** broad ingestion of Indian food records; canonical GTIN-based
products; separate marketed and nutrition-derived protein classification;
verified nutrition; raw and normalized ingredients, allergens, and additives;
configured-source coverage accounting; source-specific offers and ratings;
provenance and confidence; deterministic protein and value metrics;
entity-resolution and nutrition-conflict review.

**OUT of scope for the first release:** claiming complete Indian-market
coverage; collapsing retailer ratings into one score; unlicensed permanent
copies of retailer content; autonomous acceptance of ambiguous product matches;
ONDC integration; purchasing or checkout.

**Completion gate:** deployment is not completion. The product remains
incomplete until every active product has terminal verified identity, nutrition,
and ingredient evidence, or a current label/authoritative source explicitly
establishes that a field is not applicable or not declared. Every configured
source must also reconcile without unexplained gaps, and the rendered dashboard
must pass desktop/mobile verification.

## Dependencies

### External

- Open Food Facts exports for bootstrap catalog and label data
- GS1 India DataKart commercial access and API terms for authoritative,
  near-real-time brand-owner catalog data (planned official source)
- Retailer-authorized APIs or evaluated data providers for current offers and ratings (planned)
- Cloudflare Workers, D1, and private R2 for the hosted application (deployment
  authorized; minimal resources are provisioned during the guarded release)

### Internal

- Fleet standards and release controls in `../AGENTS.md`

## Timeline

- 2026-07-15 — private repository created; core MVP specification and implementation started
- 2026-07-15 — local catalog, D1 ingestion, Worker API, operator UI, source-complete Open Food Facts adapter, and scheduled sync workflow implemented
- 2026-07-15 — durable match/create-new/keep-unmatched identity decisions implemented and proven across import replay
- 2026-07-15 — 20 domain/ingestion tests and 7 Worker+D1 integration tests passing; live three-record India sample staged without inventing missing nutrition
- 2026-07-15 — first exhaustive Open Food Facts workflow completed: 4,535,553 rows traversed, 21,188 India-tagged rows found, and 17,732 valid product records staged
- 2026-07-15 — continuity and exclusion proof completed in GitHub Actions run `29420495106`: 17,732 unchanged staged records plus 3,456 auditable exclusions reconcile all 21,188 India-tagged rows
- 2026-07-15 — responsive evidence-first dashboard, strict trusted/discovery modes, guarded release preflight, and reviewed-snapshot D1 publication path implemented
- 2026-07-15 — APAC D1 and private R2 provisioned; 17,732 reviewed source records published into a 169 MB evidence database with 17,628 active products
- 2026-07-15 — Cloudflare Worker deployed at `https://protein-index.sarthakagrawal927.workers.dev`; live API, SPA fallback, security headers, and mutation denial verified
- 2026-07-15 — exhaustive richer Open Food Facts enrichment completed for all 17,284 valid source barcodes: 17,239 returned records, 45 explicit not-found outcomes, and zero failed or rejected outcomes
- 2026-07-15 — reviewed enrichment published with 34,971 retained source records; calories-plus-protein coverage increased from 1,688 to 7,247 products and marketed-protein coverage from 190 to 708 of 778 products
- 2026-07-16 — evidence-aware dashboard release `2e8d315d-eca7-4dcb-a009-aab051d9b233` deployed; live health, exact default query, descending protein-density order, completion gate, mutation denial, security headers, and provider-neutral consumer copy verified
- 2026-07-16 — live ranking audit caught contradictory community energy values; protein-energy and severe full-macro conflicts are now withheld from metrics and future ingestion marks them as conflicts
- 2026-07-16 — review decisions now apply the exact validated label candidate atomically, retain field-level provenance and terminal evidence, and reject malformed candidates without overwriting independently sourced nutrition
- 2026-07-16 — resumable Robotoff extraction and weekly GitHub automation implemented for every source product with a nutrition-label image; a five-barcode live sample reconciled all outcomes and rejected a physically impossible partial-macro prediction
- 2026-07-16 — evidence review release `8c5963a2-66f9-4e44-9ef8-2b647136ed0c` deployed after green CI and guarded preflight; live health, default protein-density order, incomplete completion gate, production mutation denial, and provider-neutral consumer copy verified
- 2026-07-16 — first full nutrition-label Robotoff extraction completed in GitHub Actions run `29442748643`: all 5,944 eligible GTINs reached terminal outcomes with 1,374 candidate, 806 no-prediction, 3,764 rejected, and zero failed outcomes
- 2026-07-16 — durable nutrition decisions, canonical candidate hashing, exact replay, deterministic review bundles, and protected commit-pinned D1 publication implemented; 43 unit/domain tests and 15 Worker+D1 tests pass
- 2026-07-16 — first real label candidate reviewed against its 3024×4032 package image and rejected because three declared values were not represented; the checksummed bundle contains zero verification decisions and does not inflate coverage
- 2026-07-16 — all 17,615 nutrition image-level source records published to the production evidence ledger as review-only data, creating 1,556 open candidates while verified nutrition and ingredients correctly remained zero
- 2026-07-16 — review-only ingredient extraction, exact reviewer transcription, durable replay/drift invalidation, checksum bundles, protected publication, and responsive evidence UI implemented; 57 unit/domain tests and 22 Worker+D1 tests pass
- 2026-07-16 — first source-matched nutrition rejection published after exact remote source/hash validation; postconditions recorded one durable decision, promoted zero facts, and resolved only the rejected candidate
- 2026-07-16 — full ingredient-image extraction completed in GitHub Actions run `29450296658`: all 5,196 eligible GTINs reconciled to 3,358 candidate, 1,739 no-prediction, 99 rejected, and zero failed outcomes; 5,661 image-level candidates were validated and published review-only, leaving verified ingredients at zero
- 2026-07-16 — first exact source-matched ingredient rejection published for a Threptin label with visibly unsupported OCR fragments; postconditions resolved one candidate, kept verified ingredients at zero, reduced the open ingredient queue from 5,661 to 5,660, and preserved independent community ingredients
- 2026-07-16 — production coverage timeout traced to a correlated full review-queue scan; the endpoint now batches a single source-bounded candidate aggregate while preserving exact per-product counts and response semantics
- 2026-07-16 — calorie-derived protein rankings now withhold rounded label combinations where protein alone implies more than 100% of declared energy; raw unverified nutrition remains visible and the next valid density ceiling is exactly 25 g per 100 kcal
- 2026-07-16 — token-aware product search deployed after green CI; combined brand, name, flavour, and GTIN queries now match across fields and oversized queries fail with a structured validation error
- 2026-07-16 — exact SYNTHA-6 label evidence converted and committed as checksummed verification bundle `review-492c536b4dbb0130d437`; protected publication run `29474290721` failed before its first remote read because the GitHub production environment supplied no Cloudflare credentials, leaving the review open and verified coverage unchanged
- 2026-07-16 — eight repeated high-confidence nutrition candidates were checked against their exact Athena, Fortune, Optimum Nutrition, and RiteBite label images and rejected in bundle `review-38beed168bae9ec35cb0` for omitted or incorrect declared values; exact remote source/hash and decision-conflict validation passed without writing production data
- 2026-07-16 — Robotoff normalization now merges supplementary serving-column nutrients only when a converted calorie or protein anchor agrees with the per-100-g row, and rejects unitless sodium instead of assuming grams; real Optimum Nutrition evidence gains the missing saturated-fat/sodium values while Fortune no longer produces an erroneous 11,100 mg sodium candidate
- 2026-07-16 — full replay of all 5,944 retained Robotoff responses through the corrected parser changed 117 candidate predictions, safely recovered 60 supplementary nutrient values, removed 79 ambiguous unitless-sodium values, and newly rejected four internally contradictory candidates; corrected extraction run `29475643302` is rebuilding the source-complete review artifact without promoting model output
- 2026-07-16 — four complete high-confidence protein-label candidates were checked against their exact images: Myofusion, Birthday Cake Protein Oats, and a second SYNTHA-6 image match every declared value after serving conversion, while Isopro was rejected for copying the label's 280 mg potassium value into sodium instead of the declared 90 mg; checksummed bundle `review-615f9e122d922268afd3` passed exact live source/hash and decision-conflict validation without writing production data
- 2026-07-16 — exact-image review expanded beyond marketed protein: Cornitos, Christopher Cocoa, LaxmiNarayan Bakarwadi, two Anil millet vermicelli products, and Bikaji Peanuts matched all eight supported label values; two Cream Pot kulfi candidates were rejected because a 70 ml serving had been mislabeled as 70 g, and checksummed bundle `review-66191036dc5b4534f422` passed exact live source/hash and conflict validation without writing production data
- 2026-07-16 — quantity normalization now preserves mass versus volume, requests the official Open Food Facts quantity-unit fields, and requires explicit serving-mass evidence before producing per-100-g Robotoff facts; audit found 435 explicit volume servings among the 5,944 eligible label-image GTINs, so unsafe extraction runs `29475643302` and `29478199652` were stopped before artifact publication
- 2026-07-16 — seven short ingredient declarations were transcribed from their exact package images for Happilo chia seeds, Yoga Bar and Nutrabay pea isolates, Milky Mist and iD high-protein paneer, Whole Truth whey isolate, and Akshayakalpa paneer; checksummed verification bundle `review-e97e33c7ccb738ce2ef6` passed exact live source/hash and decision-conflict validation without writing production data, while an unreadable soya image was deliberately excluded
- 2026-07-16 — live Amul Protein Water evidence exposed that the adapter ignored Open Food Facts' declared `nutrition_data_per: 100ml` when pack quantity was absent; declared basis and the first explicit quantity unit now take precedence, centilitre/decilitre inputs are normalized, and a full 17,732-record replay changes exactly 1,597 volume products from per 100 g to per 100 ml without relabeling the remaining records
- 2026-07-16 — retained Robotoff responses proved that its model can encode a photographed per-100-ml column with `_100g` keys; because the current verified-candidate schema is mass-based, all volume-label model candidates now fail closed, and replacement exhaustive run `29478936206` started from the source-complete snapshot on commit `02bae53`
- 2026-07-16 — live review-queue audit found 271 open nutrition candidates across 218 products with current volume evidence; corrected source replay now deterministically dismisses any open Robotoff nutrition or ingredient candidate whose exact source prediction no longer produces the same candidate hash
- 2026-07-16 — live candidate discovery exposed a D1 CPU reset while filtering the growing JSON-backed review ledger; migration `0007_review_queue_indexes.sql` adds the status/type/priority and product/source indexes used by operator queues and exact evidence joins, and local migration plus the full 85-test check passed
- 2026-07-16 — review-only Source sync run `29479707727` completed from the latest official export: 4,535,553 rows traversed, 21,188 India records reconciled to 17,732 staged products plus 3,456 explicit exclusions, zero continuity drift, and all artifact checksums valid; independent replay confirms 1,597 per-100-ml products and correct mass/volume handling for Amul Protein Water
- 2026-07-16 — all 27 still-unpublished non-duplicate reviewed decisions were consolidated into checksummed bundle `review-eeda6fb52ff42abc6070` with 16 verifications and 11 rejections; exact live source/hash and decision-conflict checks passed for every record, while a redundant second-image SYNTHA-6 verification remains separate because one atomic bundle cannot verify the same product twice
- 2026-07-16 — successful source refresh automatically launched latest API enrichment and ingredient-label extraction; duplicate queued nutrition run `29480068069` was cancelled because volume-safe run `29478936206` already processes the identical source hash with the same final parser contract
- 2026-07-16 — eight additional complete ingredient declarations were verified against their exact Akshayakalpa, Epigamia, KDK, Sid’s Farm, Naturaltein, Nutrabay, Amul, and Heritage package images; top-level ampersand ingredients and `β-galactosidase` now normalize without losing ingredient boundaries, and checksummed bundle `review-17c041045dfaa65be31e` passed exact live source/hash, candidate, conflict, and preparation checks without writing production data

## Products

- `protein-index` web application and Worker API — deployed on Cloudflare at `https://protein-index.sarthakagrawal927.workers.dev`
- Offline Open Food Facts ingestion and reconciliation CLI — implemented
- Weekly/manual Open Food Facts source-sync workflow — implemented; first full continuity baseline completed in GitHub Actions run `29419259301`

## Features (shipped)

- Canonical GTIN-first product schema with source-specific offers and ratings
- Explicit missing, unverified, verified, and conflict states for nutrition and ingredients
- Generic macro/micronutrient observations and extensible product kinds
- Ingredient trees, percentages, allergens, additives, and raw evidence retention
- Protein cohorts, explainable classification, protein/value metrics, and completeness gaps
- Streaming all-India Open Food Facts TSV/JSONL staging without protein prefiltering
- Run manifests, exact snapshot deltas, continuity guardrails, and configured-source coverage ledger
- Per-record exclusion ledger that reconciles every India-tagged source row to a staged product or explicit reason
- Local fixture seed with idempotent reconciliation and authority precedence
- Durable identity decisions keyed to normalized identity evidence, with automatic invalidation when that evidence changes
- Bounded Worker catalog/detail/coverage/review API with structured errors
- Dense responsive catalog, evidence detail, coverage ledger, and separate nutrition/identity review controls
- Verification decisions require a current label or authoritative-source evidence URL
- Polished responsive catalog with global coverage summary, product imagery,
  mobile cards, explicit trusted/discovery modes, and read-only production review
- Checksummed, source-complete reviewed snapshot publication with explicit remote
  confirmation and post-import D1 verification
- Guarded Cloudflare release command with type, test, build, startup, dry-run,
  clean-main, sync, and CI gates
- Evidence-aware discovery defaults to protein grams per 100 kcal while Trusted
  mode remains verified-only
- Resumable, rate-bounded richer Open Food Facts API enrichment with exhaustive
  barcode outcome accounting
- Review-gated Robotoff label extraction with basis, unit, confidence, image,
  and anomaly validation
- Explicit completion gate separating source exhaustion, structured data,
  label-image coverage, extraction candidates, and verified product coverage
- Checksummed richer-source backfill with exact barcode accounting, zero-failure
  publication guard, and resumable per-batch response evidence
- Scheduled, identified, rate-limited Robotoff extraction across the complete
  nutrition-label-image cohort, with per-barcode checkpoints and candidate,
  no-prediction, rejection, and failure accounting
- Evidence-specific label review that promotes only the reviewed candidate's
  validated values and leaves rejected candidates isolated from existing facts
- Side-by-side operator review of the label image, exact normalized candidate,
  model metadata, confidence, basis, and human-verification warning
- Append-only evidence decisions bound to exact source content and canonical
  candidate hashes, with verified/rejected replay and stale-evidence invalidation
- Deterministic, checksummed review-decision bundles with fail-closed path,
  schema, nutrition, GTIN, source-drift, and decision-conflict validation
- Protected manual publication pinned to a merged bundle commit and explicit
  ledger hash, with pre-write source checks and exact post-write fact/outcome checks
- Separate protected publication for source-complete Robotoff candidate artifacts;
  model output enters the review queue and never becomes verified nutrition by itself
- Ingredient-label extraction retains exact model, image, text, language,
  bounding-box, parsed-tree, and count evidence without auto-verification
- Successful weekly source snapshots automatically trigger both nutrition- and
  ingredient-label candidate extraction; publication and verification remain
  separately guarded
- Reviewer-confirmed ingredient transcription atomically rebuilds normalized
  ingredient rows and exact provenance, while source drift revokes verified trust
- Nutrition and ingredient decisions share a checksum-validated, commit-pinned,
  idempotent publication and postcondition path

## Todo / Planned / Deferred / Blocked

1. Verify every active product's nutrition and ingredients against current
   package labels or authoritative brand-owner evidence; terminal evidence-backed
   unavailable states are allowed, inferred values are not.
2. Complete desktop/mobile browser verification; the in-app browser was unavailable during the implementation run.
3. Apply for GS1 India DataKart access and map its commercial/licensing constraints.
4. Validate Amazon and Flipkart affiliate integrations against current India terms.
5. Evaluate one quick-commerce provider using a coverage, freshness, legality, and cost scorecard.
6. Review the 5,660 open ingredient-label candidates against their exact source
   images; publish only source/hash-matched decisions and retain the immutable OCR.
7. Deferred: ONDC offer ingestion until the core catalog and retailer reconciliation are stable.
8. Deferred: expand the generic nutrient/product-kind model into full macros,
   micronutrients, raw foods, foodservice, prepared dishes, and recipes after the
   protein catalog proves its accuracy and operating model.
9. Blocked: official DataKart ingestion requires a commercial agreement and private API documentation.
10. Complete sanctioned desktop/mobile visual verification when the in-app
    browser target becomes available; live API and responsive implementation
    checks are complete.
11. Continue current-label and brand-owner enrichment for the 10,037 barcodes
    still lacking a usable calories-plus-protein pair and the 12,147 barcodes
    still lacking an ingredient statement in the 17,284-barcode enrichment set.
12. Blocked: verified completeness cannot be achieved from Open Food Facts alone;
    current labels, brand-owner feeds, DataKart access, or manual verification are
    required for every remaining product.
13. Review the 1,556 open nutrition candidates against current package images;
    extraction confidence alone must never increase verified coverage.
14. Continue publishing real reviewed decisions only after exact source/hash
    validation; every publication must verify the live coverage delta and retain
    workflow diagnostics.
15. Deploy the new label-review UI only after rendered desktop/mobile visual and
    accessibility verification succeeds.
16. Blocked: the GitHub `production` environment must provide the existing
    Cloudflare publication credentials before protected catalog or reviewed-
    evidence workflows can read or write D1. Runs `29449999090` and
    `29474290721` both failed with empty credential variables before applying
    data; the exact SYNTHA-6 verification bundle and the eight-decision
    incomplete-candidate rejection bundle remain committed and replayable.
