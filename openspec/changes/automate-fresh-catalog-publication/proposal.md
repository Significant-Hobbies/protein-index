## Why

The weekly Open Food Facts workflow exhausts and validates the current India-tagged source, but it stops at an artifact; the live catalog changes only after a separate manual publication. That leaves the deployed dashboard stale even when automatic retrieval succeeds, which does not meet the requirement that newly available products be pulled in automatically.

## What Changes

- Add protected automatic publication workflows that consume only successful, checksummed, source-complete artifacts from `Source sync`, Open Food Facts API enrichment, and the two Robotoff extraction workflows.
- Preserve Open Food Facts nutrition and ingredients as explicitly unverified evidence and Robotoff output as review-only candidates; automatic publication must never create verified facts or terminal verification outcomes.
- Fail closed before remote D1 writes on missing artifacts, checksum drift, incomplete traversal, unreconciled India-row accounting, unexpected source-count drops, or an untrusted trigger/ref.
- Serialize every production data publication through the existing publication concurrency group and retain exact run, manifest, input-hash, pre-write, and post-write evidence.
- Verify the live health, catalog freshness, source-run identity, and product/source-record counts after publication; surface failures without rolling forward a partial success claim.
- Keep label decisions, DataKart data, retailer data, schema migrations, and Worker deployments outside this automatic path.
- Retain the existing manual publication workflow for recovery and exact artifact replay.

## Capabilities

### New Capabilities

- `fresh-evidence-publication`: Protected, fail-closed automatic publication of complete Open Food Facts discovery, enrichment, and review-only extraction artifacts, with durable pre/post-write proof and no automatic verification.

### Modified Capabilities

None. Existing main specs have not yet been archived; this capability supersedes the earlier change-local decision that scheduled retrieval and production publication must always remain separate.

## Impact

- Affects GitHub Actions source, enrichment, extraction, and publication workflows; publication validation helpers and tests; operator documentation; and `PROJECT_STATUS.md`.
- Mutates the existing production D1 catalog after successful weekly source syncs, using the existing Cloudflare credentials and protected `production` environment.
- Adds no production dependency, API response change, schema migration, retailer collection, or automatic verification behavior.
