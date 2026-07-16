# Data sources and trust

Protein Index separates source completeness from nutrition accuracy. Finishing
an import means every record in that configured source was considered; it does
not mean that every Indian food exists in the source or that every contributed
label value is correct.

## Open Food Facts bootstrap

The scheduled workflow streams the official complete tab-separated export from
`https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz`.
It does not discover the catalog through repeated search API calls.

Every successful production run records:

- the compressed input hash, byte size, upstream `Last-Modified` timestamp, and
  end-of-file evidence;
- total rows read and India-tagged, staged, invalid, and duplicate counts;
- exact new, changed, unchanged, and missing-since-prior record counts;
- missing nutrition/ingredient coverage and validation issue counts;
- a compact `source-index.jsonl` used to compare the next run;
- an `exclusions.jsonl` ledger containing the source row, available identity,
  reason codes, and evidence hash for every India-tagged row not staged because
  of missing minimum identity or a duplicate source record ID.

The workflow verifies that staged records plus exclusion-ledger records equal
the complete India-tagged slice. Artifact checksums use portable relative paths
and can be checked from the extracted snapshot directory with
`sha256sum --check checksums.sha256`.

The workflow fails before publishing artifacts as a new continuity baseline if
the snapshot is empty, capped, incomplete, corrupt, or more than 20% below the
last complete snapshot. It stages reviewable artifacts only; it does not write
to a hosted database.

Open Food Facts observations remain `unverified`. They are useful for broad
discovery, barcode matching, images, ingredients, and nutrition candidates, but
they do not become verified merely because the import completed successfully.

## GS1 India DataKart

DataKart is the preferred official brand-owner catalog source. The adapter is
intentionally disabled until the project has all of the following:

1. A registered GS1 India solution-provider account and commercial approval.
2. Private endpoint and schema documentation supplied under that agreement.
3. A secret-delivery mechanism configured outside this repository.
4. Confirmed rate limits, pagination, delta/update, deletion, and replay rules.
5. Written retention, display, redistribution, image, and derived-data rights.
6. A field map covering GTIN, variants, net quantity, nutrition basis,
   ingredients, allergens, label images, and source freshness.

Run `pnpm exec tsx scripts/sync.ts datakart-status` to see the non-secret
configuration checklist. Selecting DataKart without those inputs fails
explicitly; it never substitutes Open Food Facts data and labels it official.

## Future hosted apply

No scheduled workflow currently mutates D1. A future apply job must be a
separate protected GitHub environment with manual approval. It should accept
only a successful, checksummed snapshot artifact; verify its manifest and
continuity result again; apply idempotent upserts; preserve the prior catalog on
failure; and record the artifact and workflow run IDs in the ingestion run.

That apply step requires explicit approval to provision D1/R2 and configure
production access. Repository workflows must never contain credentials.

## Evidence policy

Nutrition and ingredients have independent states:

- `missing`: no usable observation exists;
- `unverified`: a source supplied a plausible observation;
- `verified`: a reviewer verified the current package label or an approved
  authoritative source under an explicit policy;
- `conflict`: plausible observations disagree and require review.

Trusted comparisons default to verified nutrition. Raw observations and
provenance remain available so verification decisions are auditable and can be
revisited when packaging changes.

Reviewed label evidence preserves its physical basis. Mass candidates use per
100 g; liquid candidates use per 100 mL. Serving rows are normalized only from
an explicit serving quantity of the same dimension, and millilitres are never
converted to grams without separate density evidence.
