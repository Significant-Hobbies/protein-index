---
title: Data model
description: D1 schema narrative, migration groups, and the invariants the schema enforces.
---

# Data model

The schema lives in [`migrations/`](../../migrations/) and is applied in order.
This page is a narrative index of the migration groups and the invariants they
enforce. It is not a substitute for reading the SQL; it exists so operators and
agents can reason about what the database guarantees without re-deriving it from
19 files.

## Migration groups

| Migration | Group | What it introduces |
| --- | --- | --- |
| `0001_catalog_core.sql` | Core | Canonical GTIN products, source observations, offers, ratings, nutrition/ingredient evidence, ingestion runs |
| `0002_review_verification_evidence.sql` | Review | Review verification evidence tables |
| `0003_durable_identity_decisions.sql` | Identity | Durable match/create-new/keep-unmatched identity decisions |
| `0004_evidence_completion.sql` | Completion | Evidence completion tracking |
| `0005_evidence_decisions.sql` | Decisions | Append-only evidence decisions bound to source content |
| `0006_ingredient_evidence_decisions.sql` | Decisions | Ingredient-specific evidence decisions |
| `0007_review_queue_indexes.sql` | Performance | Status/type/priority and product/source indexes for operator queues |
| `0008_redundant_evidence_decisions.sql` | Decisions | Redundant evidence outcome handling |
| `0009_extraction_outcome_ledger.sql` | Extraction | Immutable extraction runs/assets/attempts/per-label outcomes with byte-hash binding |
| `0010_terminal_evidence_decisions.sql` | Terminal | Immutable source/hash-bound terminal unavailable evidence decisions |
| `0011_identity_evidence_decisions.sql` | Identity | Identity verification decisions bound to current source URL or retained label bytes |
| `0012_current_label_revision.sql` | Identity | Revoke prior label decisions across stable-image revision changes |
| `0013_identity_evidence_provenance.sql` | Identity | Identity evidence provenance |
| `0014_identity_evidence_projection_reconciliation.sql` | Identity | Eagerly reconcile stale identity projections |
| `0015_strict_trust_and_terminal_authority.sql` | Trust | Strict Trusted gate: exact-current identity + authority-100 nutrition + terminal ingredients |
| `0016_effective_current_evidence.sql` | Trust | Single exact-current boundary for completion, Discovery, coverage, detail, Trusted |
| `0017_set_based_current_evidence.sql` | Trust | Set-based current-evidence queries |
| `0018_reviewed_fact_time_boundary.sql` | Trust | Reviewed-fact time boundary |
| `0019_machine_verified_nutrition.sql` | Machine | `machine_verified` nutrition state for the automated label lane |

## Invariants the schema enforces

- **One canonical product per GTIN.** Retailer listings are observations, not
  identity. Identity decisions are durable and keyed to normalized identity
  evidence; they auto-invalidate when that evidence changes.
- **Append-only evidence decisions.** Verified/rejected replay is idempotent.
  Stale evidence is invalidated, not overwritten. Source drift revokes trust.
- **Exact source/hash binding.** Identity evidence must match the current
  source URL or exact retained current-label bytes. GTIN or catalog presence
  alone never marks identity verified.
- **Strict Trusted gate.** Trusted products require exact-current identity,
  authority-100 verified nutrition, and terminal ingredient evidence.
  Contradictions fail closed.
- **Mass vs volume is never collapsed.** Mass candidates are `per_100g`; liquid
  candidates are `per_100ml`. Serving rows normalize only from an explicit
  serving quantity of the same dimension. No millilitre-to-gram conversion
  without density evidence.
- **Bounded residual extraction.** A publishable artifact retains at most 10
  and at most 0.25% residual label failures, and only allow-listed post-response
  failures. Failed outcomes create no fact and no terminal-unavailable claim.

## Migration application rules

- The **manual catalog publication** path (`publish-catalog`) is the only path
  allowed to apply reviewed schema migrations.
- The **fresh-evidence publication** path refuses pending migrations and fails
  closed while the remote schema is behind.
- Local dev applies migrations with `pnpm db:migrate` (D1 `--local`).
- Production migrations require explicit release approval. See
  [`PROJECT_STATUS.md`](../../PROJECT_STATUS.md) item 15 for the current
  pending-migration set.

> **Unresolved:** which migrations are still pending in production is a
> live-state question. Cross-check `PROJECT_STATUS.md` and the live D1 schema
  before any production write.

## See also

- [Evidence pipeline](evidence-pipeline.md) for how rows enter and move through
  these tables.
- [Decision log](decisions/README.md) for the ADRs behind append-only decisions
  and strict trust.
- [`test/migrations.test.ts`](../../test/migrations.test.ts) for the
  replay/idempotency contract.
