## Context

The useful asset is a normalized, auditable catalog—not a cache of retailer
search results. Source records arrive with different identifiers, nutrition
bases, field names, timestamps, licenses, and error rates. Some will be official
brand-owner data (DataKart), some open community data (Open Food Facts), and
some transient retailer observations. The first implementation must work
without commercial credentials or provisioned cloud resources, while leaving a
clean path to scheduled official-source updates.

The initial scale is 500 reviewed protein products, but ingestion may retain all
India-tagged food records so classification errors do not become discovery
gaps. The schema and algorithms therefore cannot assume every product is a
protein product.

## Goals / Non-Goals

**Goals:**

- Represent canonical products independently from offers and ratings.
- Retain source evidence and field-level provenance for every selected value.
- Reconcile repeat imports deterministically and idempotently.
- Discover broadly, then classify protein relevance separately.
- Calculate comparable protein and cost metrics only from valid inputs.
- Provide a complete local vertical slice: import, store, query, inspect, and
  resolve review items.
- Automate freshness checks and source pulls through a scheduled workflow.
- Make DataKart the preferred official catalog adapter once access is granted.

**Non-Goals:**

- Provisioning or mutating production Cloudflare resources.
- Implementing DataKart without its private API schema and license terms.
- Scraping retailer consumer applications.
- Aggregating ratings across retailers.
- Automatically accepting fuzzy product matches.
- Treating Open Food Facts as authoritative merely because it is structured.
- Guaranteeing complete Indian food-market coverage in the first release.

## Decisions

### One TypeScript full-stack application

Use Vite + React for the operator/search UI and a Cloudflare Worker API backed
by D1. The official Cloudflare Vite plugin keeps local Worker behavior close to
production. Hono provides small, explicit routing and response handling without
introducing a full server framework. Shared domain modules contain no Worker or
React imports, so validation, classification, metrics, and matching remain easy
to test and reuse from offline jobs.

Alternative considered: Next.js. It adds server/runtime machinery that the
dense SPA and JSON API do not require. Alternative considered: separate web and
API repositories. That would slow schema-contract changes and create needless
cross-repo coordination at this stage.

### D1-compatible relational model with evidence tables

Use SQL migrations with these conceptual groups:

- `products`: selected canonical identity and classification fields.
- `nutrition_facts`: selected per-100-g facts plus basis and verification data.
- `offers` and `ratings`: source listing observations keyed separately.
- `sources`, `ingestion_runs`, and `source_records`: adapter identity, run
  health, raw record hashes, and traceability.
- `field_observations`: raw/normalized candidate values, source, confidence,
  observation time, evidence link, and whether the value is selected.
- `review_items`: ambiguous matches, validation anomalies, and conflicts.

Canonical columns are a materialized selection for fast reads; observations are
the audit trail. JSON is used only for genuinely variable evidence, not as a
substitute for relational identity or numeric nutrition fields.

Alternative considered: document storage only. It simplifies raw ingestion but
makes uniqueness, source-specific history, numeric filtering, and conflict
inspection harder. Alternative considered: an ORM. Direct SQL and the typed D1
binding keep the first schema visible and avoid a production dependency before
query complexity justifies one.

### Normalize GTIN for matching, preserve the source representation

Validated GTIN-8, GTIN-12, GTIN-13, and GTIN-14 values are stored canonically as
14 digits for comparison, while the original source value remains in its source
record/observation. Invalid check digits never become canonical identifiers and
instead create validation review items.

Exact GTIN is the only automatic cross-source identity match in the first
release. A normalized `brand + name + flavour + net quantity` key may create an
automatic match only when every component is present and exactly equal after
conservative normalization. Fuzzy names and image similarity are suggestions,
not writes.

### Ingest broadly, classify later

The Open Food Facts adapter accepts all records tagged for India when practical.
It does not prefilter to protein keywords. Classification produces independent
states for:

- marketed as protein;
- nutritionally protein-dense;
- classification completeness.

A record may be both, either, neither, or unknown. Category remains a shopping
context rather than a proxy for nutritional quality.

### Deterministic source selection

Field observations carry `confidence`, `observed_at`, and a source authority
rank configured per field family. Default nutrition authority is current
verified package label, then DataKart, then brand owner, then Open Food Facts,
then retailer. Identity authority gives validated GTIN priority over inferred
attributes. A lower-ranked observation cannot replace a higher-ranked selected
value unless an operator explicitly verifies it or the higher-ranked value is
withdrawn. Every selection decision records the winning observation.

Confidence describes evidence quality; it is not derived solely from source
name. A stale or internally inconsistent official record may still be held for
review.

