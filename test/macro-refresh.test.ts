import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMacroRefresh } from "../scripts/macro-refresh";
import type { SourceManifest } from "../shared/types";

const manifest = (source: string, sourceKind: SourceManifest["sourceKind"]): SourceManifest => ({
  schemaVersion: 1,
  source,
  sourceKind,
  sourceAuthority: { identity: 70, nutrition: 40, ingredients: 40 },
  sourceLicenseUrl: null,
  sourceRetentionNotes: "",
  adapterVersion: sourceKind === "brand" ? "official-brand-sitemap-v19" : "off-bulk-v6",
  input: source,
  inputHash: "a".repeat(64),
  inputBytes: 1,
  sourceUpdatedAt: null,
  startedAt: "2026-07-19T00:00:00.000Z",
  completedAt: "2026-07-19T00:00:00.000Z",
  mode: "production",
  terminalEvidence: "end_of_file",
  sourceComplete: true,
  marketComplete: false,
  advertisedTotal: null,
  recordsRead: 1,
  indiaRecords: 1,
  stagedRecords: 1,
  invalidRecords: 0,
  duplicateRecords: 0,
  newRecords: 1,
  changedRecords: 0,
  unchangedRecords: 0,
  missingSinceRecords: 0,
  knownExclusions: [],
  disconnectedSources: [],
});

async function fixtureRoot(): Promise<{ root: string; config: string; input: string }> {
  const root = await mkdtemp(join(tmpdir(), "protein-index-macro-refresh-"));
  const config = join(root, "sources.json");
  const input = join(root, "openfoodfacts.tsv.gz");
  await writeFile(input, "fixture", "utf8");
  await writeFile(config, JSON.stringify({
    schemaVersion: 1,
    sources: [{
      id: "acme_india",
      name: "Acme",
      allowedHosts: ["acme.example"],
      sitemapUrls: ["https://acme.example/sitemap.xml"],
      productPathPrefixes: ["/products/"],
      maxProductPages: 1,
      maxSitemapDepth: 1,
    }],
  }), "utf8");
  return { root, config, input };
}

describe("zero-cost macro refresh", () => {
  it("writes a bounded, non-publishing queue only after every configured source completes", async () => {
    const { root, config, input } = await fixtureRoot();
    const report = await runMacroRefresh({ rootDirectory: root, configPath: config, openFoodFactsInput: input, labelLimit: 2, runLabels: true, runId: "fixture" }, {
      now: () => new Date("2026-07-19T00:00:00.000Z"),
      stage: async ({ outputDirectory }) => ({ manifest: manifest("open_food_facts", "open_data"), stagedPath: join(outputDirectory, "staged.jsonl"), manifestPath: join(outputDirectory, "manifest.json"), reportPath: join(outputDirectory, "report.json"), indexPath: join(outputDirectory, "index.jsonl"), exclusionsPath: join(outputDirectory, "exclusions.jsonl") }),
      discoverBrand: async ({ source, outputDirectory }) => ({ manifest: manifest(source.id, "brand"), stagedPath: join(outputDirectory, "staged.jsonl"), manifestPath: join(outputDirectory, "manifest.json") }),
      discoverCandidates: async ({ outputPath, stagedPath }) => {
        const ids = stagedPath.includes("open-food-facts") ? ["mlc_b", "mlc_c"] : ["mlc_a"];
        await writeFile(outputPath, `${ids.map((id) => JSON.stringify({ id })).join("\n")}\n`, "utf8");
        return { schemaVersion: 1, sourceManifestSha256: "a".repeat(64), sourceInputHash: "b".repeat(64), sourceAdapterVersion: "fixture", stagedRecords: ids.length, proteinBrandedRecords: ids.length, macroGapRecords: ids.length, eligibleLabelRecords: ids.length, selectedRecords: ids.length, skipped: {}, candidateSha256: "c".repeat(64), generatedAt: "2026-07-19T00:00:00.000Z" };
      },
      runLabels: async ({ candidatesPath, limit }) => {
        expect(limit).toBe(2);
        expect((await readFile(candidatesPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line).id)).toEqual(["mlc_a", "mlc_b"]);
        return { processed: 2, accepted: 1, rejected: 1, failed: 0, cached: 0 };
      },
    });
    expect(report).toMatchObject({ sourceBoundedComplete: true, marketComplete: false, remotePublicationAttempted: false, labels: { eligible: 3, selected: 2, limit: 2, machineRun: { processed: 2 } } });
    expect(JSON.parse(await readFile(join(root, "runs", "fixture", "report.json"), "utf8"))).toMatchObject({ sourceBoundedComplete: true, remotePublicationAttempted: false });
  });

  it("records a failed source and never creates a label queue from an incomplete cohort", async () => {
    const { root, config, input } = await fixtureRoot();
    const report = await runMacroRefresh({ rootDirectory: root, configPath: config, openFoodFactsInput: input, runId: "incomplete" }, {
      stage: async ({ outputDirectory }) => ({ manifest: manifest("open_food_facts", "open_data"), stagedPath: join(outputDirectory, "staged.jsonl"), manifestPath: join(outputDirectory, "manifest.json"), reportPath: join(outputDirectory, "report.json"), indexPath: join(outputDirectory, "index.jsonl"), exclusionsPath: join(outputDirectory, "exclusions.jsonl") }),
      discoverBrand: async () => { throw new Error("brand unavailable"); },
      discoverCandidates: async () => { throw new Error("must not discover candidates"); },
    });
    expect(report.sourceBoundedComplete).toBe(false);
    expect(report.labels.queuePath).toBeNull();
    expect(report.sources.find((source) => source.id === "acme_india")).toMatchObject({ sourceComplete: false, error: "brand unavailable" });
  });
});
