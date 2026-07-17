## Context

The repository already contains a Cloudflare-compatible React SPA, Hono Worker,
D1 schema, local fixtures, and a source-complete Open Food Facts India snapshot.
The current surface is dense and operator-oriented, and its trusted default can
return no rows when the production catalog contains only community evidence.
Cloud resources have not been provisioned, the Wrangler D1 identifier is a
placeholder, and the scheduled sync intentionally stops at reviewed artifacts.

The release must preserve the product's most important promise: an attractive
interface must not make unverified nutrition look accurate. It must also follow
fleet deployment controls: clean synced `main`, green CI, known target, guarded
manual deployment, and one Worker per product surface.

## Goals / Non-Goals

**Goals:**

- Ship a polished catalog that works from phone through wide desktop.
- Make evidence quality understandable without requiring database knowledge.
- Publish the latest reviewed complete snapshot into D1 without changing its
  verification state or losing run provenance.
- Make resource creation, migrations, import, deploy, and post-deploy checks
  reproducible and fail closed.
- Keep the public Worker read-only where operator authentication is absent.

**Non-Goals:**

- Claiming that Open Food Facts is authoritative or market-complete.
- Adding invented nutrition, ratings, prices, or synthetic products to make the
  dashboard appear fuller.
- Automatically verifying community nutrition.
- Building authenticated operator access, DataKart, retailer collection, label
  OCR, or a custom domain in this release.
- Adding a component library, charting package, or other production dependency.

## Decisions

### Use one public catalog with explicit trust modes

The default dashboard will summarize the whole discovery catalog, while the
results view will offer a prominent `Trusted` mode and an `All evidence` mode.
Trusted mode remains verified-only and is never silently widened. If no verified
rows exist, the UI explains why and offers a deliberate switch to discovery
records. Every community-derived row retains an unverified badge and comparison
metrics remain unavailable when inputs are not trustworthy.

Alternative considered: default to all evidence and rely on small badges. That
would make the first screen busier, but risks users treating rankings as facts.
Alternative considered: show only an empty verified table. That protects trust
but fails the usability and discovery goals.

### Refine the existing React surface without a UI dependency

Keep the existing semantic HTML and CSS architecture. Improve the visual system
through typography, spacing, contrast, data hierarchy, responsive layouts,
progressive detail, and purpose-built lightweight SVG/CSS marks. This avoids
bundle and maintenance cost while retaining full control over a data-dense
interface.

The landing state will have a restrained editorial identity, a compact source
health strip, useful catalog KPIs, a clear trust switch, and product rows/cards
that prioritize brand, name, evidence, and the next useful action. Operator
coverage and review information remains available but secondary to browsing.

The public evidence queue remains read-only, but it must expose deterministic
pagination and evidence-type filtering so every unresolved record is reachable.
Product detail must link to the stored label image and evidence URLs when they
exist, show pack/serving and additional nutrient data already present in the API,
and provide explicit empty states for absent retailer information.
Catalog filtering keeps nutrition and ingredient evidence as separate axes; a
verified nutrition record never silently implies a verified ingredient statement.

### Publish reviewed snapshots through a dedicated CLI command

Add an idempotent `publish` path that accepts a manifest/staged snapshot pair,
validates their checksums and source-complete accounting, generates the existing
reconciliation SQL, applies it to the selected D1 target, and verifies counts.
The command must require explicit remote mode; local mode remains the default.
Remote publication records the ingestion run and does not delete products merely
because an upstream snapshot omits them.

Alternative considered: ship the local fixture database. It would misrepresent
synthetic evidence as a live catalog. Alternative considered: let the scheduled
workflow write directly to D1. That makes an upstream failure a production write
without a review boundary.

### Separate automatic retrieval from production publication

The existing weekly workflow continues to fetch and prove a full source
snapshot automatically. A protected/manual publication job may consume a
specific successful artifact after checks and deployment credentials exist.
This gives freshness without turning every upstream change into an unreviewed
production mutation. The workflow records the source run and artifact identity
displayed by the dashboard.

### Provision minimal private Cloudflare resources

Create exactly one D1 database (`protein-index`), one private R2 bucket
(`protein-index-labels`), and one Worker (`protein-index`). R2 remains private
because label delivery is not implemented yet. The Worker exposes read APIs and
static assets; existing review writes remain blocked on public hosts. Logs and
sampled traces stay enabled. No custom domain is needed to meet the release gate.

### Build before Wrangler deploy and fail closed

Use the Cloudflare Vite plugin's generated `dist/**/wrangler.json` by running
`vite build` before `wrangler deploy`. The repository deploy entrypoint runs the
fleet deployment guard first and never bypasses dirty/sync/CI failures. Preflight
also regenerates Worker types, runs type/tests/build, checks Worker startup, and
performs a Wrangler dry run before remote mutation.

## Risks / Trade-offs

- **The discovery catalog is mostly unverified** → keep trusted mode strict,
  label every record, suppress unreliable comparisons, and expose verification
  coverage as a first-class KPI.
- **A 17k-record import may exceed one D1 command limit** → use Wrangler's file
  import path or deterministic chunks and verify row/run counts after import.
- **An upstream export can shrink or corrupt** → require source-complete terminal
  evidence, checksum validation, count reconciliation, and material-reduction
  guards before publication.
- **A public review surface can reveal operator evidence** → make the deployed
  app catalog-first and read-only; expose only already-public evidence URLs and
  normalized review metadata, and do not expose raw source payloads or enable
  review mutations without authentication.
- **Visual verification tooling may be unavailable** → run semantic/unit/build
  checks and retry the sanctioned in-app browser; do not substitute an
  unapproved browser backend.
- **Cloudflare resource creation is external state** → create only named minimal
  resources after authorization, capture their identifiers only in configuration,
  and verify the exact binding before migration or import.

## Migration Plan

1. Complete the dashboard and publication implementation locally against the
   fixture D1 database; run browser verification if available.
2. Regenerate Worker types, run unit/Worker tests, build, startup check, and
   Wrangler dry run.
3. Commit and push a clean `main`; wait for green CI and run the fleet deployment
   guard.
4. Confirm Cloudflare identity and existing resources, then create only missing
   D1 and private R2 resources and patch the real D1 identifier.
5. Apply migrations to the new remote D1 database and publish the reviewed full
   snapshot. Verify ingestion/product/coverage counts through direct D1 queries.
6. Build and deploy the Worker, then verify health, catalog, detail, SPA routing,
   and public mutation denial at the returned HTTPS URL.
7. Verify desktop/mobile interactions and update `PROJECT_STATUS.md` with the
   deployment URL and remaining evidence limitations.

Rollback uses Wrangler deployment rollback for the Worker. The database is new
and append/reconciliation-oriented; if publication validation fails before
deployment, do not deploy. After deployment, retain the ingestion evidence and
publish a corrected reviewed snapshot rather than deleting audit rows.

## Open Questions

- Which custom domain, if any, should replace the `workers.dev` URL later?
- Which authenticated operator model should protect review writes and raw
  evidence once human verification starts?
- Should reviewed artifact publication remain manual or require a second GitHub
  environment approval once the first production import has been observed?
