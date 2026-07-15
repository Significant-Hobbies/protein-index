## Context

The current source-complete India snapshot retained 17,732 Open Food Facts
records and published 17,628 active canonical products. Only 1,734 staged
records contain both calories and protein, but 6,008 have a selected nutrition
image. Among 791 marketed protein records, 193 have calories and protein while
450 have a nutrition image. A direct audit also found products whose current
Product API response contains complete nutrition while the daily CSV export has
blank nutrition fields. The catalog currently defaults to verified-only results,
so it shows no products even though validated, source-attributed unverified data
exists.

Open Food Facts documents a multi-code search request, a 10 requests/minute
search limit, a richer current product schema, and Robotoff nutrition extraction
from packaging images. Open Food Facts also explicitly disclaims accuracy, so
its structured and model-derived values cannot be promoted to verified evidence
without review.

## Goals / Non-Goals

**Goals:**

- Make protein grams per 100 kcal immediately useful as the primary comparison.
- Exhaustively enrich the exact configured India barcode set using bounded,
  resumable official-source requests.
- Retain richer ingredients, nutrition, label images, quality tags, and raw
  prediction evidence.
- Increase usable discovery coverage while keeping verification semantics honest.
- Make every enrichment and exclusion reproducible from artifacts.
- Keep hosting-provider details out of the consumer experience.
- Keep the project completion gate red until product-level verified coverage is
  complete, even after code and deployment work finish.

**Non-Goals:**

- Claim complete Indian-market coverage from Open Food Facts.
- Treat crowdsourced or model-derived values as authoritative label verification.
- Scrape retailer pages, infer missing nutrition from similar products, or
  synthesize values from product category averages.
- Run unbounded image inference from the public Worker.

## Decisions

### Use discovery-first ranking with an unchanged Trusted boundary

The default filter becomes `verification=all`, `scope=all`, and
`sort=protein_density`. Valid unverified nutrition can produce a displayed
discovery metric, and the product's evidence badge stays adjacent to the value.
This keeps ordinary protein-dense foods visible even when unverified nutrition
cannot assign them to the nutrition-derived protein cohort. Trusted mode remains
verified-only. This is preferable to an empty default or to weakening the
definition of verification.

### Add an API enrichment layer rather than replacing the source snapshot

The source-complete CSV remains the catalog-discovery and continuity baseline.
A second adapter reads its distinct valid barcodes, requests them in documented
multi-code batches, and writes append-only response and outcome artifacts. This
preserves source exhaustion while filling fields the compact CSV omits. The
adapter uses a stable User-Agent, at most one request every 6.5 seconds, bounded
batch size, exponential retry, and resumable batch files.

Alternatives considered:

- The 12.5 GB JSONL dump is richer but too large for the current two-hour GitHub
  workflow and runner storage envelope when downloaded and staged conventionally.
- The 7.7 GB Hugging Face Parquet mirror supports the richer schema, but its
  Dataset Viewer cannot filter nested country tags and its filter index is
  partial above 5 GB. A remote predicate scan did not complete within 90 seconds,
  so it is not yet a bounded production path.
- Per-product requests would take roughly 20 hours at the documented product
  limit; the official multi-code search endpoint is the supported bounded batch.

### Keep API and Robotoff observations as separate sources

`open_food_facts_api` uses the same open-data authority as the CSV but can win by
newer observation time. `open_food_facts_robotoff` has lower nutrition and
ingredient authority and creates review candidates. Exact GTIN links both to the
canonical product without mutating the original source record.

### Validate before calculation, verify only after evidence review

Structured API values may be selected as unverified after existing validation.
Robotoff values are retained as candidates and require a current image, explicit
basis, valid unit, sufficient confidence, and anomaly-free normalization. Human
review—or a future authoritative brand/DataKart feed—can promote evidence to
verified. No agreement heuristic alone changes the verification state.

### Publish artifacts before changing production data

Source responses, outcome ledgers, manifests, and checksums are uploaded for
review. Production publication remains a separate confirmed workflow. This
keeps a failed or partial enrichment from changing the live catalog.

## Risks / Trade-offs

- **Public API availability or rate-limit changes** → Fail closed, retain the
  previous snapshot, use retries, and expose incomplete outcome accounting.
- **Bulk search omits requested codes** → Record each absent barcode as not
  found; never assume a complete response from the request count alone.
- **Newer community data is wrong** → Keep it unverified, retain quality tags,
  validate anomalies, and preserve stronger evidence during reconciliation.
- **Model output confuses serving and per-100-g columns** → Require explicit
  basis and serving mass; otherwise keep the prediction review-only.
- **Discovery rankings appear more authoritative than they are** → Put evidence
  state next to the primary metric and retain the one-click Trusted boundary.

## Migration Plan

1. Add adapter fixtures and tests for batching, resume, accounting, parsing, and
   validation before changing live behavior.
2. Change the API/UI default and expose evidence-aware discovery metrics.
3. Run a small enrichment sample and compare it against raw API responses and
   existing staged products.
4. Run the full barcode-set enrichment in GitHub Actions and review its manifest,
   delta counts, validation issues, and checksums.
5. Publish the reviewed snapshot to D1 using the existing guarded publication
   path, then deploy the Worker behind the release guard.
6. Roll back by deploying the prior Worker version and republishing the previous
   checksummed catalog snapshot.

## Open Questions

- Whether Open Food Facts will approve or recommend a long-term bulk enrichment
  cadence beyond the initial backfill.
- Whether DataKart access will provide nutrition fields and label images at a
  quality and freshness level sufficient to replace community evidence.
- Which operator authentication mechanism should unlock remote verification
  decisions; public production mutations remain disabled.
