## Context

The publishable nutrition-v8 and ingredient-v3 artifacts introduce exact
attempt, label-asset, and SHA-256 bindings. The active repository decisions were
reviewed against the same numeric Open Food Facts image URLs and have identical
canonical candidates, but they predate the byte ledger. Their drift reports
contain 312 nutrition and 66 ingredient
`source_revision_drift_candidate_unchanged` findings, all with valid current
proof and no other difference. Mutating those legacy rows would make a false
historical claim, while publishing the artifacts without replacements would
remove 23 verified nutrition and 65 verified ingredient selections.

Nutrition reconciliation already deactivates a source-hash-drifted active
decision. Ingredient reconciliation invalidates the projection but leaves the
decision active, which conflicts with the partial unique index on active source,
candidate, and family keys and prevents an exact replacement from publishing.

## Goals / Non-Goals

**Goals:**

- Turn an explicit operator re-attestation into new immutable exact-link
  decisions with reproducible inputs and outputs.
- Admit only source-revision-only drift with a complete current proof chain.
- Prove the replacement set is complete, family-pure, checksum-valid, and
  exact-link-valid before proposing it as active.
- Make nutrition and ingredient stale-decision supersession symmetric.
- Preserve the separation between review authority and production authority.

**Non-Goals:**

- Automatically deciding whether a label is correct.
- Treating candidate, identity, URL, or proof drift as eligible.
- Retrofitting a byte hash into an old decision or changing historical bundles.
- Publishing D1 data, applying migrations, or deploying as a side effect of
  bundle generation.
- Claiming complete catalog verification from 378 reviewed candidates.

## Decisions

### Generate from the validated artifact and active set, not a hand-built map

The command will accept an artifact directory, review-bundle root, active-set
file, output root, fixed reviewer identity and timestamp, and an exact
confirmation phrase. It will run the current artifact validator and decision
drift audit, then require every selected finding to be source-revision-only with
`proofValid=true`. This avoids trusting a separately assembled CSV or copying
fields from logs.

The alternative—manually editing JSONL—was rejected because it cannot prove
complete selection or prevent cross-family, duplicate-key, and stale-link
errors.

### Require deterministic operator inputs

The operator supplies `decidedBy` and an ISO timestamp. New IDs derive from the
predecessor ID plus current source hash, attempt ID, asset ID, actor, and
timestamp. Given the same artifact and inputs, bundle contents and IDs are
stable. The predecessor decision and reviewed payload are preserved; the
rationale appends a bounded lineage statement naming the predecessor and exact
artifact run.

An implicit current timestamp was rejected because it would make a dry run and
approved run produce different ledgers.

### Emit proposed state, never silently replace tracked state

The command writes one checksummed bundle for the requested family, a detailed
eligibility report, and `active-bundles.next.json`. It does not edit
`review-decisions/active-bundles.json`. The tracked manifest is changed only in
a reviewed commit after both family bundles audit to `exact_link_valid` and the
old directories remain immutable history.

### Deactivate stale ingredient decisions during source replay

Ingredient reconciliation will defer an `active=0` update for the same drift
predicate already used to invalidate its selected projection, and only when no
exact current decision exists. This mirrors nutrition, preserves append-only
history, and frees the active unique index for the new immutable decision.

Deleting the old decision or weakening the unique index was rejected: both
would reduce auditability and allow contradictory active decisions.

### Serialize release authority boundaries

The intended release order is:

1. Commit the exact replacement bundles and active manifest after local audit.
2. Obtain separate production approval.
3. Apply pending migrations.
4. Publish the nutrition-v8 and ingredient-v3 artifacts.
5. Publish the two exact replacement bundles and verify reviewed counts/replay.
6. Deploy and verify live API, completion, Trusted, desktop, and mobile state.

The artifact publisher remains unable to apply human decisions, and the review
publisher remains unable to select an uncommitted or source-drifted bundle.

## Risks / Trade-offs

- [Operator confirmation could be mistaken for semantic review] → Name the
  command and rationale as lineage re-attestation, retain predecessor identity,
  and reject every semantic or proof difference.
- [A partial replacement could silently reduce verified coverage] → Require
  exact selected-decision counts and an all-`exact_link_valid` audit before the
  next manifest is eligible.
- [Artifact publication temporarily deactivates old decisions] → Serialize the
  two publishers, precompute replacement bundles, and verify restoration before
  deployment completion.
- [Open Food Facts removes an image] → The current artifact already retains the
  exact content hash and proof metadata, but any missing or mismatched current
  asset makes generation fail closed.
- [Ingredient cleanup could deactivate a valid exact decision] → Gate cleanup
  on the same source/product/candidate drift predicate and absence of an exact
  current decision, with replay tests for both paths.

## Migration Plan

1. Add the offline generator, report schema, CLI route, and fail-closed tests.
2. Add ingredient stale-decision deactivation and local D1 replay coverage.
3. Generate both proposed bundles from artifacts `8414045970` and `8414036638`
   only after explicit operator re-attestation.
4. Audit the proposed active set for 312 and 66 exact links, then commit it.
5. After separate production approval, run the serialized publication and
   deployment sequence with pre/post evidence.

Rollback before production is removal of the proposed bundle selection; all
historical bundles remain untouched. After artifact publication, rollback must
not reactivate stale decisions blindly: publish the reviewed exact replacements
or leave the affected fields visibly unverified/conflicted.

## Open Questions

- The exact operator identity and timestamp remain inputs to the authorized
  re-attestation and are intentionally not inferred by code.
