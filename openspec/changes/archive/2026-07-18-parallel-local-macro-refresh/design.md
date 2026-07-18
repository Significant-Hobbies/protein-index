## Context

`runMacroRefresh` stages the Open Food Facts export and then iterates the
configured first-party brand sources serially. Each brand adapter already
enforces an allowlist, request interval, retry budget, and page ceiling, so
serial orchestration is the only cross-brand bottleneck.

## Goals / Non-Goals

**Goals:**

- Reduce wall-clock time for independent brand discovery without changing any
  source-specific request control.
- Keep every configured source represented by one deterministic terminal
  outcome, including failures.
- Preserve the existing no-remote-publication contract.

**Non-Goals:**

- Increase a single source's concurrency, request rate, or page ceiling.
- Change extraction, deduplication, machine verification, or publication.
- Claim that configured-source completion proves market completion.

## Decisions

- Use a small bounded worker pool, defaulting to four concurrent brand jobs.
  It gives a material wall-clock improvement while limiting simultaneous load
  across independent hosts. A CLI option permits operators to lower it to one
  when debugging or a network is constrained.
- Stage Open Food Facts before scheduling brand jobs. Its large, independent
  export is the stable source snapshot; brand jobs then run concurrently and
  remain individually throttled by their adapter configuration.
- Collect job results by configured source order, not completion order. This
  keeps reports, checksums, and downstream candidate queues deterministic.
- Treat an individual failure as its existing recorded terminal outcome. The
  aggregate source-bounded gate stays false and the command returns nonzero.

Alternatives considered: unbounded `Promise.all` would be faster on a small
configuration but would scale poorly as sources are added; per-host parallel
fetching would bypass the adapters' conservative rate controls.

## Risks / Trade-offs

- [A brand rate-limits or fails intermittently] → Each adapter retains its own
  request interval/retry contract and the outcome is recorded without hiding
  the source gap.
- [Results complete out of order] → Outcomes are sorted back to config order
  before reports and label discovery consume them.
- [A constrained machine needs serial diagnostics] → `--brand-concurrency 1`
  preserves serial scheduling.

## Migration Plan

1. Add the optional CLI and programmatic concurrency setting with a safe
   default.
2. Cover bounded execution, deterministic ordering, and failure accounting in
   the existing macro-refresh tests.
3. Run the local refresh and inspect its checksummed report. No database or
   hosted deployment migration is needed.
