import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/publish-automatic-evidence.yml";
const candidateWorkflowPath = ".github/workflows/publish-robotoff-candidates.yml";
const guardedCandidateWorkflowPath = ".github/workflows/publish-guarded-reviewed-labels.yml";

async function readWorkflow(): Promise<string> {
  return readFile(workflowPath, "utf8");
}

function section(workflow: string, start: string, end?: string): string {
  const startIndex = workflow.indexOf(start);
  expect(startIndex, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = end ? workflow.indexOf(end, startIndex + start.length) : workflow.length;
  expect(endIndex, `missing section ${end}`).toBeGreaterThan(startIndex);
  return workflow.slice(startIndex, endIndex);
}

describe("manual evidence publication workflow", () => {
  it("cannot be triggered by extraction completion or any non-manual event", async () => {
    const workflow = await readWorkflow();
    const triggers = section(workflow, "on:\n", "\npermissions:");

    expect(triggers.match(/^  [a-z_]+:/gm)).toEqual(["  workflow_dispatch:"]);
    expect(workflow).not.toContain("workflow_run:");
    expect(workflow).not.toContain("github.event.workflow_run");
    expect(triggers).toContain("upstream_run_id:");
    expect(triggers).toContain("confirm_production_publication:");
    expect(triggers).toContain("type: string");
  });

  it("fails in a credential-free job unless the exact production phrase is supplied", async () => {
    const workflow = await readWorkflow();
    const authorize = section(workflow, "  authorize:\n", "\n  publish:\n");

    expect(authorize).toContain("permissions: {}");
    expect(authorize).not.toContain("environment: production");
    expect(authorize).not.toContain("secrets.");
    expect(authorize).not.toContain("--remote");
    expect(authorize).toContain('[[ "$GITHUB_REF" != "refs/heads/main" ]]');
    expect(authorize).toContain(
      '[[ "$CONFIRM_PRODUCTION_PUBLICATION" != "PUBLISH_VERIFIED_EVIDENCE_TO_PRODUCTION" ]]',
    );
    expect(authorize).toContain("exit 1");
    expect(authorize).toContain('echo "approved=true" >> "$GITHUB_OUTPUT"');
  });

  it("keeps all production access behind both explicit approval and the protected environment", async () => {
    const workflow = await readWorkflow();
    const publish = section(workflow, "  publish:\n");
    const publishHeader = section(publish, "  publish:\n", "    steps:\n");

    expect(publishHeader).toContain("needs: authorize");
    expect(publishHeader).toContain("if: needs.authorize.outputs.approved == 'true'");
    expect(publishHeader).toContain("environment: production");
    expect(publishHeader).not.toContain("secrets.");
    expect(publish).toContain("Require protected publication credentials");
    expect(publish).toContain("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}");
    expect(publish).toContain("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    expect(publish).toContain("pnpm data:publish --");
    expect(publish).toContain("--confirm-remote");
    expect(publish).toContain("--skip-migrations");
    expect(publish.indexOf("Require protected publication credentials"))
      .toBeGreaterThan(publish.indexOf("Pin trigger and artifact evidence"));
    expect(publish.indexOf("Publish validated evidence without migrations"))
      .toBeGreaterThan(publish.indexOf("Require protected publication credentials"));
  });

  it("resolves and pins the selected successful upstream run instead of trusting dispatch inputs", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain("github.rest.actions.getWorkflowRun");
    expect(workflow).toContain("github.rest.actions.listWorkflowRunArtifacts");
    expect(workflow).toContain("run.conclusion !== 'success'");
    expect(workflow).toContain("run.head_branch !== context.payload.repository.default_branch");
    expect(workflow).toContain("run.head_repository?.full_name !== `${context.repo.owner}/${context.repo.repo}`");
    expect(workflow).toContain("artifact.digest");
    expect(workflow).toContain("artifact.size_in_bytes");
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).not.toContain("ref: ${{ steps.route.outputs.upstream_head_sha }}");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
  });

  it("runs the current publisher and accepts evidence only from an ancestor commit", async () => {
    const workflow = await readWorkflow();

    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$PUBLISHER_HEAD_SHA"');
    expect(workflow).toContain('git merge-base --is-ancestor "$UPSTREAM_HEAD_SHA" "$PUBLISHER_HEAD_SHA"');
    expect(workflow).toContain("PUBLISHER_HEAD_SHA: ${{ github.sha }}");
    expect(workflow).toContain("UPSTREAM_HEAD_SHA: ${{ steps.route.outputs.upstream_head_sha }}");
  });

  it("fails closed on unsupported adapter versions before credentials are exposed", async () => {
    const workflow = await readWorkflow();
    const pinEvidence = section(
      workflow,
      "      - name: Pin trigger and artifact evidence\n",
      "\n      - name: Require protected publication credentials\n",
    );

    expect(workflow).toContain("adapterVersion: 'off-bulk-v6'");
    expect(workflow).toContain("adapterVersion: 'off-api-enrichment-v6'");
    expect(workflow).toContain("adapterVersion: 'robotoff-api-v8'");
    expect(workflow).toContain("adapterVersion: 'robotoff-ingredients-api-v3'");
    expect(pinEvidence).toContain("EXPECTED_ADAPTER_VERSION: ${{ steps.route.outputs.expected_adapter_version }}");
    expect(pinEvidence).toContain("adapter_version=\"$(jq -r '.adapterVersion // empty'");
    expect(pinEvidence).toContain('[[ "$adapter_version" != "$EXPECTED_ADAPTER_VERSION" ]]');
    expect(pinEvidence).not.toContain("secrets.");
  });

  it("verifies the downloaded archive digest and byte size before extraction", async () => {
    const workflow = await readWorkflow();
    const pinEvidence = section(
      workflow,
      "      - name: Pin trigger and artifact evidence\n",
      "\n      - name: Require protected publication credentials\n",
    );

    expect(pinEvidence).toContain('expected_digest="${ARTIFACT_DIGEST#sha256:}"');
    expect(pinEvidence).toContain('actual_digest="$(sha256sum .automatic-publication.zip');
    expect(pinEvidence).toContain('actual_bytes="$(stat --format=%s .automatic-publication.zip)"');
    expect(pinEvidence).toContain('[[ "$actual_digest" != "$expected_digest" ]]');
    expect(pinEvidence).toContain('[[ "$actual_bytes" != "$ARTIFACT_BYTES" ]]');
    expect(pinEvidence.indexOf("actual_digest=")).toBeLessThan(pinEvidence.indexOf("unzip -q"));
    expect(pinEvidence.indexOf("actual_bytes=")).toBeLessThan(pinEvidence.indexOf("unzip -q"));
  });

  it("applies the same hard publication boundary to reviewed candidate artifacts", async () => {
    const workflow = await readFile(candidateWorkflowPath, "utf8");
    const triggers = section(workflow, "on:\n", "\npermissions:");
    const authorize = section(workflow, "  authorize:\n", "\n  publish:\n");
    const publish = section(workflow, "  publish:\n");
    const publishHeader = section(publish, "  publish:\n", "    steps:\n");
    const expand = section(
      workflow,
      "      - name: Expand and pin reviewed extraction\n",
      "\n      - name: Re-audit reviewed decisions against the pinned extraction\n",
    );

    expect(triggers.match(/^  [a-z_]+:/gm)).toEqual(["  workflow_dispatch:"]);
    expect(triggers).toContain("confirm_production_publication:");
    expect(authorize).toContain("permissions: {}");
    expect(authorize).not.toContain("environment: production");
    expect(authorize).not.toContain("secrets.");
    expect(authorize).toContain("PUBLISH_REVIEWED_LABEL_CANDIDATES_TO_PRODUCTION");
    expect(publishHeader).toContain("needs: authorize");
    expect(publishHeader).toContain("if: needs.authorize.outputs.approved == 'true'");
    expect(publishHeader).toContain("environment: production");
    expect(publishHeader).not.toContain("secrets.");
    expect(workflow).toContain("ref: ${{ github.sha }}");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain('test "$(git rev-parse HEAD)" = "$PUBLISHER_HEAD_SHA"');
    expect(workflow).toContain('git merge-base --is-ancestor "$UPSTREAM_HEAD_SHA" "$PUBLISHER_HEAD_SHA"');
    expect(expand).toContain('actual_digest="$(sha256sum .data-robotoff.zip');
    expect(expand).toContain('actual_bytes="$(stat --format=%s .data-robotoff.zip)"');
    expect(expand.indexOf("actual_digest=")).toBeLessThan(expand.indexOf("unzip -q"));
    expect(expand.indexOf("actual_bytes=")).toBeLessThan(expand.indexOf("unzip -q"));
    expect(workflow).toContain("Require protected publication credentials");
    expect(workflow).toContain("--ignore-scripts");
    expect(workflow).toContain(".data/publish-robotoff/decision-drift.json");
    expect(workflow).toContain(".data/publish-robotoff/publication-decision-drift.json");
  });

  it("re-audits extraction evidence with current publisher code before credentials", async () => {
    const workflow = await readWorkflow();
    const beforeCredentials = section(
      workflow,
      "      - name: Re-audit current reviewed decisions against extraction evidence\n",
      "\n      - name: Require protected publication credentials\n",
    );

    expect(beforeCredentials).toContain("pnpm data:audit-decisions --");
    expect(beforeCredentials).toContain("--artifact .data/automatic");
    expect(beforeCredentials).toContain("publication-decision-drift.json");
    expect(beforeCredentials).toContain("--fail-on candidate_key_active_state_ambiguous");
    expect(beforeCredentials).not.toContain("secrets.");
    expect(workflow).toContain("bound-decision-drift.json");
  });

  it("uses one protected guarded D1 import for reviewed label artifacts and successors", async () => {
    const workflow = await readFile(guardedCandidateWorkflowPath, "utf8");
    expect(workflow).toContain("PUBLISH_GUARDED_REVIEWED_LABELS_TO_PRODUCTION");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("pnpm data:guarded-release:prepare");
    expect(workflow).toContain("pnpm exec wrangler d1 execute protein-index --remote --yes --file .data/guarded-release/guarded.sql");
    expect(workflow).toContain("Apply pending D1 migrations atomically");
    expect(workflow).toContain("INSERT INTO d1_migrations (name) VALUES");
    expect(workflow).toContain("Exact ${family} postcondition failed");
    expect(workflow).toContain('[[ "$DECISIONS" == 365 && "$VERIFIES" == 76 ]]');
    expect(workflow).toContain('[[ "$DECISIONS" == 66 && "$VERIFIES" == 65 ]]');
  });
});
