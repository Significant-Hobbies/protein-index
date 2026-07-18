## ADDED Requirements

### Requirement: Configured official source boundary
The system SHALL discover first-party product pages only from explicitly
configured HTTPS brand hosts and sitemap entry points, and SHALL reject pages,
redirects, or sitemap references outside that boundary.

#### Scenario: Off-host URL is encountered
- **WHEN** a sitemap references a product page on an unconfigured host
- **THEN** the adapter SHALL exclude it with an auditable reason and SHALL not
  fetch it as a product page.

### Requirement: Robots and traversal safety
The system SHALL read the configured host's `robots.txt` before traversal,
respect a blanket disallow rule for the configured user agent, and bound
sitemap depth, page count, response bytes, request concurrency, and configured
request pacing. It SHALL retry temporary rate-limit and server failures only
within a bounded configured retry budget.

#### Scenario: A configured brand rate-limits discovery
- **WHEN** a product-page request returns HTTP 429
- **THEN** the adapter SHALL wait according to its bounded backoff policy and
  retry only up to the configured limit; unresolved pages SHALL remain auditable
  exclusions and the source manifest SHALL be incomplete.

#### Scenario: Crawling is disallowed
- **WHEN** the applicable robots policy disallows all paths for the adapter
- **THEN** the adapter SHALL produce a failed source manifest with zero staged
  product records and SHALL not fetch sitemap or product pages.

### Requirement: Provenance-bound brand product records
The system SHALL retain the fetched product URL, observation timestamp,
content hash, raw page evidence, and source-specific image/GTIN declarations
for every staged brand product record. It SHALL accept a bounded explicit
schema.org Product declaration from either JSON-LD or HTML microdata, or a
page-bound Shopify `meta.product` JSON declaration, and record which
declaration supplied the fields.

#### Scenario: Configured source brand alias is declared
- **WHEN** a configured official source declares one of its explicit brand
  aliases in page metadata
- **THEN** the staged record SHALL use the configured source display name while
  preserving the raw declaration as provenance.

#### Scenario: Product JSON-LD includes an EAN
- **WHEN** a configured product page declares a valid EAN or GTIN in Product
  JSON-LD
- **THEN** the staged record SHALL preserve the normalized GTIN and the raw
declaration with the page content hash.

#### Scenario: Shopify product page omits JSON-LD
- **WHEN** an allowed official Shopify product page declares a parseable
  `meta.product` object in its HTML
- **THEN** the adapter SHALL retain only page-bound identity, image, and a
  positive INR variant price, with the raw `meta.product` declaration as
  provenance, and SHALL not call a storefront JSON endpoint.

#### Scenario: Shopify product page declares pack variants
- **WHEN** an allowed Shopify `meta.product` declaration contains multiple
  variants
- **THEN** the adapter SHALL stage each variant with its declared name, SKU,
  positive INR price, and variant URL, and SHALL not collapse the variants into
  the parent product record.

#### Scenario: A declared product or variant name includes a terminal pack weight
- **WHEN** an official product or variant name ends with an explicit gram or
  kilogram quantity
- **THEN** the staged record SHALL retain that quantity as the pack weight and
  SHALL NOT treat a non-terminal protein claim such as `20 g protein` as a
  pack weight.

### Requirement: Explicit official label-image discovery
The system SHALL retain a package-label image URL only when a configured
official product page explicitly labels that image as nutrition or ingredients.
It SHALL preserve the selected label URL in raw page evidence and SHALL NOT
use generic product, marketing, or unlabelled gallery images as a label.

#### Scenario: An official product page labels its nutrition panel image
- **WHEN** a product page contains an HTTPS or protocol-relative image with
  an explicit nutrition or supplement-facts label
- **THEN** the staged record SHALL retain that normalized HTTPS URL as its
  nutrition label image while leaving nutrition facts missing pending exact
  label validation.

#### Scenario: A generic product image is present without a label
- **WHEN** a product page exposes an image without an explicit nutrition or
  ingredients label
- **THEN** the staged record SHALL not treat it as either label image.

#### Scenario: A labelled page section contains an image with no alt text
- **WHEN** an official product page places an image inside an explicitly named
  nutrition or ingredients section
- **THEN** the adapter SHALL retain that image as the matching label evidence
  even when its image alt text is empty.

### Requirement: Declared brand variants remain distinct
The system SHALL stage each explicit schema.org `Product` variant in a
`ProductGroup` as a distinct source record and offer observation. It SHALL use
the variant's declared URL or stable variant identity, and SHALL NOT attach a
page-level label image to every variant without variant-specific evidence.

#### Scenario: A ProductGroup declares two flavour variants
- **WHEN** a configured product page declares two explicit Product variants
- **THEN** the adapter SHALL stage two separately addressable source records
  and SHALL not collapse them solely because their parent page is shared.

### Requirement: Conservative nutrition and offer extraction
The system SHALL stage a direct brand offer only when JSON-LD explicitly
declares a numeric price and currency. It SHALL NOT create a per-100-g or
per-100-ml nutrition fact from basis-unknown JSON-LD values, but MAY retain a
validation-passing, first-party calories-and-protein pair with `basis: unknown`
  for basis-invariant discovery metrics only.

#### Scenario: An unambiguous page nutrition table declares per 100 g
- **WHEN** an official product page contains exactly one parseable nutrition
  table with an explicit `per 100 g` column and validation-passing calories
  and protein values
- **THEN** the staged product SHALL retain the exact table as raw evidence and
  stage those values as unverified `per_100g` nutrition.

#### Scenario: A page contains multiple nutrition tables
- **WHEN** an official product page contains more than one parseable `per 100 g`
  nutrition table without a variant-specific association
- **THEN** the adapter SHALL leave its nutrition missing rather than assign a
  table to every product or variant on that page.

#### Scenario: Product page declares nutrition per serving only
- **WHEN** Product JSON-LD declares calories or protein without an explicit
  per-100-g or per-100-ml basis
- **THEN** the staged product SHALL preserve the raw declaration and, when it
  is a typed `NutritionInformation` declaration with parseable calories and
  protein that passes invariant validation, stage it as unverified with an
  unknown basis. It SHALL not make mass-normalized metrics available.

### Requirement: Accounted source traversal
The system SHALL emit a source manifest with terminal traversal evidence,
counts for fetched, staged, excluded, and failed records, and `marketComplete:
false`; a partial or failed traversal SHALL set `sourceComplete:false`.

#### Scenario: Sitemap page budget is reached
- **WHEN** discovery reaches the configured maximum product-page count before
  all sitemap URLs are processed
- **THEN** the manifest SHALL report a limit terminal state and SHALL be
  ineligible for automatic publication.
