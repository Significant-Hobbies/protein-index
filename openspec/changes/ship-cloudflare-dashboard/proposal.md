## Why

Protein Index has a proven catalog core but no public, production-backed product
surface. The first release is only useful when people can explore the real
source catalog through a polished, responsive dashboard that is honest about
evidence quality and is deployed safely on Cloudflare.

## What Changes

- Turn the existing operator-first shell into a visually refined, responsive
  catalog dashboard with clear hierarchy, useful overview metrics, strong empty
  states, and an evidence-first product detail experience.
- Keep trusted comparisons restricted to verified nutrition while making the
  broader Open Food Facts discovery catalog easy to explore without implying
  that community evidence is authoritative.
- Add a production publication path that imports a reviewed, source-complete
  snapshot into D1 idempotently and records the published run.
- Provision one Cloudflare Worker, one D1 database, and one private R2 bucket;
  apply versioned migrations and deploy the built Vite/Worker application.
- Keep production review mutations disabled until operator authentication
  exists, while retaining a useful read-only evidence and coverage surface.
- Add a guarded repository deploy command and a GitHub workflow path that can
  refresh source artifacts automatically without silently publishing a broken
  or materially incomplete snapshot.
- Verify the deployed dashboard at desktop and mobile widths, including its
  loading, empty, error, unverified, and product-detail states.

## Capabilities

### New Capabilities

- `cloudflare-dashboard`: A beautiful, accessible, responsive public catalog
  dashboard backed by the deployed Worker and D1 database, with explicit trust
  boundaries and production-safe read behavior.
- `catalog-publication`: Reviewed snapshot publication, deployment guards,
  Cloudflare resource bindings, remote migration/import validation, and a safe
  path from scheduled source artifacts to the hosted catalog.

### Modified Capabilities

- None. The catalog-core specifications are still active change artifacts and
  are not yet archived into the main specification set.

## Impact

- Changes the React application layout and presentation, Worker health metadata,
  catalog defaults, and production empty/error messaging.
- Adds production-oriented scripts and documentation but no new production
  dependencies.
- Creates Cloudflare Worker, D1, and R2 resources in the authorized account and
  applies the existing SQL migrations to a new remote database.
- Publishes Open Food Facts records as explicitly unverified discovery evidence;
  it does not promote them to verified nutrition or claim Indian-market
  completeness.
- Leaves DataKart, retailer integrations, label verification, authenticated
  review writes, and custom-domain setup as separate follow-up work.
