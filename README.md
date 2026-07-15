# Protein Index

A normalized Indian food-product intelligence database with protein discovery,
source-aware nutrition and ingredients, and evidence-first comparisons.

The product record is canonical. Retailer listings are observations attached to
that record, never the source of identity by themselves. Broad imports ingest
all India-tagged foods first and classify protein products afterward.

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
never writes to production.

See [docs/SOURCES.md](docs/SOURCES.md) for trust states, coverage semantics, the
DataKart integration checklist, and the protected future hosted-apply design.

Implementation work is tracked in `openspec/changes/build-catalog-core/` and
durable product status lives in `PROJECT_STATUS.md`.
