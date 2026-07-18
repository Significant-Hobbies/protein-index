---
title: Development
description: Local setup, the single check command, data scripts, tests, and contribution rules.
---

# Development

## Requirements

- Node.js 22+
- pnpm 10

## Local setup

```bash
pnpm install
pnpm data:seed
pnpm dev
```

The seed is intentionally synthetic. It provides verified and conflict states,
plus ambiguous identity records for exercising match, create-new, and
keep-unmatched decisions without presenting test products as real market data.

## The one check command

```bash
pnpm check
```

`pnpm check` runs `cf-typegen`, `typecheck`, both test suites (`test:unit` and
`test:worker`), and `build`. CI runs the same. Do not claim work is done if
`pnpm check` is not green.

## Test layout

| Suite | Config | What it covers |
| --- | --- | --- |
| Unit / domain | `vitest.config.ts` | Pure domain logic in `shared/`, scripts, adapters |
| Worker / D1 | `vitest.worker.config.ts` | Hono routes, D1 integration via `@cloudflare/vitest-pool-workers` |

Worker tests use `test/setup-worker.ts` and `test/worker-env.d.ts`. Migration
replay/idempotency is covered by `test/migrations.test.ts`.

## Data scripts

All data scripts are invoked through `pnpm` aliases defined in
[`package.json`](../../package.json). The full set is visible there; the most
common ones:

| Script | Purpose |
| --- | --- |
| `pnpm data:seed` | Synthetic local seed |
| `pnpm data:stage` | Stage a bounded Open Food Facts sample |
| `pnpm data:enrich` | Enrich staged barcodes with richer API responses |
| `pnpm data:extract` | Extract Robotoff label candidates |
| `pnpm data:machine-label` | Offline machine label verification lane |
| `pnpm data:machine-discover` / `data:machine-run` | Machine label discovery / run |
| `pnpm data:brand-discover` / `data:brand-dedupe` | Official brand sitemap discovery / dedupe |
| `pnpm data:machine-publish-sql` / `data:machine-publish-batch` | Machine publication SQL / batch |
| `pnpm data:reclassify` | Reclassify staged products |
| `pnpm data:coverage` | Coverage report |
| `pnpm data:publish` | Validate and publish a reviewed snapshot (local; `--remote --confirm-remote` for production) |
| `pnpm data:review:export` / `:reattest` / `:live-selection-*` | Review bundle export / reattest / live selection |
| `pnpm data:guarded-release:*` | Guarded release prepare / state-query / final-state |
| `pnpm data:audit-decisions` | Read-only reviewed-decision drift audit |

> **Unresolved:** the `data:*` surface is large and grows with each feature.
> Treat `package.json` as the authoritative list; this table is a starting
> point, not exhaustive.

## D1 migrations (local)

```bash
pnpm db:migrate
```

Applies migrations to the local D1 (`--local`). Production migrations require
explicit release approval; see [data model](../architecture/data-model.md).

## Release preflight

```bash
pnpm release:startup      # Worker startup CPU profile
pnpm release:dry-run      # Wrangler deploy dry run
pnpm release:preflight    # check + startup + dry-run
```

`pnpm run deploy` runs the fleet deploy guard, then preflight, then the strict
deployment. See [operations / deployment](../operations/README.md#deployment).

## Contribution rules

- Make the smallest coherent change. Preserve unrelated dirty work.
- Run `pnpm check` and `pnpm docs:validate` before committing.
- Do not add production dependencies without explicit approval.
- Do not commit secrets, `.env*`, or local scratch under `.data/` or
  `.agent-*`.
- For non-trivial feature work, use the `spec-driven` skill and write an
  OpenSpec change proposal under `openspec/changes/`.
- Update `PROJECT_STATUS.md` when PR-sized work is completed, merged,
  superseded, or abandoned. Do not create extra status ledgers.

## See also

- [Architecture overview](../architecture/overview.md) for the code map.
- [Operations](../operations/README.md) for scheduled jobs and publication.
