# Protein Index — STATUS

> Short current-state view. The durable, append-only timeline lives in
> [`PROJECT_STATUS.md`](PROJECT_STATUS.md). Update this file each working
> session; update `PROJECT_STATUS.md` when PR-sized work completes.

Last updated: 2026-07-19

## Current objective

Reach strict terminal-evidence completion: every active product has terminal
verified identity, nutrition, and ingredient evidence (or a current
label/authoritative source explicitly establishes a field as not applicable or
not declared), every configured source reconciles without unexplained gaps, and
the rendered dashboard passes desktop/mobile verification.

## Active work

- Machine-verified label lane (`automated-label-verification` OpenSpec change):
  complete and published through protected workflow run `29653810942`. Three
  current first-party Protein Chef labels plus four serving-normalized Yoga Bar
  labels are live as `machine_verified` facts; they remain separate from
  human-reviewed Trusted evidence.
- Official brand discovery lane (`official-brand-discovery`,
  `protein-branded-discovery`): no-cost sitemap crawling into discovery
  records. The current catalog has 1,683 marketed-protein products, with 288
  calories-plus-protein comparisons; current source coverage remains incomplete.
- Replacement adapter-v8 (nutrition) and adapter-v3 (ingredient) artifacts
  with byte-hash-complete ledgers.
- Zero-cost local macro refresh is implemented and tested. It creates
  checksummed source-bounded runs plus a bounded local machine-label queue;
  it never publishes or deploys. A macOS launchd template is ready to install
  once a local data directory is chosen.
- Live dashboard audit is complete: the catalog is live, defaults to protein
  per 100 kcal, and no longer displays offers or cost metrics. Coverage summary
  accounting now avoids detail-only extraction projections before deployment.

## Blockers

- **DataKart:** official DataKart ingestion requires a commercial agreement
  and private API documentation (`PROJECT_STATUS.md` item 9).
- **Verified completeness from Open Food Facts alone:** impossible; current
  labels, brand-owner feeds, DataKart access, or manual verification are
  required for every remaining product (`PROJECT_STATUS.md` item 12).

## Unresolved questions

- Which historical adapter-v5/v6 runs and artifacts are explicitly denied for
  reuse? Cross-check `PROJECT_STATUS.md` before reusing any historical
  artifact.
- The exact `data:*` script surface grows with each feature; treat
  `package.json` as authoritative.

## Next steps

1. Continue current-label and brand-owner enrichment for the products still
   lacking a usable calories-plus-protein pair or an ingredient statement
   (`PROJECT_STATUS.md` item 11).
2. Run the machine verifier only against current, explicitly identified
   first-party nutrition labels; keep rejected and incomplete labels out of
   rankings.
3. Apply for GS1 India DataKart access and map its commercial/licensing
   constraints (`PROJECT_STATUS.md` item 3).
4. Re-run desktop/mobile/tablet and accessibility checks against the live
   deployment after the coverage-summary performance fix is released
5. Install the local launchd template with the chosen local data directory,
   then use the existing guarded publisher for any source-complete evidence
   release selected for the hosted dashboard.
   (`PROJECT_STATUS.md` item 2).

## Deferred

- ONDC offer ingestion until the core catalog and retailer reconciliation are
  stable (`PROJECT_STATUS.md` item 7).
- Expand the generic nutrient/product-kind model into full macros,
  micronutrients, raw foods, foodservice, prepared dishes, and recipes
  (`PROJECT_STATUS.md` item 8).
