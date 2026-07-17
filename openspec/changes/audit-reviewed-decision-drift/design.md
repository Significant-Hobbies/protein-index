## Context

Review decisions are immutable, checksummed bundles, but the same decisions recur across 81 historical bundle directories. Fresh Robotoff nutrition and ingredient artifacts now preserve exact extraction attempts, label assets, label-byte hashes, and candidate hashes. Existing bundle validation proves each bundle internally, while publication validation checks selected bundles against D1; neither provides a global, read-only answer about decision drift against a newly downloaded artifact.

The audit must be conservative. Historical decisions that predate exact extraction linkage cannot be made exact by inference, even when their semantic candidate still appears. Production data, D1, and the review ledgers are out of scope for mutation.

## Goals / Non-Goals

**Goals:**

- Validate one exact nutrition or ingredient artifact before examining decisions.
- Validate every discovered review bundle and deterministically collapse identical repeated records.
- Detect conflicting decision IDs and conflicting decisions for the same evidence subject.
- Compare each unique in-family decision with the current artifact and emit stable classifications and counts.
- Make the result usable in local checks and GitHub Actions through deterministic JSON and meaningful exit codes.

**Non-Goals:**

- Automatically approve, reject, rebind, rewrite, or publish a decision.
- Query or modify D1, production data, extraction artifacts, or review bundles.
- Claim that a legacy semantic match is exact label-byte evidence.
- Combine nutrition and ingredient artifacts in one invocation.

## Decisions

### Validate first, compare second

The command will call the existing full artifact validator selected by its validated manifest and will load bundles only through `readReviewDecisionBundle`. This reuses checksum, schema, lineage, and exact-label invariants rather than implementing a weaker parser. An invalid artifact or bundle aborts the audit.

Alternative considered: parse only `staged-products.jsonl` and `decisions.jsonl`. Rejected because it would bypass the evidence ledger and checksum guarantees the audit exists to protect.

### Use two deterministic keys

Records are first deduplicated by decision ID and canonical payload. Repeated byte-equivalent canonical decisions collapse into one unique decision with provenance listing every bundle. Reuse of one ID with a different canonical decision is an integrity conflict.

A second active-candidate key uses source ID, source record key, candidate hash, and field family. More than one decision ID for this key is ambiguous because checked-in bundles do not carry authoritative active/superseded state; the whole group is excluded from exact claims. Multiple still-current verify decisions for one field family and product are likewise ambiguous. Sorting uses stable lexical keys so bundle discovery order cannot affect output.

Alternative considered: newest `decidedAt` wins. Rejected because timestamps do not authorize superseding a human decision and would conceal conflicts.

### Compare against current candidates without rebinding

For the artifact's field family, the auditor indexes staged candidates by source ID, source record key, product ID, GTIN, candidate hash, source content hash, extraction attempt ID, and label asset ID. It independently recomputes the staged raw-evidence hash and canonical candidate hash instead of trusting a self-authored index alone. A full proof check also requires a matching review issue and attempt-label outcome, current attempt, consistent subject/product/family bindings, candidate image URL, asset URL, and exact label-byte SHA-256.

Each unique decision receives one stable classification, with run-level invalid input and hard conflicts handled before claims:

- `candidate_key_active_state_ambiguous`: multiple decision IDs exist for one candidate key without authoritative active state.
- `unsupported_source_or_family`: the decision does not belong to the selected artifact source and field family.
- `artifact_candidate_missing`: the current artifact has no staged candidate for the source key.
- `candidate_drift`: the source key remains but the historical candidate hash or canonical payload is no longer current.
- `identity_drift`: the derived source record, product, or GTIN binding changed.
- `source_revision_drift_candidate_unchanged`: the candidate remains but the source content hash changed.
- `exact_proof_incomplete_or_inconsistent`: the current artifact cannot prove the complete extraction-to-label-byte chain.
- `linked_proof_drift`: an already-linked decision names evidence that no longer matches the current artifact.
- `requires_selected_projection_state`: a redundant nutrition decision requires trusted D1 projection state that a file-only audit does not have.
- `legacy_proof_match_requires_new_decision`: an unlinked historical decision semantically matches the full current proof but cannot be retrofitted because exact linkage is immutable.
- `exact_link_valid`: an already-linked decision matches the entire current proof chain.

Current artifact candidates without any decision are reported separately as `unreviewed_current_candidate`. The report documents counts and the compared evidence needed for human follow-up. No category permits automatic rebinding or promotion.

### Separate findings from command policy

The core audit returns a typed report and never exits the process. A thin CLI writes JSON to stdout or an optional output path, writes a concise summary to stderr, and exits non-zero for invalid input, hard integrity conflicts, or proof inconsistency. Ordinary drift, missing candidates, and unreviewed candidates remain explicit findings; an optional policy can make selected finding categories fail automation without confusing drift with malformed input.

Alternative considered: print warnings and always succeed. Rejected because CI could then publish after an unnoticed evidence regression.

### Keep the tool repository-local and dependency-free

Implementation will use Node built-ins and existing TypeScript helpers. No production dependency, database migration, API route, or dashboard behavior changes are required.

## Risks / Trade-offs

- [A source may legitimately change while the extracted candidate stays identical] → Classify it separately and require human review instead of silently declaring it exact.
- [Historical bundles may contain intentional later corrections] → Surface conflicting material decisions; do not infer supersession without an explicit ledger mechanism.
- [An extraction run can omit a candidate because the model failed rather than the label disappeared] → Report `missing_current_candidate` with artifact outcome context; do not rewrite the old decision.
- [Full validation and 81-bundle discovery add runtime] → Keep indexing linear in artifact and decision count and validate each file only once.
- [Category precedence can hide useful detail] → Include matched identifiers, expected/current hashes, and bundle provenance in each result.

## Migration Plan

1. Add the pure audit module, CLI wrapper, package command, and focused fixtures/tests.
2. Run it against fresh validated nutrition and ingredient artifacts locally.
3. Add it to evidence refresh validation only after its real-artifact report is understood.
4. Roll back by removing the command; no stored data or production state changes.

## Open Questions

- Whether a later product workflow should introduce an explicit, human-signed supersession record for intentional decision corrections. This audit will not infer one.
