import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prepareOfficialBrandPublication } from "./official-brand-publication";
import { validateOfficialBrandConfig, type OfficialBrandDiscoveryConfig } from "./adapters/official-brand-sitemap";

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const configPath = option("config") ?? "config/official-brand-sources.json";
  const inputRoot = option("input-root");
  const outputDirectory = option("output");
  if (!inputRoot || !outputDirectory) {
    throw new Error("Usage: pnpm data:brand-prepare -- --input-root <downloaded-artifacts> --output <publication-directory> [--config <sources.json>]");
  }
  const config = JSON.parse(await readFile(configPath, "utf8")) as OfficialBrandDiscoveryConfig;
  validateOfficialBrandConfig(config);
  const result = await prepareOfficialBrandPublication({
    configPath,
    sourceDirectories: Object.fromEntries(config.sources.map(({ id }) => [id, join(inputRoot, id)])),
    outputDirectory,
  });
  process.stdout.write(`${JSON.stringify({ directory: result.directory, inputHash: result.manifest.inputHash, stagedRecords: result.manifest.stagedRecords, sources: result.manifest.sources.map(({ source, stagedRecords }) => ({ source, stagedRecords })) }, null, 2)}\n`);
}

if (process.argv[1]?.endsWith("prepare-official-brand-publication.ts")) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
