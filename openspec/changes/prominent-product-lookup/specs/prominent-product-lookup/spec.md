## ADDED Requirements

### Requirement: Persistent canonical product lookup
The dashboard SHALL expose a keyboard-accessible product lookup in its header
on every tab. It SHALL query the existing canonical catalog without changing
the active catalog filters until the user selects or submits a lookup.

#### Scenario: User finds a product from any dashboard tab
- **WHEN** the user enters a valid lookup query
- **THEN** the dashboard presents matching canonical products with their brand
  and nutrition evidence state

#### Scenario: User selects a lookup result
- **WHEN** the user selects a matching product by pointer or keyboard
- **THEN** the dashboard opens that product's existing detail view

### Requirement: Ambiguous lookup remains explorable
The dashboard SHALL retain ambiguous lookup queries in the full catalog search
instead of selecting an arbitrary product.

#### Scenario: Query has multiple matches
- **WHEN** the user submits a lookup that has zero or multiple matches
- **THEN** the dashboard opens the Catalog tab with the query in the existing
  catalog search and preserves all catalog matching semantics

### Requirement: Lookup does not degrade dashboard availability
The dashboard SHALL debounce lookup requests and SHALL report lookup failure
locally without disrupting the current dashboard tab or catalog state.

#### Scenario: Lookup request fails
- **WHEN** the lookup request cannot be completed
- **THEN** the lookup reports the failure near its result list and the rest of
  the dashboard remains usable
