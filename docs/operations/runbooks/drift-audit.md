---
title: Drift audit runbook
description: Run the read-only reviewed-decision drift audit before any reviewed-evidence publication.
---

# Drift audit runbook

Before preparing any review publication, audit the checked-in active decision
set against one exact, checksum-validated nutrition or ingredient artifact.
The audit is read-only, never connects to D1, and never changes review ledgers.

## When to run

- Before every reviewed-evidence publication (Path B/C in the
  [publication runbook](publication.md)).
- Producer workflows run this audit automatically before uploading publishable
  candidates and retain the report as a separate 30-day artifact even when a
  failure prevents candidate publication.

## Command

```bash
pnpm data:audit-decisions -- \
  --artifact .data/robotoff-nutrition-v8 \
  --bundles review-decisions \
  --bundle-set review-decisions/active-bundles.json \
  --output .data/nutrition-decision-drift.json
```

## What it validates

- the full artifact and each review bundle,
- collapses identical historical copies,
- fails closed on conflicting decision identities or inconsistent exact proof,
- reports drift plus current candidates that still need review.

A legacy decision that semantically matches fresh evidence is never upgraded in
place: immutable exact extraction linkage requires a newly reviewed decision.

## Forensic all-history mode

Omit `--bundle-set` for an explicit forensic all-history scan. This scans
superseded immutable bundles too and is **not** a publication proof. Use it
only for investigation.

## Failing automation on ordinary findings

Pass a comma-separated `--fail-on` list when automation should also reject
selected ordinary finding categories (not just hard proof failures). Hard
proof failures and ambiguous active decisions always stop candidate
publication regardless of `--fail-on`.

## See also

- [`scripts/audit-decisions.ts`](../../../scripts/audit-decisions.ts) for the
  implementation.
- [Publication runbook](publication.md) for what to do after the audit passes.
