## Context

The dashboard currently sends catalog requests from its filter panel. The API
already supports token search across canonical identity and discovery metadata,
but the control is below the hero and is inconvenient for a quick product
existence check.

## Goals / Non-Goals

**Goals:**

- Make product lookup visible on every dashboard tab and usable by keyboard.
- Reuse the read-only catalog API, existing search validation, and product
  drawer; do not create a second search index.
- Avoid excessive requests through a short debounce and minimum query length.

**Non-Goals:**

- Submitting missing products, crawling a retailer URL, or making catalog
  writes from the dashboard.
- Changing the full catalog filter/search behavior or source-completeness
  claim.

## Decisions

### Use a header combobox backed by the existing catalog endpoint

The lookup requests the existing catalog API with a small result limit and
`scope=all`, so it finds any retained product regardless of the active catalog
filters. A bespoke endpoint or local index would create duplicate matching
semantics and a cache-invalidation burden.

### Preserve the full search as the no-exact-match path

Selecting a result opens the existing product drawer. Submitting when there is
exactly one result does the same; otherwise the app switches to Catalog and
sets the existing full-search filter. This makes the control fast without
hiding ambiguity.

### Keep lookup client-only and fail quietly

The lookup is a convenience layer. Its error state is shown in the popup while
the rest of the dashboard remains usable; it neither changes active filters
until explicit submission nor blocks normal catalog loading.

## Risks / Trade-offs

- [Short queries create noisy, frequent requests] → Start lookup at two
  normalized characters and debounce it.
- [A small result list can hide valid matches] → Submitting the query always
  opens the complete filtered catalog.
- [Header crowding on small screens] → Collapse the nonessential source pill
  before constraining the full-width lookup control.
