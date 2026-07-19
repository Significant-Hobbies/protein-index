## Why

Shoppers use Protein Index to compare a product's macros quickly. The product
drawer currently foregrounds technical provenance and source-record expanders
that add work without helping that decision.

## What Changes

- Remove expandable provenance and source-record detail from the consumer
  product drawer.
- Keep the visible product identity, macro values, comparison metrics, and
  nutrition evidence status.
- Preserve provenance and source records in the API and database; this is a
  consumer presentation change only.

## Capabilities

### New Capabilities

- `macro-first-product-detail`: A concise product drawer that prioritizes
  shopper macro comparison over technical evidence drill-downs.

### Modified Capabilities

- None.

## Impact

Touches the React product drawer and its dashboard regression coverage. No API,
database, ingestion, dependency, or deployment change is required.
