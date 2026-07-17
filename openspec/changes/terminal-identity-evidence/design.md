## Context

`evidence_outcomes` already models terminal identity state, and the completion
ledger deliberately requires an explicit `identity/verified` row with a non-
empty evidence URL. Nothing currently creates a trustworthy row. Existing
`identity_decisions` resolve ambiguous source records (`match`, `create_new`,
or `no_match`), but they do not retain verification evidence, ordinary exact-
GTIN products never enter that review path, and source replay has no identity-
outcome drift contract.

The current catalog therefore reports every active identity as outstanding.
The change must close that lifecycle without equating ingestion, GTIN presence,
or an automatic resolver result with human verification. Public production
mutations remain disabled until operator authentication exists.

## Goals / Non-Goals

**Goals:**

- Let an operator verify any active product identity from an exact current
  source record and current HTTPS evidence.
- Retain an immutable, auditable decision separate from its mutable terminal
  projection.
- Make identical retries idempotent and reject conflicting attempts for the
  same exact binding.
- Rebuild or revoke the identity projection deterministically during source
  replay.
- Require successful ambiguous `match` and `create_new` resolutions to create
  the same evidence-bound verification atomically.
- Make the completion ledger prove that a `verified` identity outcome still has
  one exact current decision behind it.

**Non-Goals:**

- Infer identity verification from GTIN validity, source authority, automatic
  matching, or product activation.
- Add autonomous identity verification, fuzzy matching, unavailable identity
  outcomes, or a market-completeness claim.
- Expose production mutations before operator authentication is configured.
- Apply a remote migration, publish evidence, or deploy this local change.

## Decisions

### Store immutable identity verification decisions separately

A forward migration adds `identity_evidence_decisions` with a deterministic
decision ID and these bound values: product ID, source ID, source record key,
internal source-record ID, source identity hash, evidence URL, source
observation time, rationale, actor, and decision time. The exact-binding unique
key is product + source record + identity hash.

An identical retry reads as success. A retry that changes evidence, rationale,
actor, or the other immutable payload for the same binding fails as a conflict;
it never rewrites history. The existing `identity_decisions` table remains the
resolution ledger for ambiguous records rather than being overloaded with a
second lifecycle.

Alternative considered: add evidence columns to `identity_decisions`. Rejected
because ordinary exact matches have no resolution decision and the table's
current upsert semantics are mutable.

### Verify through a dedicated local-only product action

`POST /api/products/:productId/identity-evidence` accepts a source-record ID,
HTTPS evidence URL, and rationale. The Worker requires an active product, a
currently linked source record, a non-empty source identity hash, a matching
source/product binding, and bounded validated input. It derives source ID,
source record key, and observation time from D1 rather than trusting the
request.

The mutation inserts the immutable decision and projects
`evidence_outcomes(identity, verified)` in one D1 batch. The endpoint follows
the existing local-host mutation guard. The completion worklist uses its
already-returned best source-record ID and source URL, while allowing the
operator to supply a more exact current label URL.

Alternative considered: manufacture one identity review item for every active
product and reuse `/api/reviews/:id/resolve`. Rejected because it would add a
large artificial queue and confuse identity resolution with identity evidence.

### Bind ambiguous resolution to the same verification transaction

`match` and `create_new` require a valid HTTPS evidence URL. After determining
the target product and relinking the source record, their existing transaction
also inserts the exact identity evidence decision and terminal projection for
that target. A missing or conflicting evidence decision fails the entire
resolution. `no_match` may retain a rationale without evidence because the
proposed product becomes inactive and does not close an active completion row.

Alternative considered: keep resolution and verification independent. Rejected
because the operator has already asserted the exact identity relationship and
the same evidence must not be lost between two mutations.

### Treat the outcome as a projection, not the source of truth

The completion classifier joins the projected identity outcome to a current
identity decision and source record. Identity is verified only when all of the
following remain true: the outcome has a non-empty HTTPS evidence URL; its
source-record ID equals the decision's; the decision product/source/key/hash
match the current linked source record; and the immutable evidence fields agree
with the projection. A lone or contradictory outcome is
`evidence_inconsistent`, never verified.

This makes stale state fail closed even before the next source replay repairs
the projection.

### Reconcile exact decisions without losing valid alternate sources

For each imported source record, reconciliation removes an identity projection
only when that projection names the same source-record ID and no decision still
matches its current product/source/key/hash. It then selects the most recent
valid immutable decision for the affected product and upserts the terminal
projection. A drifted record therefore cannot delete a projection backed by a
different still-valid source. Replay of unchanged input is idempotent.

The reconciliation SQL never modifies or deletes immutable decisions. Historical
rows remain auditable even after their binding stops being current.

Alternative considered: delete every product identity outcome before replay
and rebuild globally. Rejected because partial/family-specific imports could
erase valid evidence from sources not present in that artifact.

### Keep the operator interaction focused and accessible

Identity rows in `source_evidence_needed` gain a `Verify identity` action. A
small form identifies the selected source, pre-fills a valid current source
URL when available, requires a rationale, explains the exact-binding rule, and
reports validation/conflict errors without changing the current ledger row.
Successful verification refreshes coverage and the identity worklist so the
product visibly moves from outstanding to verified. Nutrition and ingredient
workflows are unchanged.

## Risks / Trade-offs

- [A source URL can later serve different bytes] → Bind the decision to the
  source identity hash and observation recorded during review; expose the URL
  as provenance, and fail closed when the source identity changes.
- [Multiple current decisions can exist for one product] → Select the newest
  valid decision deterministically by decision time then ID; retain all rows.
- [An outcome can become stale before replay] → The completion query validates
  the live decision/source chain and classifies any mismatch as inconsistent.
- [Ambiguous match logic is already transaction-heavy] → Append the identity
  evidence statements to the same D1 batch and add atomicity tests for evidence
  conflicts.
- [Production users can see an operator action they cannot execute] → Keep the
  existing mutation boundary explicit in the UI and API; authenticated remote
  operation remains a separate feature.

## Migration Plan

1. Add the immutable decision table and indexes in the next forward migration;
   validate it against a fresh local D1 database and all earlier migrations.
2. Add the shared contract, Worker verifier, local-only route, and completion
   classifier binding with focused Worker+D1 tests.
3. Add replay projection/invalidation and unchanged/drift/multi-source tests.
4. Add the identity worklist form and rendered responsive/accessibility
   contract tests; run browser verification.
5. Run typecheck, unit and Worker suites, build, migration checks, and OpenSpec
   validation; update `PROJECT_STATUS.md`.
6. Commit and push the verified local feature. Remote migration and deployment
   remain pending explicit production approval.

Rollback is forward-only: before remote application, revert code and the
unapplied migration. After application, disable the action in code and add a
later forward migration if the table must be retired; do not drop audit rows.

## Open Questions

- Authenticated remote operator identity and reviewer attribution remain part
  of the separate production-mutation/authentication capability.
- Terminal `not_applicable` identity outcomes are intentionally undefined; an
  active catalog product is expected to have a verifiable identity.
