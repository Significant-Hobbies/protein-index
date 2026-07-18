## Context

The current catalog normalizes an exhaustive Open Food Facts India slice but
does not discover products absent from that community source. We need a free,
replayable expansion path that relies on sources controlled by product brands
without accidentally promoting page metadata to verified nutrition.

## Goals / Non-Goals

**Goals:**

- Traverse only configured official brand sitemaps and product pages after a
  bounded robots-policy check.
- Emit deterministic staged records and source manifests that preserve raw page
  evidence, traversal accounting, image URLs, GTINs, and first-party prices.
- Reuse the existing GTIN-first reconciliation path while retaining unknown
  identity matches and unavailable nutrition as explicit evidence gaps.

**Non-Goals:**

- Proving all Indian products are discoverable from a set of brand sites.
- Circumventing robots policy, login, CAPTCHAs, or site rate limits.
- Treating serving-sized JSON-LD nutrition, marketing claims, or inferred
  ingredients as per-100-g verified nutrition.
- Automatic remote publication or dashboard deployment.

## Decisions

### Configured first-party sources, not general search crawling

A versioned configuration declares each canonical brand id, permitted HTTPS
hosts, sitemap entry points, and a conservative traversal budget. This makes
the source boundary auditable and permits explicit removal when a site policy
changes. General search results and unaffiliated retailers are deliberately
out of scope for this adapter.

### Preserve page evidence; promote only unambiguous identity and offers

Explicit schema.org `Product` data in JSON-LD or HTML microdata, plus a bounded
page-bound Shopify `meta.product` declaration where JSON-LD is absent, will seed
identity, GTIN, current product URL, image, and direct brand offer observations.
Basis-unknown structured nutrition remains unverified and cannot power
mass-normalized metrics. When a typed first-party declaration supplies a
validation-passing calories-and-protein pair, it may power only basis-invariant
discovery metrics such as protein per 100 kcal; the raw values are labelled with
their unknown basis and retained for later exact-label verification.

### Safe, resumable crawling

The adapter accepts injected fetchers for tests, checks `robots.txt`, confines
redirects to configured HTTPS hosts, limits sitemap nesting/page count/bytes,
and writes deterministic records sorted by URL. A source manifest records
discovery limits and terminal status. Partial traversal is source-incomplete
and cannot pass an automatic publication gate.

### Existing reconciliation, separate source confidence

Brand records use `sourceKind: brand` with lower nutrition authority than an
exact current label. GTIN matches win automatically; records without a GTIN
remain as separate candidates until existing identity review resolves them.

## Risks / Trade-offs

- [Brand sitemaps do not cover all Indian products] → retain `marketComplete:
  false`, source-specific coverage, and disconnected-source reporting.
- [Public site markup varies] → only accept well-formed JSON-LD Product data;
  record malformed/unsupported pages as explicit exclusions.
- [Site policies or uptime change] → robots check, conservative fetch budgets,
  source-specific failures, and no automatic publication from partial runs.
- [Page prices are region-dependent] → preserve the first-party offer as an
  observed price without presenting it as a universal current offer.

## Migration Plan

1. Add the adapter and fixtures with no configured live sources.
2. Validate deterministic staging/reconciliation locally against fixtures.
3. Add reviewed source configuration and run a local source-complete rehearsal.
4. Publish only through the existing guarded release path after source and
   dashboard checks pass; removing a source configuration cleanly stops future
   collection without deleting its historical evidence.
