import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { classifyProtein } from "../shared/classification";
import type { SourceManifest, StagedProduct } from "../shared/types";
import { OPEN_FOOD_FACTS_ADAPTER_VERSION } from "./adapters/open-food-facts";

const text = (value: unknown) => typeof value === "string" ? value : "";

export function reclassifyStagedProduct(product: StagedProduct): StagedProduct {
  const evidence = product.rawEvidence as Record<string, unknown>;
  return {
    ...product,
    classification: classifyProtein({
      brand: product.brand,
      name: product.name,
      categories: `${text(evidence.categories)} ${text(evidence.categories_tags)}`,
      labels: `${text(evidence.labels)} ${text(evidence.labels_tags)}`,
      nutrition: product.nutrition,
    }),
  };
}

export async function reclassifyOpenFoodFactsSnapshot(input: {
  stagedPath: string;
  manifestPath: string;
  outputDirectory: string;
  now?: () => Date;
}): Promise<{ stagedPath: string; manifestPath: string; records: number; marketed: number }> {
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8")) as SourceManifest;
  if (manifest.source !== "open_food_facts" || !manifest.sourceComplete || manifest.terminalEvidence !== "end_of_file" || !manifest.inputHash) {
    throw new Error("Reclassification requires a complete Open Food Facts source snapshot.");
  }
  await mkdir(input.outputDirectory, { recursive: true });
  const stagedPath = join(input.outputDirectory, "staged-products.jsonl");
  const output = createWriteStream(stagedPath, { encoding: "utf8" });
  let records = 0;
  let marketed = 0;
  try {
    const lines = createInterface({ input: createReadStream(input.stagedPath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const product = reclassifyStagedProduct(JSON.parse(line) as StagedProduct);
      records += 1;
      if (product.classification.marketed) marketed += 1;
      if (!output.write(`${JSON.stringify(product)}\n`)) await once(output, "drain");
    }
  } finally {
    output.end();
    await once(output, "finish");
  }
  const now = (input.now ?? (() => new Date()))().toISOString();
  const refreshed: SourceManifest = {
    ...manifest,
    adapterVersion: OPEN_FOOD_FACTS_ADAPTER_VERSION,
    startedAt: now,
    completedAt: now,
    stagedRecords: records,
  };
  const manifestPath = join(input.outputDirectory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");
  return { stagedPath, manifestPath, records, marketed };
}

async function main(): Promise<void> {
  const [stagedPath, manifestPath, outputDirectory] = process.argv.slice(2);
  if (!stagedPath || !manifestPath || !outputDirectory) throw new Error("Usage: tsx scripts/reclassify-staged.ts <staged-products.jsonl> <manifest.json> <output-directory>");
  const result = await reclassifyOpenFoodFactsSnapshot({ stagedPath, manifestPath, outputDirectory });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1]?.endsWith("reclassify-staged.ts")) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
