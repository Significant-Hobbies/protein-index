## ADDED Requirements

### Requirement: Complete official-brand cohorts are prepared with exact provenance
The system SHALL prepare a publication cohort only from every configured
official-brand artifact of one successful discovery workflow run. It MUST verify
artifact identity, checksums, source completeness, terminal evidence, and
per-source record/exclusion accounting before producing publishable SQL.

#### Scenario: All configured source artifacts are complete
- **WHEN** every configured brand artifact from the selected run is present,
  checksummed, and source-complete
- **THEN** the preparer SHALL emit a composite manifest that retains each
  constituent source manifest and exact artifact digest

#### Scenario: One configured source is incomplete or absent
- **WHEN** any configured brand artifact is missing, expired, malformed, or
  not terminally source-complete
- **THEN** the preparer SHALL reject the cohort before producing import SQL

### Requirement: Publication preserves source-specific canonical evidence
The system SHALL import every validated constituent manifest through one
D1-compatible generated import file, retaining each original source ID on its
source records, offers, and raw evidence. It MUST use existing GTIN-first and
deterministic composite identity resolution and MUST retain unresolved products
for review.

#### Scenario: A newly discovered product has no existing identity match
- **WHEN** a validated brand record has neither an exact GTIN nor a deterministic
  composite match
- **THEN** the importer SHALL create a canonical discovery product with its
  first-party source record and any source-scoped offer

#### Scenario: Two sources identify the same GTIN
- **WHEN** a validated official-brand record and an existing catalog record
  declare the same GTIN
- **THEN** the importer SHALL attach the new source record to the canonical
  product without duplicating it

### Requirement: Publication is guarded, idempotent, and independently proven
The system SHALL provide a manually dispatched protected publication workflow
that accepts only an exact successful official-brand workflow run and a hard
confirmation input. It MUST validate the full cohort before remote credentials,
refuse pending schema migrations, serialize production writes, and verify
source/product/offer postconditions after publication.

#### Scenario: Valid confirmed publication
- **WHEN** the selected run, artifact cohort, branch ancestry, and confirmation
  are valid and the production schema is current
- **THEN** the workflow SHALL write the source set idempotently and upload
  durable pre/post publication diagnostics

#### Scenario: Replaying an identical cohort
- **WHEN** the same validated official-brand cohort is published again
- **THEN** the resulting canonical product, source-record, and offer counts
  SHALL not duplicate records

### Requirement: Discovery coverage remains truthful
The system SHALL report the configured official-brand source set and its
source-complete status separately from market completeness. It MUST NOT promote
unverified discovery nutrition or ingredients into Trusted ranking eligibility.

When a source declares candidate URL terms, the system SHALL exclude sitemap
product URLs outside that declared boundary before fetching them, record each
exclusion, and retain page-level product-name validation for fetched candidates.

#### Scenario: A shopper views a newly published discovery product
- **WHEN** the product only has first-party discovery evidence
- **THEN** the API SHALL expose its evidence status as unverified and the
  dashboard SHALL not describe the configured-source lane as exhaustive India
  market coverage