Nutrition has a separate state machine: `missing`, `unverified`, `verified`, or
`conflict`. Community values can populate an unverified candidate but cannot
become verified solely through successful parsing. Verification requires either
a permitted current DataKart/brand-owner record or a human-confirmed current
package label, plus validation rules passing. Conflicting high-authority sources
produce `conflict`, never last-write-wins. Trusted rankings default to verified
nutrition only; other products remain discoverable with an explicit reason.

Nutrition observations preserve basis (`per_100g`, `per_100ml`, `per_serving`),
as-sold versus prepared state, serving size, units, and label date. The importer
normalizes to per 100 g only when the source supplies enough unambiguous data.
It rejects impossible protein/macronutrient amounts, totals far above 100 g,
non-positive energy, serving/pack inversions, and material calorie-versus-macro
inconsistency when all relevant macros exist.

### Scheduled sync stages evidence before publication

Add a weekly and manually dispatchable GitHub Action. A provider-neutral CLI
streams a source export, selects India-tagged records, normalizes records, and
emits:

- a compressed source snapshot or chunked artifacts;
- an import manifest with source version, hashes, counts, timestamps, and
  adapter version;
- a validation and classification report;
- a D1-compatible staged import file for later application.

Open Food Facts daily export is the credential-free adapter. It is open and
current enough to exercise the pipeline, but remains medium confidence. DataKart
is a separate adapter contract and is disabled with an actionable status until
commercial credentials, schema documentation, and permitted retention behavior
are known.

The workflow does not directly mutate the production database. This avoids
turning an upstream error or compromised source into an irreversible publish.
A future protected apply job may consume a reviewed artifact after Cloudflare
credentials and approval rules are configured.

Alternative considered: query the Open Food Facts search API for every sync.
The official guidance asks bulk consumers to use exports, and API rate limits
make broad Indian-market discovery unsuitable for repeated search calls.

### Metrics are pure functions with unavailable states

All derived metrics live in a dependency-free domain module. Division requires
finite positive denominators. Values are not fabricated from serving-size data
when a valid per-100-g conversion is unavailable. Validation flags impossible
or suspicious data before metrics are ranked. The API returns `null` plus
machine-readable reasons for unavailable metrics.

### Local proof before cloud provisioning

The repository includes a small evidence-rich fixture source file and a local
D1 migration/seed path. Tests prove domain behavior and importer idempotency;
the built Worker and SPA prove deployment compatibility. Creating D1/R2
resources and deploying remain explicit later actions.

## Risks / Trade-offs

- **Open Food Facts country tagging is incomplete** → retain source manifests,
  support brand/DataKart adapters, and allow operator submission rather than
  claiming completeness.
- **All-food export processing is large for hosted runners** → stream compressed
  input, avoid loading the export into memory, chunk artifacts, cache downloads,
  and report runner time/bytes.
- **DataKart access may impose retention or display limits** → keep its adapter
  disabled until the signed terms are reviewed; never assume the open-data
  adapter's behavior applies.
- **Exact composite matching can still merge rebrands** → require every
  component, record the rule, and send conflicts to review; GTIN remains
  preferred.
- **D1 full-text/search limits may emerge at larger scale** → start with indexed
  normalized columns and bounded queries; add a search service only after
  measured need.
- **A scheduled upstream failure could look like mass deletion** → treat empty or
  sharply reduced snapshots as failed runs and never emit deletion operations.
- **Nutrition units and prepared-vs-dry bases are often wrong** → store basis and
  preparation state, reject inconsistent conversions, require current label or
  permitted official evidence for verification, and exclude unresolved records
  from trusted rankings.
- **Review queues can grow faster than operators can resolve them** → expose
  priority by demand, conflict severity, confidence gap, and metric impact.

## Migration Plan

1. Apply the initial migration to local D1 and load only fixture evidence.
2. Run the Open Food Facts adapter against a bounded sample and verify the
   manifest, anomaly counts, and idempotent re-import.
3. Enable the scheduled workflow to publish artifacts only.
4. Review and import the first 500 high-demand products locally.
5. Provision D1/R2 and add a protected apply workflow only after explicit deploy
   approval and source-license review.

Rollback is file- and migration-based before production exists. After
production, every import remains tied to an ingestion run so selected values can
be recomputed from prior observations rather than deleting evidence.

## Open Questions

- What DataKart API transport, delta/update mechanism, field schema, rate limits,
  and retention/display terms are granted to the registered account?
- Should the first public surface expose all ingested foods or only protein
  cohorts while operators retain access to all records?
- Which quick-commerce provider offers an acceptable authorized contract for
  pincode-specific price and availability after the catalog core is stable?
