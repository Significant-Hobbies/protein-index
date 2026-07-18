## Context

Official-brand discovery already produces one complete, checksummed snapshot per
configured brand. The existing importer is intentionally single-source: it
creates one source and ingestion run from one manifest. Treating the sixteen
artifacts as one synthetic source would lose the source-specific identity,
offer, and completeness provenance that makes first-party discovery useful.

## Goals / Non-Goals

**Goals:**

- Publish only a complete, exactly pinned set of configured official-brand
  artifacts.
- Preserve each brand as its own source and ingestion run while reconciling all
  records into the common GTIN-first canonical catalog.
- Make publication idempotent, serialized, authenticated, and independently
  verifiable after the D1 write.
- Report configured-brand coverage without representing it as market complete.

**Non-Goals:**

- Automatic acceptance of nutrition or ingredient facts from product pages.
- Retailer crawling, ratings aggregation, DataKart access, or automatic
  production publication from an incomplete/changed brand crawl.
- Deactivation of a canonical product merely because one first-party catalog no
  longer lists it.

## Decisions

### Publish a composite, multi-source snapshot

A preparer will download every matrix artifact from one successful official
brand workflow run, verify the expected configured source set, validate each
manifest as source-complete, deduplicate within its source, and emit a
checksummed composite manifest. It will retain each constituent manifest,
exclusion ledger, source index, and staged-record checksum rather than flatten
provenance into a synthetic record.

This is preferred to one publication workflow per brand because a run is only
useful as a market-discovery cohort when every configured brand reaches a
terminal state. It is preferred to a synthetic source because it preserves
first-party offer attribution and lets future refreshes/reconciliation operate
per brand.

### Extend the import contract for a source set

The importer will accept a validated collection of source snapshots and write a
source row and ingestion run for every constituent manifest inside one D1
transaction. Each staged product retains its original `source`; existing
GTIN-first and deterministic-composite resolution then resolves identity across
Open Food Facts and all first-party sources. The composite manifest is
publication evidence only, not a replacement source.

### Use a manual protected workflow

The official-brand producer stays credential-free and weekly. A separate
`workflow_dispatch` workflow requires the exact upstream run ID and a hard
confirmation phrase, pins the main-branch publication commit, validates all
artifact identities and checksums before accessing Cloudflare, and serializes
with existing production publication jobs. It never applies schema migrations
and refuses a pending production migration state.

### Preserve trust boundaries

Official first-party calories/protein may remain visible as unverified evidence
only when they are explicit and basis-safe. Ingredient and label URLs remain
evidence inputs. No discovery record can create a verified fact or enter a
Trusted ranking without the existing exact-current evidence path.

## Risks / Trade-offs

- [One brand artifact is missing, expired, or incomplete] → reject the whole
  cohort before credentials or D1 reads; retain a diagnostic artifact.
- [A retailer-style price is mistaken for a first-party offer] → retain only
  offers extracted by the official-brand adapter and keep the original source
  URL and observation timestamp.
- [A brand page changes variants or removes products] → preserve historical
  source records and do not deactivate canonical products from one absence.
- [Cross-source fuzzy identity collision] → use only existing GTIN/deterministic
  composite rules; otherwise retain a pending identity review.
- [Large batch times out] → generate streamed SQL and use one serialized D1
  import with exact pre/post counts, not one network mutation per record.

## Migration Plan

1. Add composite-artifact validation and multi-source import support with
   fixtures covering complete, incomplete, changed, and duplicate inputs.
2. Add the protected publisher and production postcondition checks.
3. Run a local rehearsal using the latest successful official-brand run and
   inspect the exact product/source/offer deltas.
4. Dispatch the publisher only after the rehearsal is source-complete and the
   production guard is green; verify public API coverage and lookup results.
5. Roll back a bad release by publishing a newer provenance-preserving source
   snapshot; never delete evidence history.

## Open Questions

- None for the initial configured-source lane. DataKart remains the future
  authoritative, broader-market source and is intentionally outside this
  change.
