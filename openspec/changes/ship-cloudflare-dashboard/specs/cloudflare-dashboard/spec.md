## ADDED Requirements

### Requirement: Dashboard is visually coherent and responsive
The web application SHALL provide a deliberate visual hierarchy, readable data
density, accessible contrast and focus states, and layouts that remain usable at
mobile and desktop widths without horizontal page overflow.

#### Scenario: User browses on a phone
- **WHEN** the catalog is opened at a narrow mobile viewport
- **THEN** primary search, trust controls, product identity, evidence status, and detail actions remain readable and operable without horizontal page scrolling

#### Scenario: User browses on a wide desktop
- **WHEN** the catalog is opened at a desktop viewport
- **THEN** comparison data uses the available width with aligned columns, clear grouping, and restrained line lengths

### Requirement: Trust modes never blur evidence quality
The dashboard SHALL distinguish a verified-only trusted mode from broad
discovery and SHALL NOT silently include unverified or conflicting nutrition in
trusted comparisons.

#### Scenario: No verified products are available
- **WHEN** trusted mode returns zero products but discovery records exist
- **THEN** the dashboard explains the verification gap and offers an explicit action to explore unverified discovery records

#### Scenario: User explores community evidence
- **WHEN** the user selects all-evidence discovery
- **THEN** every affected record displays its evidence state and unavailable trusted metrics are not fabricated

### Requirement: Dashboard states are useful and honest
The dashboard SHALL provide polished loading, empty, error, unavailable,
unverified, verified, conflict, and stale-evidence states with a clear next
action where one exists.

#### Scenario: Catalog request fails
- **WHEN** the Worker API returns an error or cannot be reached
- **THEN** the page preserves its structure, explains that data could not be loaded, and offers a retry action

### Requirement: Product detail preserves evidence context
The product detail surface SHALL prioritize canonical identity, nutrition and
ingredient evidence status, metric inputs, source attribution, observation
dates, and completeness gaps before secondary retailer information.

#### Scenario: User inspects an unverified product
- **WHEN** a discovery record has community nutrition and ingredients
- **THEN** detail identifies the source and unverified state without presenting the values as label-verified facts

#### Scenario: User inspects supporting evidence
- **WHEN** product detail includes a public label image or evidence URL
- **THEN** the detail surface provides an explicit link to that evidence and exposes pack, serving, and additional nutrient values already present in the canonical response

#### Scenario: Retailer information is absent
- **WHEN** a product has no current offer or retailer rating
- **THEN** product detail states that the data is unavailable instead of rendering an unexplained blank section

### Requirement: Public evidence queue is fully traversable
The read-only evidence queue SHALL expose deterministic pagination and evidence
type filtering so every unresolved item can be reached without enabling public
review mutations.

#### Scenario: Queue contains more than one page
- **WHEN** the number of matching review items exceeds the page size
- **THEN** the response includes total and page metadata and the dashboard provides previous and next controls

#### Scenario: User narrows the queue
- **WHEN** the user selects an evidence type
- **THEN** the Worker returns only matching items and preserves deterministic priority ordering within the selected page

### Requirement: Catalog exposes both evidence dimensions
The catalog SHALL let users filter nutrition and ingredient verification states
independently so a verified nutrition claim does not imply verified ingredients.

#### Scenario: User requests fully verified records
- **WHEN** the user selects verified nutrition and verified ingredients
- **THEN** the Worker returns only products with both evidence states verified

#### Scenario: User audits missing ingredients
- **WHEN** the user selects missing ingredient evidence
- **THEN** products without an ingredient statement remain discoverable without changing the nutrition filter

### Requirement: Public deployment is read-only without authentication
The production Worker SHALL serve catalog, detail, coverage, and health reads
but SHALL reject review resolution or other operator mutations until an
authentication boundary is implemented.

#### Scenario: Anonymous client submits a review decision
- **WHEN** a public-host request attempts to resolve a review item
- **THEN** the Worker returns a structured forbidden response and does not mutate D1

### Requirement: Live deployment is observable and verifiable
The deployed Worker SHALL expose structured health metadata, use configured logs
and sampled traces, and serve the SPA and API from one HTTPS origin.

#### Scenario: Post-deploy smoke check runs
- **WHEN** the deployment URL is queried for the root document and health endpoint
- **THEN** both succeed and health reports the bound catalog count and production runtime
