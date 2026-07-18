---
title: Learnings
description: Cross-cutting operational and design lessons distilled from the project timeline.
---

# Learnings

Cross-cutting lessons that do not belong to a single failed approach. Each is
sourced from the durable timeline in
[`PROJECT_STATUS.md`](../../PROJECT_STATUS.md). Add new lessons when a pattern
repeats across runs; do not duplicate single-event failures (those go in
[failed approaches](failed-approaches.md)).

## Producer / publication separation pays off repeatedly

Every time a producer run failed (empty credentials, pending migrations,
stalled request, parser bug), the separation meant production data stayed
unchanged and the same checksummed artifact was replayable after the fix. This
is not a one-time benefit; it has held across dozens of runs. See ADR-003.

## Outcome accounting and verification completeness are different axes

A run can account for every barcode (outcome-complete) while verifying nothing
(verification-incomplete). Reporting one as the other inflates coverage. The
completion gate and the bounded-residual rule exist to keep these axes
separate in every report and API response.

## Cache keys should be source + schema, not adapter version

Parser-only fixes have replayed thousands of retained responses without
re-downloading, while schema changes correctly force a refetch. Keying on
adapter version would either over-fetch on every parser fix or silently serve
stale responses on schema changes. See ADR-009.

## D1 JSON-ledger queries need indexes before they need optimization

The coverage timeout was not a query-plan problem; it was a missing-index
problem on the JSON-backed review ledger. Adding status/type/priority and
product/source indexes (migration `0007`) reduced query duration by ~10x
without rewriting the query.

## GitHub Actions context pitfalls are durable

`runner.temp` is unavailable in job-level `env`; `workflow_run` events need
the upstream workflow name exactly; `RUNNER_TEMP` must be captured in a step
and persisted via `GITHUB_ENV`. These are not obvious and recur across
projects. When a workflow silently does nothing, check the context first.

## Live credentials are a separate failure mode from logic

Multiple publication runs failed before any D1 read because the GitHub
`production` environment supplied empty Cloudflare credentials. The workflow
correctly retained the routed workflow/run/SHA/artifact identity for 90 days
even in the missing-credential path. Treat empty credentials as a first-class
failure mode with its own diagnostics, not as a config afterthought.

## Image review is the ground truth, not the model

Every rejected candidate in the timeline was rejected by a human looking at
the exact package image, not by a model confidence score. The model is a
candidate generator; the image is the verifier. The automated lane inherits
this: it requires independent extractors to agree, not a confidence threshold.

## See also

- [Failed approaches](failed-approaches.md) for specific rejected approaches.
- [Decision log](../architecture/decisions/README.md) for the codified rules.
