import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { labelReferenceFromUrl, stagedProductId, stagedSourceRecordId } from "./adapters/label-image";
import { OPEN_FOOD_FACTS_ADAPTER_VERSION } from "./adapters/open-food-facts";
import { OFFICIAL_BRAND_SITEMAP_ADAPTER_VERSION } from "./adapters/official-brand-sitemap";
import { CLASSIFIER_VERSION } from "../shared/classification";
import type { SourceManifest, StagedProduct } from "../shared/types";

export interface MachineLabelCandidate {
  schemaVersion: 1;
  id: string;
  source: "open_food_facts" | "official_brand";
  productId: string;
  subjectSourceRecordId: string;
  sourceRecordKey: string;
  sourceContentHash: string;
  gtin: string | null;
  brand: string;
  name: string;
  flavour: string | null;
  category: StagedProduct["category"];
  marketedReasons: string[];
  missing: Array<"calories" | "proteinGrams">;
  label: {
    sourceImageId: string;
    sourceImageRevision: string | null;
    url: string;
  };
}

export interface MachineLabelDiscoveryReport {
  schemaVersion: 1;
  sourceManifestSha256: string;
  sourceInputHash: string;
  sourceAdapterVersion: string;
  stagedRecords: number;
  proteinBrandedRecords: number;
  macroGapRecords: number;
  eligibleLabelRecords: number;
  selectedRecords: number;
  skipped: Record<string, number>;
  candidateSha256: string;
  generatedAt: string;
}

const candidateId = (value: string) => `mlc_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;

export function isProteinBranded(product: StagedProduct): boolean {
  const text = `${product.brand} ${product.name} ${product.flavour ?? ""}`.toLocaleLowerCase();
  // Stale classifications may have treated community categories as branding.
  // Until a record is restaged by the current classifier, only product identity
  // text is sufficient for automatic label work.
  return (product.classification.version === CLASSIFIER_VERSION && product.classification.marketed === true)
    || /\b(?:protein|whey|casein)\b/.test(text);
}

export function machineLabelCandidateForProduct(product: StagedProduct): MachineLabelCandidate | null {
  const source = product.source === "open_food_facts" ? "open_food_facts" : product.sourceKind === "brand" ? "official_brand" : null;
  if (!source || !isProteinBranded(product)) return null;
  const missing = (["calories", "proteinGrams"] as const).filter((field) => product.nutrition.per100g[field] === null);
  if (missing.length === 0 || !product.nutritionImageUrl?.startsWith("https://")) return null;
  const label = labelReferenceFromUrl(product.nutritionImageUrl);
  const subjectSourceRecordId = stagedSourceRecordId(product);
  return {
    schemaVersion: 1,
    id: candidateId(`${subjectSourceRecordId}\n${product.contentHash}\n${label.url}`),
    source,
    productId: stagedProductId(product),
    subjectSourceRecordId,
    sourceRecordKey: product.sourceRecordId,
    sourceContentHash: product.contentHash,
    gtin: product.gtin,
    brand: product.brand,
    name: product.name,
    flavour: product.flavour,
    category: product.category,
    marketedReasons: product.classification.marketedReasons,
    missing,
    label,
  };
}

function assertSourceManifest(manifest: SourceManifest): void {
  const supported = (manifest.source === "open_food_facts" && manifest.adapterVersion === OPEN_FOOD_FACTS_ADAPTER_VERSION)
    || (manifest.sourceKind === "brand" && manifest.adapterVersion === OFFICIAL_BRAND_SITEMAP_ADAPTER_VERSION);
  if (!supported || !manifest.sourceComplete || manifest.terminalEvidence !== "end_of_file" || !manifest.inputHash) {
    throw new Error("Machine-label discovery requires a complete current Open Food Facts or configured official-brand snapshot.");
  }
}

async function write(stream: NodeJS.WritableStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) await once(stream, "drain");
}

export async function discoverMachineLabelCandidates(input: {
  stagedPath: string;
  sourceManifestPath: string;
  outputPath: string;
  reportPath: string;
  limit?: number | null;
  now?: () => Date;
}): Promise<MachineLabelDiscoveryReport> {
  if (input.limit !== undefined && input.limit !== null && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
    throw new Error("Machine-label discovery limit must be a positive integer.");
  }
  const manifestRaw = await readFile(input.sourceManifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as SourceManifest;
  assertSourceManifest(manifest);
  const output = createWriteStream(input.outputPath, { encoding: "utf8" });
  const candidateHash = createHash("sha256");
  let stagedRecords = 0;
  let proteinBrandedRecords = 0;
  let macroGapRecords = 0;
  let eligibleLabelRecords = 0;
  let selectedRecords = 0;
  const skipped: Record<string, number> = {};
  const reader = createInterface({ input: createReadStream(input.stagedPath), crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      stagedRecords += 1;
      const product = JSON.parse(line) as StagedProduct;
      if (!isProteinBranded(product)) continue;
      proteinBrandedRecords += 1;
      const missing = product.nutrition.per100g.calories === null || product.nutrition.per100g.proteinGrams === null;
      if (!missing) continue;
      macroGapRecords += 1;
      if (!product.nutritionImageUrl?.startsWith("https://")) {
        skipped.no_https_nutrition_label = (skipped.no_https_nutrition_label ?? 0) + 1;
        continue;
      }
      eligibleLabelRecords += 1;
      if (input.limit !== undefined && input.limit !== null && selectedRecords >= input.limit) {
        skipped.limit = (skipped.limit ?? 0) + 1;
        continue;
      }
      const candidate = machineLabelCandidateForProduct(product);
      if (!candidate) throw new Error(`Candidate eligibility drift for ${product.sourceRecordId}.`);
      const serialized = JSON.stringify(candidate);
      await write(output, serialized);
      candidateHash.update(`${serialized}\n`);
      selectedRecords += 1;
    }
  } finally {
    output.end();
    await once(output, "finish");
  }
  const report: MachineLabelDiscoveryReport = {
    schemaVersion: 1,
    sourceManifestSha256: createHash("sha256").update(manifestRaw).digest("hex"),
    sourceInputHash: manifest.inputHash!,
    sourceAdapterVersion: manifest.adapterVersion,
    stagedRecords,
    proteinBrandedRecords,
    macroGapRecords,
    eligibleLabelRecords,
    selectedRecords,
    skipped,
    candidateSha256: candidateHash.digest("hex"),
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
  await writeFile(input.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function main(): Promise<void> {
  const [stagedPath, sourceManifestPath, outputPath, reportPath, rawLimit] = process.argv.slice(2);
  if (!stagedPath || !sourceManifestPath || !outputPath || !reportPath) {
    throw new Error("Usage: pnpm data:machine-discover <staged-products.jsonl> <source-manifest.json> <candidates.jsonl> <report.json> [limit]");
  }
  const limit = rawLimit === undefined ? null : Number(rawLimit);
  const report = await discoverMachineLabelCandidates({ stagedPath, sourceManifestPath, outputPath, reportPath, limit });
  process.stdout.write(`${JSON.stringify({ output: basename(outputPath), report: basename(reportPath), selectedRecords: report.selectedRecords, eligibleLabelRecords: report.eligibleLabelRecords })}\n`);
}

if (process.argv[1]?.endsWith("machine-label-discovery.ts")) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
