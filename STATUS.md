# Protein Index — STATUS

> Short current-state view. The durable, append-only timeline lives in
> [`PROJECT_STATUS.md`](PROJECT_STATUS.md). Update this file each working
> session; update `PROJECT_STATUS.md` when PR-sized work completes.

Last updated: 2026-07-18

## Current objective

Reach strict terminal-evidence completion: every active product has terminal
verified identity, nutrition, and ingredient evidence (or a current
label/authoritative source explicitly establishes a field as not applicable or
not declared), every configured source reconciles without unexplained gaps, and
the rendered dashboard passes desktop/mobile verification.

## Active work

- Machine-verified label lane (`automated-label-verification` OpenSpec change):
  offline OCR + vision-language cross-check with an evidence-grade acceptance
  contract. The five-case checksum-pinned local benchmark passes; an idempotent
  local replay retains 37 machine-verified nutrition facts.
- Official brand discovery lane (`official-brand-discovery`,
  `protein-branded-discovery`): no-cost sitemap crawling into discovery
  records. The current catalog has 1,683 marketed-protein products, with 288
  calories-plus-protein comparisons; current source coverage remains incomplete.
- Replacement adapter-v8 (nutrition) and adapter-v3 (ingredient) artifacts
  with byte-hash-complete ledgers.

## Blockers

- **Production credentials:** protected Cloudflare credentials are configured,
  but pending migrations block the data refresh. See `PROJECT_STATUS.md` item
  16 for the exact pending-migration set.
- **DataKart:** official DataKart ingestion requires a commercial agreement
  and private API documentation (`PROJECT_STATUS.md` item 9).
- **Verified completeness from Open Food Facts alone:** impossible; current
  labels, brand-owner feeds, DataKart access, or manual verification are
  required for every remaining product (`PROJECT_STATUS.md` item 12).

## Unresolved questions

- Which production migrations are still pending right now? Cross-check
  `PROJECT_STATUS.md` item 15 and the live D1 schema before any production
  write.
- Which historical adapter-v5/v6 runs and artifacts are explicitly denied for
  reuse? Cross-check `PROJECT_STATUS.md` before reusing any historical
  artifact.
- The exact `data:*` script surface grows with each feature; treat
  `package.json` as authoritative.

## Next steps

1. Get explicit release approval to apply the compatible production migrations
   through `0018_reviewed_fact_time_boundary.sql`, generate and publish fresh
   byte-hash-complete adapter-v8/v3 artifacts, publish compatible reviewed
   bundles in guarded order, deploy the browser-verified dashboard, then prove
   live family accounting invariants (`PROJECT_STATUS.md` item 15).
2. Continue current-label and brand-owner enrichment for the products still
   lacking a usable calories-plus-protein pair or an ingredient statement
   (`PROJECT_STATUS.md` item 11).
3. Run the machine verifier only against current, explicitly identified
   first-party nutrition labels; keep rejected and incomplete labels out of
   rankings.
4. Apply for GS1 India DataKart access and map its commercial/licensing
   constraints (`PROJECT_STATUS.md` item 3).
5. Re-run desktop/mobile/tablet and accessibility checks against the live
   deployment after the updated dashboard is explicitly released
   (`PROJECT_STATUS.md` item 2).

## Deferred

- ONDC offer ingestion until the core catalog and retailer reconciliation are
  stable (`PROJECT_STATUS.md` item 7).
- Expand the generic nutrient/product-kind model into full macros,
  micronutrients, raw foods, foodservice, prepared dishes, and recipes
  (`PROJECT_STATUS.md` item 8).
