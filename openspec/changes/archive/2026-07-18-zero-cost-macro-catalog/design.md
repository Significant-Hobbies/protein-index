## Context

The repository already has three independent no-cost producer lanes: a complete
Open Food Facts India bulk snapshot, source-bounded official-brand sitemap
discovery, and a conservative local machine-label verifier. The scheduled
GitHub workflows are useful for reproducibility but are not a guaranteed
zero-cost compute source for this private repository, and none orchestrates the
three lanes for a local operator-owned machine.

The current product UI still includes current-offer and cost controls even
though the product direction is macro comparison. Production publication is a
separate guarded concern and is deliberately not a side effect of a refresh.

## Goals / Non-Goals

**Goals:**

- Create one bounded local command which records one evidence directory per
  run, refreshes Open Food Facts and configured first-party catalogs, and
  queues only current changed label images for existing machine extraction.
- Supply an installable macOS `launchd` template that runs the command weekly
  when the local model host is available.
- Preserve fail-closed macro evidence: direct declared per-100 values and
  accepted machine-label outputs can power comparison; no derived or unknown
  value can fill a macro gap.
- Focus the dashboard on protein per 100 calories, macros, evidence state, and
  discovery/search; hide price/cost choices from the consumer UI.

**Non-Goals:**

- Automatically write to production D1, deploy the Worker, or bypass the
  guarded publication workflow.
- Claim coverage of every food sold in India, scrape unaffiliated retailers, or
  use general web-search scraping as a canonical source.
- Infer nutrients, convert volumes to mass without evidence, or treat
  machine-derived values as human verification.
- Require GitHub Actions, a paid API, or a hosted model.

## Decisions

### One local orchestrator with explicit, resumable phases

Add a `data:macro-refresh` command that writes a run manifest beneath a caller
controlled data directory. It runs the existing Open Food Facts stage against a
cached bulk export, walks each configured official source in a deterministic
sequence, then creates a label candidate queue from source-complete snapshots.
It reports terminal per-source outcomes and never publishes or mutates remote
state. The command supports `--phase` and a bounded `--label-limit` so a
partial local run is resumable and does not make a failed source look complete.

This is preferred to embedding orchestration in GitHub Actions: it uses the
already-installed local model, avoids private-runner consumption, and keeps
large raw artifacts off the repository. Existing GitHub workflows remain
reproducibility/fallback producers.

### Launchd invokes the script; it does not contain business logic

Ship a parameterised plist template and install/uninstall instructions. The
template invokes a thin shell wrapper from the checked-out repository, logs to
the chosen local data directory, sets a conservative weekly calendar interval,
and prevents overlapping runs with an advisory lock. The wrapper resolves its
repository root and runs the TypeScript command; credentials and production
configuration are neither read nor required.

`launchd` is selected because the local macOS Vision extractor already anchors
the no-cost label path. A GitHub schedule alone is not selected because a
private repository has quota-bound hosted compute and cannot run the local
model.

### Source-bounded completeness is explicit

Every refresh reports coverage separately for Open Food Facts and every
configured official brand. A complete run means each enabled source reached a
terminal, source-complete manifest; it never becomes `marketComplete`.
Products lacking reliable calories or protein remain search results but receive
no density value or density rank. This maximises discovery without fabricating
macros.

### Price data remains retained, but disappears from the comparison surface

Historical offers remain in the evidence schema and API detail response to
avoid an unnecessary migration or data loss. The catalog sort menu, results
table/card, product-detail section, and consumer copy will not request or
render price/cost metrics. Protein density stays the default sort.

## Risks / Trade-offs

- [A local machine is asleep during the scheduled run] → `launchd` runs when
  next possible and the run manifest records the delayed/missed interval.
- [The full Open Food Facts export is large] → cache it with conditional HTTP,
  keep deterministic checksums, and run the expensive full pass weekly.
- [A brand site changes or fails] → preserve a terminal failed source outcome,
  do not publish it, and keep prior evidence untouched.
- [Local VLM processing is slow] → process only current queued label images,
  cache by image hash, cap model concurrency at one, and expose `--label-limit`.
- [Automatic source and machine extraction has residual error] → retain
  evidence provenance, require cross-extractor agreement, and label it
  `machine_verified`, never human `verified`.

## Migration Plan

1. Add orchestration, scheduler templates, unit tests, and dashboard/API
   presentation changes without production mutation.
2. Run a bounded local rehearsal against a small source subset and label queue.
3. Install the scheduler only when the user chooses its local data path; it is
   reversible by unloading the plist.
4. Continue using the existing guarded publication path for any selected
   source-complete, machine-evidence release. Roll back a consumer UI change by
   restoring the prior UI; retain offers and evidence records unchanged.

## Open Questions

- The user's preferred local data directory for the launchd job is environment
  specific, so the checked-in template uses placeholders rather than a
  machine-specific installed plist.
