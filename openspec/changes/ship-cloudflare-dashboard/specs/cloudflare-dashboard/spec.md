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
