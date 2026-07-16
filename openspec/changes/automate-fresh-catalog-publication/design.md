## Context

The repository already exhausts the Open Food Facts India-tagged bulk export weekly and fans a successful snapshot out to richer API enrichment plus nutrition- and ingredient-label extraction. All four jobs produce checksummed, source-complete artifacts, but each production publication is currently a separate manual dispatch. As a result, retrieval is automatic while the deployed catalog, selected unverified nutrition/ingredients, and review queues can remain stale indefinitely.

Production D1 already contains a 716 MB append/reconciliation-oriented evidence database. Publication is idempotent by source record and canonical identity, preserves raw evidence, and selects values by authority and observation time. The current generic publication command applies migrations before import, and equal-authority newer nutrition can replace a richer selected record; both behaviors are too permissive for unattended writes.

## Goals / Non-Goals

**Goals:**

- Publish complete discovery, enrichment, and review-only extraction artifacts automatically after successful trusted workflow runs.
- Keep every automatic fact unverified unless an exact manual decision already exists.
- Fail closed on trigger drift, artifact drift, incomplete accounting, excessive discovery drops, pending migrations, or postcondition failure.
- Preserve higher-authority evidence and prevent equal-authority freshness from reducing selected nutrition completeness.
- Serialize writes, make replay harmless, and retain enough evidence to audit or manually recover every run.

**Non-Goals:**

- Automatically verify nutrition or ingredients.
- Automatically accept fuzzy identity matches or terminal unavailable outcomes.
- Publish DataKart, brand, retailer, offer, rating, or ONDC data.
- Apply D1 migrations, deploy Worker code, or change the public API contract.
- Remove the existing exact manual publication workflows.

## Decisions

### Use one workflow-run publication router

Add a dedicated workflow triggered by successful completion of `Source sync`, `Enrich Open Food Facts evidence`, `Extract label evidence with Robotoff`, and `Extract ingredient label evidence`. A small fail-closed mapping selects the only permitted artifact name and manifest source for each upstream workflow. The job checks out the exact upstream head SHA, requires the default branch, downloads the exact run artifact, and uses the existing protected `production` environment for credentials and audit history.

Alternative considered: make each producer write D1 directly. That duplicates credentialed logic and allows several uncoordinated write paths. Alternative considered: publish only bulk discovery. That leaves the materially richer API nutrition/ingredient evidence and review candidate queues stale.

### Add an explicit automatic-evidence publication mode

Extend the publication CLI with a mode that requires an expected source family, a fixed 20 percent maximum discovery-drop ceiling, and `--skip-migrations`. The validator streams staged JSONL to prove that automatic artifacts contain only permitted unverified/review-only states. It rejects verified staged facts, decision payloads, unsupported sources, checksum drift, and unreconciled cohorts before SQL generation.

The manual command retains its existing explicit remote confirmation and migration behavior for recovery. Automatic mode is additive and intentionally harder to invoke.

Alternative considered: encode all checks only in YAML. Central TypeScript validation is testable locally and cannot be bypassed by calling the CLI from a different workflow.

### Refuse pending schema changes

Before automatic import, query remote migration state and fail if any migration is pending. The CLI then runs without applying migrations. This keeps schema changes within the fleet's manual production-change boundary.

Alternative considered: automatically apply compatible migrations. Artifact publication is not sufficient review authority for schema mutation.

### Make equal-authority nutrition selection completeness-monotonic

Retain all source observations, but update the selected `nutrition_facts` row at equal authority only when the incoming observation is newer and has at least as many populated normalized nutrient fields as the current selection. Higher authority still wins; exact reviewed decisions remain authority 100 and existing drift invalidation remains active.

Alternative considered: rely on API enrichment to run after every bulk import. Jobs may fail independently, and the interim bulk selection can otherwise erase richer displayed data.

### Share the existing production publication lock

The automatic router and every manual publication workflow use `protein-index-production-publication` with `cancel-in-progress: false`. This serializes D1 imports while allowing source retrieval/extraction to continue in parallel.

### Treat postconditions as release evidence

Before import, record active product/source-record/review/verified counts. After import, query the exact source and input hash, require its ingestion run to be completed and source-complete, require non-empty/non-regressing canonical evidence counts, and require verified nutrition/ingredient counts not to increase. Query live health plus one bounded catalog request. Upload inputs, hashes, pre/post state, CLI output, and diagnostics with 90-day retention even on failure.

If a write fails midway, do not attempt destructive rollback. The generated SQL is replay-safe, so the workflow fails visibly and the exact artifact can be replayed after investigation through the same serialized path.

## Risks / Trade-offs

- **A valid upstream change can still be undesirable** → fixed continuity ceiling, exact source/cohort accounting, evidence-only states, authority precedence, and durable postconditions limit blast radius.
- **Four weekly publication families increase Actions and D1 usage** → reuse artifacts already being generated, serialize only write phases, and keep the weekly cadence.
- **Remote D1 imports are not one cross-file transaction** → validate everything possible pre-write, keep SQL idempotent, fail without claiming success, and recover by exact replay rather than deletion.
- **Source drift can reduce verified coverage** → this is intentional when exact reviewed evidence no longer matches; the workflow records verified deltas and drift reviews.
- **Equal-authority completeness is a coarse quality proxy** → use it only to prevent obvious field loss; conflicts and provenance remain visible for semantic changes.
- **GitHub environment protection could later require approval** → the path remains safe and auditable but would become approval-gated rather than fully automatic; that is preferable to bypassing the environment.

## Migration Plan

1. Add automatic-mode validators and unit tests, including unsupported source, verified-state, excessive-drop, checksum, and equal-authority completeness cases.
2. Refactor publication execution so migrations can be explicitly skipped and add exact pre/postcondition helpers.
3. Add the workflow-run publication router and static workflow-contract tests.
4. Update README and `PROJECT_STATUS.md`; validate the OpenSpec change and run the full release preflight.
5. Commit and push to `main`, wait for green CI, then manually dispatch `Source sync` once to prove the complete automatic chain.
6. Monitor the four source/evidence artifacts and their serialized publication runs; verify live counts, trust states, freshness, and replay behavior.
7. Keep the workflow enabled for the next scheduled run only after the proof run reconciles exactly.

Rollback is to disable the automatic router in a normal reviewed commit. Do not delete evidence. If selection is wrong, publish the prior exact good artifact or a corrected newer artifact through the manual path; stronger verified evidence remains protected by authority rules.

## Open Questions

- Whether the weekly API enrichment duration and GitHub Actions cost remain acceptable after the first scheduled proof run.
- Whether future DataKart terms permit the same automatic evidence-publication model; it remains excluded until the commercial contract and schema are reviewed.
