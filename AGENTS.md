## Shared Fleet Standard

Also read and follow the shared fleet-level agent standard at `../AGENTS.md`.
Treat this repository as owned product code: protect production stability, keep
changes scoped, verify work, and record durable follow-up tasks when something
remains incomplete or blocked.

## Project

Protein Index is a normalized Indian protein-product intelligence database.
Canonical GTIN products; separate marketed and nutrition-derived protein
classification; source-aware nutrition, ingredients, offers, ratings; evidence-
first comparisons with strict Trusted / Discovery boundaries.

- **Stack:** Vite + React + Cloudflare Workers + D1 + R2
- **Package manager:** pnpm
- **Local dev:** `pnpm dev`
- **Checks:** `pnpm check` (cf-typegen + typecheck + tests + build)
- **Docs checks:** `pnpm docs:validate` (broken links + frontmatter)
- **Deploy:** `pnpm run deploy` after the reviewed data publication, clean-main,
  synced-remote, green-CI, and release-preflight gates pass. Deployment is
  manual; `main` is not an automatic production trigger.

## Critical constraints

- **Producer and publication are strictly separated.** Producer workflows have
  no production credentials and never write to D1. Publication is always a
  separate, explicitly dispatched workflow with hard confirmation. See
  [docs/operations/README.md](docs/operations/README.md).
- **Model output is never auto-verified.** Robotoff and any model output enters
  the review queue. Extraction confidence alone never increases verified
  coverage. See [docs/product/evidence-policy.md](docs/product/evidence-policy.md).
- **Mass and volume are dimensionally separate.** Never convert millilitres to
  grams without density evidence. See ADR-006 in
  [docs/architecture/decisions/README.md](docs/architecture/decisions/README.md).
- **Do not commit secrets, `.env*`, `.data/`, or local scratch.** Do not push,
  deploy, migrate, or open pull requests unless explicitly asked.
- **Catalog corrections are republished as new evidence-preserving runs**, never
  by deleting the audit trail.

## Data rules

- A canonical product is not a retailer listing.
- Preserve field-level source provenance and observation timestamps.
- Keep retailer ratings and offers source-specific.
- Never silently overwrite higher-confidence nutrition with lower-confidence data.
- GTIN matching wins over inferred name matching; ambiguous inferred matches require review.
- Raw source payloads are evidence and must remain traceable to an ingestion run.

## Documentation navigation

The repository knowledge system lives in [`docs/`](docs/index.md). Markdown in
`docs/` is the source of truth; the Blume config is only the presentation
layer.

| You need | Read |
| --- | --- |
| Always-loaded fleet standard | [`../AGENTS.md`](../AGENTS.md) |
| Durable append-only timeline | [`PROJECT_STATUS.md`](PROJECT_STATUS.md) |
| Short current-state view | [`STATUS.md`](STATUS.md) |
| Product overview and scope | [docs/product/overview.md](docs/product/overview.md) |
| Evidence states and trust | [docs/product/evidence-policy.md](docs/product/evidence-policy.md) |
| Sources and DataKart status | [docs/product/sources.md](docs/product/sources.md) |
| Architecture and data flow | [docs/architecture/overview.md](docs/architecture/overview.md) |
| Data model and migrations | [docs/architecture/data-model.md](docs/architecture/data-model.md) |
| Evidence pipeline | [docs/architecture/evidence-pipeline.md](docs/architecture/evidence-pipeline.md) |
| Decision log (ADRs) | [docs/architecture/decisions/README.md](docs/architecture/decisions/README.md) |
| Local dev and tests | [docs/development/README.md](docs/development/README.md) |
| Operations and jobs | [docs/operations/README.md](docs/operations/README.md) |
| Publication runbook | [docs/operations/runbooks/publication.md](docs/operations/runbooks/publication.md) |
| Failed approaches | [docs/knowledge/failed-approaches.md](docs/knowledge/failed-approaches.md) |
| OpenSpec change proposals | [`openspec/changes/`](openspec/changes/) |

Implementation work is tracked in `openspec/changes/`; durable product status
lives in `PROJECT_STATUS.md`. The README has the long-form product description
and CLI usage examples.

## Documentation maintenance rules

1. Markdown in `docs/` is the source of truth. Code and executable
   configuration (wrangler, migrations, workflows) remain authoritative for
   implementation details and schedules; do not duplicate those facts in docs.
2. One fact, one home. If a fact lives in `PROJECT_STATUS.md`, `README.md`, or
   code, link to it instead of restating it.
3. `AGENTS.md` stays concise — link to deeper docs rather than inlining them.
4. Mark unresolved questions explicitly with `> **Unresolved:**` callouts.
5. Do not create empty placeholder pages. Every docs file must contain useful
   content.
6. Run `pnpm docs:validate` before committing documentation changes. CI runs
   the same check on every push and pull request.
7. When archiving a doc, move it to `docs/archive/<name>.md` and preserve git
   rename history rather than deleting.
8. Update `PROJECT_STATUS.md` when PR-sized work completes, merges, is
   superseded, or is abandoned. Update `STATUS.md` each working session. Do not
   create extra status ledgers.
9. Blume (`blume.config.ts`) is only the presentation and search layer. Never
   edit generated files under `.blume/` or `dist-docs/`; they are gitignored.
