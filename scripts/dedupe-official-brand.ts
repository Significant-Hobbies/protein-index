import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { OFFICIAL_BRAND_SITEMAP_ADAPTER_VERSION, officialBrandVariantKey } from "./adapters/official-brand-sitemap";
import type { SourceManifest, StagedProduct } from "../shared/types";

export async function dedupeOfficialBrandSnapshot(input: {
  stagedPath: string;
  manifestPath: string;
  outputDirectory: string;
  now?: () => Date;
}): Promise<{ stagedPath: string; manifestPath: string; stagedRecords: number; duplicateRecords: number }> {
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8")) as SourceManifest;
  if (manifest.sourceKind !== "brand" || !manifest.sourceComplete || manifest.terminalEvidence !== "end_of_file") {
    throw new Error("Official-brand deduplication requires a complete brand snapshot.");
  }
  await mkdir(input.outputDirectory, { recursive: true });
  const stagedPath = join(input.outputDirectory, "staged-products.jsonl");
  const exclusionsPath = join(input.outputDirectory, "exclusions.jsonl");
  const staged = createWriteStream(stagedPath, { encoding: "utf8" });
  const exclusions = createWriteStream(exclusionsPath, { encoding: "utf8" });
  const seen = new Set<string>();
  let stagedRecords = 0;
  let duplicateRecords = 0;
  try {
    const lines = createInterface({ input: createReadStream(input.stagedPath), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      const product = JSON.parse(line) as StagedProduct;
      const key = officialBrandVariantKey(product);
      if (seen.has(key)) {
        duplicateRecords += 1;
        if (!exclusions.write(`${JSON.stringify({ reason: "duplicate_product_variant", sourceRecordId: product.sourceRecordId, product: { brand: product.brand, name: product.name, flavour: product.flavour, netQuantityGrams: product.netQuantityGrams } })}\n`)) await once(exclusions, "drain");
        continue;
      }
      seen.add(key);
      stagedRecords += 1;
      if (!staged.write(`${JSON.stringify(product)}\n`)) await once(staged, "drain");
    }
  } finally {
    staged.end(); exclusions.end();
    await Promise.all([once(staged, "finish"), once(exclusions, "finish")]);
  }
  const at = (input.now ?? (() => new Date()))().toISOString();
  const refreshed: SourceManifest = {
    ...manifest,
    adapterVersion: OFFICIAL_BRAND_SITEMAP_ADAPTER_VERSION,
    startedAt: at,
    completedAt: at,
    stagedRecords,
    indiaRecords: stagedRecords,
    duplicateRecords: (manifest.duplicateRecords ?? 0) + duplicateRecords,
  };
  const manifestPath = join(input.outputDirectory, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");
  return { stagedPath, manifestPath, stagedRecords, duplicateRecords };
}

async function main(): Promise<void> {
  const [stagedPath, manifestPath, outputDirectory] = process.argv.slice(2);
  if (!stagedPath || !manifestPath || !outputDirectory) throw new Error("Usage: tsx scripts/dedupe-official-brand.ts <staged-products.jsonl> <manifest.json> <output-directory>");
  process.stdout.write(`${JSON.stringify(await dedupeOfficialBrandSnapshot({ stagedPath, manifestPath, outputDirectory }))}\n`);
}

if (process.argv[1]?.endsWith("dedupe-official-brand.ts")) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
