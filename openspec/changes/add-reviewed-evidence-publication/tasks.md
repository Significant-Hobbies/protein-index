## 1. Durable evidence decisions

- [ ] 1.1 Add the evidence-decision migration with exact source, candidate-hash, payload, reviewer, timestamp, and active-decision constraints
- [ ] 1.2 Implement shared canonical candidate hashing and evidence-decision validation for Worker and Node runtimes
- [ ] 1.3 Persist verify and reject decisions atomically during local review resolution without clearing unrelated facts
- [ ] 1.4 Add Worker+D1 tests for exact-value verification, isolated rejection, conflicting decision ids, and source/candidate drift

## 2. Reconciliation and replay

- [ ] 2.1 Include the canonical candidate hash in Robotoff staged evidence and review records
- [ ] 2.2 Reuse matching active verify decisions during import and reconstruct verified nutrition, nutrient values, field observations, and evidence outcomes
- [ ] 2.3 Reuse matching active reject decisions without reopening the candidate or creating terminal unavailable nutrition
- [ ] 2.4 Add replay tests for unchanged verified/rejected evidence and changed source or candidate hashes

## 3. Portable review bundles

- [ ] 3.1 Implement deterministic local decision export with sorted JSONL, schema-versioned manifest, portable checksums, and empty-export refusal
- [ ] 3.2 Implement bundle parsing and fail-closed validation for paths, checksums, ids, URLs, nutrition, source linkage, and duplicate/conflicting decisions
- [ ] 3.3 Generate idempotent decision SQL only from a validated bundle and include explicit expected postcondition counts
- [ ] 3.4 Add fixtures and tests for deterministic export, checksum tampering, unsafe paths, invalid nutrition, evidence drift, replay, and partial application

## 4. Guarded production publication

- [ ] 4.1 Add a manual protected GitHub workflow pinned to a bundle commit, path, and expected ledger hash
- [ ] 4.2 Require the bundle commit to be an ancestor of main and extract bundle data without executing code from that commit
- [ ] 4.3 Validate current remote source evidence before D1 writes and fail the entire publication on drift or count mismatch
- [ ] 4.4 Query durable decisions, verified facts, evidence outcomes, and unresolved candidates after publication and upload checksummed diagnostics

## 5. Verification and rollout

- [ ] 5.1 Run type, unit, Worker+D1, build, OpenSpec, startup, and release-guard checks
- [ ] 5.2 Dry-run a synthetic reviewed bundle locally and prove idempotent replay plus fail-closed drift behavior
- [ ] 5.3 Export and review a bounded real candidate bundle without auto-verifying any unreviewed product
- [ ] 5.4 Publish the reviewed real bundle through the guarded workflow and verify the exact live coverage delta
- [ ] 5.5 Keep the product completion gate red until all active product identity, nutrition, and ingredient evidence is terminal and verified
