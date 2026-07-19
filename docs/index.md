---
title: Protein Index docs
description: Repository knowledge system for the Protein Index project.
---

# Protein Index docs

This is the canonical, local-first knowledge system for the Protein Index
repository. The Markdown files in `docs/` are the source of truth; the
[Blume config](../blume.config.ts) is only the presentation and search layer.

For the always-loaded agent bootloader, see [`AGENTS.md`](../AGENTS.md). For the
durable, append-only product timeline, see
[`PROJECT_STATUS.md`](../PROJECT_STATUS.md). For the short current-state view,
see [`STATUS.md`](../STATUS.md).

## Where to start

| You want to | Read |
| --- | --- |
| Understand what the product is and is not | [Product overview](product/overview.md) |
| See evidence states and trust boundaries | [Evidence policy](product/evidence-policy.md) |
| Learn how the whole system works end to end | [How it works](architecture/how-it-works.md) |
| Understand the system and data flow | [Architecture](architecture/overview.md) |
| See why a design choice was made | [Decision log](architecture/decisions/README.md) |
| Set up and run the project locally | [Development](development/README.md) |
| Run or reason about scheduled jobs | [Operations](operations/README.md) |
| Publish reviewed evidence to production | [Publication runbook](operations/runbooks/publication.md) |
| Recover from a failed extraction run | [Extraction runbook](operations/runbooks/extraction.md) |
| Learn from past mistakes | [Failed approaches](knowledge/failed-approaches.md) |
| See what is true right now | [STATUS.md](../STATUS.md) |

## Documentation map

```
docs/
  index.md                      this file
  product/                      what the product is, scope, sources, evidence
  architecture/                 system, data model, pipeline, decisions
  architecture/decisions/       distilled ADRs (full proposals live in openspec/)
  development/                  local dev, tests, data scripts, contributing
  operations/                   workflows, jobs, runbooks, publication gates
  operations/jobs/              per-scheduled-job reference
  operations/runbooks/          step-by-step operator procedures
  knowledge/                    durable learnings and failed approaches
  current/                      pointers to the live current-state view
```

## Maintenance rules

1. Markdown in this tree is the source of truth. Code and executable
   configuration (wrangler, migrations, workflows) remain authoritative for
   implementation details and schedules; do not duplicate those facts here.
2. One fact, one home. If a fact lives in `PROJECT_STATUS.md`, `README.md`, or
   code, link to it instead of restating it.
3. Mark unresolved questions explicitly with `> **Unresolved:**` callouts.
4. Do not create empty placeholder pages. Every file must contain useful
   content.
5. Run `pnpm docs:validate` before committing documentation changes. CI runs
   the same check on every push and pull request.
6. When archiving a doc, move it to `docs/archive/<name>.md` and preserve git
   rename history rather than deleting.
