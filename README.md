# Protein Index

Live dashboard: <https://protein-index.sarthakagrawal927.workers.dev>

A normalized Indian food-product intelligence database with protein discovery,
source-aware nutrition and ingredients, and evidence-first comparisons.

The product record is canonical. Retailer listings are observations attached to
that record, never the source of identity by themselves. Broad imports ingest
all India-tagged foods first and classify protein products afterward.

The dashboard has two explicit evidence boundaries:

- **Trusted** shows protein-relevant products with verified nutrition only.
- **All evidence** is the discovery view. It exposes comparison metrics only
  when structured nutrition passes validation, keeps community evidence visibly
  unverified, and withholds missing or conflicting values.

Missing values stay missing. Open Food Facts values are never promoted to
label-verified facts merely because they parse successfully.

## Local development

Requirements: Node.js 22+ and pnpm 10.

```bash
pnpm install
pnpm data:seed
pnpm dev
```

The seed is intentionally synthetic. It provides verified and conflict states,
plus ambiguous identity records for exercising match, create-new, and
keep-unmatched decisions without presenting test products as real market data.

Run the complete local check with:

```bash
pnpm check
```

## Source staging

Stage a bounded local Open Food Facts sample:

```bash
pnpm data:stage -- \
  --input path/to/open-food-facts-sample.jsonl \
  --output .data/sample \
  --mode sample \
  --limit 100
```

Production mode rejects every record cap. The weekly/manual GitHub workflow
downloads the complete official TSV export, identifies this client, reaches
end-of-file, compares counts and record hashes with the last good run, and
uploads reviewable artifacts. Every India-tagged source row is represented by
either a staged product or an auditable exclusion-ledger entry. The workflow
never writes to production by itself.

Enrich the exact source-complete barcode set with the richer documented product
response:

```bash
pnpm data:enrich -- \
  --input .data/sample/staged-products.jsonl \
  --manifest .data/sample/manifest.json \
  --output .data/enrichment \
  --mode production
```

Enrichment uses multi-code batches, identifies this client, stays within the
documented search limit, retries transient failures, splits persistently
unavailable batches, and resumes from saved response artifacts. It separately
accounts for enriched, unchanged, not-found, rejected, and failed barcodes. The
weekly enrichment workflow creates a reviewable artifact; publication remains
manual.

Extract review-gated nutrition candidates from every available label image:

```bash
pnpm data:extract -- \
  --source robotoff \
  --input .data/sample/staged-products.jsonl \
  --manifest .data/sample/manifest.json \
  --output .data/robotoff \
  --mode production
```

The Robotoff job is resumable per barcode, identifies the client, observes the
documented request limit, and records every eligible barcode as candidate,
no-prediction, rejected, or failed. Model output never becomes verified
nutrition automatically; an operator must review the current label image, and
verification applies that exact candidate with its provenance.

## Reviewed catalog publication

Validate and publish an existing source-complete snapshot locally:

```bash
pnpm data:publish -- --input .data/reviewed-snapshot
```

Remote publication is intentionally explicit and requires both flags:

```bash
pnpm data:publish -- \
  --input .data/reviewed-snapshot \
  --remote \
  --confirm-remote
```

Publication verifies portable checksums, production/end-of-file evidence,
India-row reconciliation, continuity limits, and non-empty counts before it
writes. It then applies migrations, performs an idempotent D1 import, and
queries product, run, and source-record counts. The manual `Publish reviewed
catalog` GitHub workflow adds a protected environment gate and pins both the
source workflow run and reviewed input hash.

## Cloudflare release

The production topology is one Worker (`protein-index`), one D1 database
(`protein-index`), and one private R2 bucket (`protein-index-labels`). The
public application is read-only until operator authentication exists.

After resources are bound and the reviewed snapshot has been published:

```bash
pnpm release:preflight
pnpm run deploy
```

`pnpm run deploy` runs the fleet deploy guard before tests, build, Worker startup
profiling, Wrangler dry run, and the strict deployment. Roll back Worker code
with Wrangler deployment rollback; catalog corrections are republished as new
evidence-preserving runs instead of deleting the audit trail.

See [docs/SOURCES.md](docs/SOURCES.md) for trust states, coverage semantics, and
the DataKart integration checklist.

Implementation work is tracked in `openspec/changes/` and durable product status
lives in `PROJECT_STATUS.md`.
