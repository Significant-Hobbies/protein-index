import { readFile } from "node:fs/promises";
import { discoverOfficialBrandCatalog, validateOfficialBrandConfig, type OfficialBrandDiscoveryConfig } from "./adapters/official-brand-sitemap";

async function main(): Promise<void> {
  const [configPath, sourceId, outputDirectory] = process.argv.slice(2);
  if (!configPath || !sourceId || !outputDirectory) throw new Error("Usage: pnpm data:brand-discover <sources.json> <source-id> <output-directory>");
  const config = JSON.parse(await readFile(configPath, "utf8")) as OfficialBrandDiscoveryConfig;
  validateOfficialBrandConfig(config);
  const source = config.sources.find((entry) => entry.id === sourceId);
  if (!source) throw new Error(`Configured official brand source ${sourceId} was not found.`);
  const result = await discoverOfficialBrandCatalog({ source, outputDirectory });
  process.stdout.write(`${JSON.stringify({ source: source.id, stagedRecords: result.manifest.stagedRecords, sourceComplete: result.manifest.sourceComplete, manifest: result.manifestPath })}\n`);
}

if (process.argv[1]?.endsWith("discover-official-brand.ts")) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
