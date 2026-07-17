## Context

Nutrition and ingredient extraction run against a finite, source-snapshot-bound barcode set and already emit deterministic per-barcode outcomes, checksums, label-asset ledgers, and fail-closed manifests. The current publication contract treats any `failed` outcome as making the entire run non-publishable. That protected correctness, but live runs show that a handful of bounded remote image failures can discard thousands of otherwise reproducible outcomes. The dashboard and D1 model already support current failed attempts, reason codes, outstanding completion lanes, and strict evidence views; the missing layer is an artifact policy that distinguishes exhaustive accounting from universal fetch success.

## Goals / Non-Goals

**Goals:**

- Publish fully accounted runs with a very small, explicit residual-exception set.
- Preserve exact provenance and retryability for every exception.
- Keep fact promotion, Trusted membership, and terminal-unavailable evidence as strict as they are now.
- Fail closed on accounting, checksum, provenance, drift, or threshold violations.
- Make the same contract apply to nutrition and ingredient extraction.

**Non-Goals:**

- Treating extraction failures as evidence that a declaration is absent.
- Relaxing human review or authority requirements.
- Claiming all configured products are verified.
- Recovering a prior diagnostics-only artifact that omitted publish-required successful responses.
- Authorizing production publication, D1 migrations, or deployment.

## Decisions

### Use two independent completion dimensions

The manifest will expose exhaustive outcome accounting separately from verification completeness. Accounting is true only when the requested barcode set and current outcome set form an exact one-to-one partition. Verification completeness remains false whenever residual failures exist.

For an exhaustively traversed run, `sourceComplete` and `terminalEvidence: end_of_file` describe barcode-set traversal even when bounded label failures exist. New report fields carry outcome-accounting completeness, verification completeness, residual count and rate, and the fixed policy limits; downstream validators inspect those explicit fields rather than infer verification from traversal.

This is preferred to redefining `failed` as `rejected`: rejection is a completed evidence judgment, while failure means the evidence request could not be completed and must remain retryable.

### Require both an absolute and proportional bound

Publication permits at most 10 failed outcomes and at most 0.25 percent of requested barcodes. Both conditions must hold. The absolute cap prevents a large catalog from normalizing hundreds of exceptions; the rate cap prevents a small run from accepting a high failure share.

The limits are constants in the shared validator, serialized into the manifest contract, and asserted by workflow tests. They are not runtime environment knobs, so a production operator cannot silently loosen them.

### Preserve failures as extraction state only

The importer records the exact failed attempt and reason code but performs no fact, observation, nutrient, ingredient, identity-decision, or terminal-unavailable projection for that outcome. Existing independent exact-current evidence is evaluated normally and is not overwritten by a failed attempt. A product-level residual exception means a current failed attempt with no independent exact-current verified or terminal field evidence; otherwise the failure remains extraction history rather than an unverified completion item.

This reuses the current strict-trust model: a product with only a failed current attempt remains outstanding and reason-coded, while one with independent verified evidence remains verified for that evidence family. Completion must aggregate current failures from extraction attempts themselves rather than only through attempt-to-label links, because an HTTP or declared-size failure may retain no usable label asset.

Residual eligibility is limited to allow-listed failures that occur after a successful raw model response was retained, such as bounded label HTTP, body-read, or declared-size failures. A model/API failure without successful raw response evidence remains run-fatal. Any label assets retained before the subject failed must still match the failed attempt's exact subject and appear in the portable checksum ledger; validators reject cross-subject or unexplained orphan assets.

### Keep all existing reproducibility gates

Successful outcomes still require their portable raw responses, label-byte artifacts where applicable, source snapshot hash, checksums, and reviewed-decision audit. A residual exception changes only whether a small failed subset blocks importing the complete subset; it does not make a diagnostics artifact publishable.

Consequently, ingredient run `29574516752` cannot be repackaged: its diagnostics artifact lacks the successful response files, cohort metadata, staged candidates, source index, exclusions, and portable checksum set required by the publisher. One replacement exhaustive run is still necessary.

### Separate extraction eligibility from production authority

The producer may emit an eligible candidate artifact with residual exceptions, but successful producer completion never triggers production publication. Publication requires a separate manual dispatch for the exact successful run plus a hard production confirmation before credentials or D1 access are available. This keeps data-policy correctness independent from deployment authorization and does not itself authorize a write.

## Risks / Trade-offs

- [A repeatedly failing product could remain unverified] → Keep it visible in the current retry/manual-evidence lane with immutable reason history; never include it in Trusted.
- [A threshold can become a target rather than an alarm] → Require both count and rate limits and expose the exact exception list in coverage and release evidence.
- [Manifest terminology can be misunderstood] → Report accounting completeness, verification completeness, and exception totals as separate fields; avoid a single ambiguous success boolean.
- [Partial publication could hide artifact corruption] → Preserve all existing checksum, one-outcome-per-request, source hash, label-byte, response, and decision-drift checks before any write.
- [Successful facts could be revoked by an unrelated failed retry] → Treat failed attempts as extraction provenance only; strict evidence views continue to depend on independent exact-current fact authority.

## Migration Plan

1. Add manifest and shared-validation fields without changing production publication.
2. Update both adapters, artifact auditors, and workflow contracts with threshold and provenance tests.
3. Update reconciliation/import tests to prove exceptions create no facts and completion totals remain exact.
4. Run a replacement exhaustive nutrition and ingredient extraction from the same source snapshot using the corrected retry cache.
5. Independently verify checksums, accounting, threshold compliance, decision drift, and the explicit exception list.
6. After separate approval, apply pending D1 migrations, explicitly dispatch publication for the approved exact artifacts, deploy, and verify live invariants.

Rollback is code-only before production publication. After an exception-bearing artifact is published, rollback MUST retain readers for failed attempt provenance; facts need no rollback because failures never create them.

## Open Questions

- Whether a later product-specific repair workflow should be added to supersede residual exceptions without rebuilding an exhaustive artifact. This is deferred because the current CLI has no barcode filter and the immediate release can remain truthful without one.
