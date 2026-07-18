import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { officialBrandVariantKey, validateOfficialBrandConfig, type OfficialBrandDiscoveryConfig } from "./adapters/official-brand-sitemap";
import { emitImportSql } from "./reconcile";
import type { SourceManifest, StagedProduct } from "../shared/types";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export interface OfficialBrandPublicationSource {
  source: string;
  manifest: SourceManifest;
  stagedRecords: number;
  excludedRecords: number;
  deduplicatedRecords: number;
  files: { manifest: string; staged: string; exclusions: string };
}

export interface OfficialBrandPublicationManifest {
  schemaVersion: 1;
  kind: "official_brand_publication";
  adapterVersion: "official-brand-publication-v1";
  inputHash: string;
  sourceComplete: true;
  marketComplete: false;
  startedAt: string;
  completedAt: string;
  sources: OfficialBrandPublicationSource[];
  stagedRecords: number;
  exclusions: number;
}

export interface OfficialBrandPublicationReport {
  sourceComplete: true;
  marketComplete: false;
  sources: Array<{ source: string; stagedRecords: number; excludedRecords: number; deduplicatedRecords: number }>;
  stagedRecords: number;
  exclusions: { records: number; reconcilesConfiguredSources: true };
}

export interface OfficialBrandPublicationSnapshot {
  directory: string;
  manifest: OfficialBrandPublicationManifest;
  report: OfficialBrandPublicationReport;
  stagedPath: string;
  sourceManifestsPath: string;
}

function assertSafeOutputDirectory(path: string): void {
  if (!path.trim()) throw new Error("Official-brand publication output directory is required.");
}

function countLines(value: string, name: string): number {
  if (!value.trim()) return 0;
  let count = 0;
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { JSON.parse(line); } catch { throw new Error(`${name} line ${index + 1} is not valid JSON.`); }
    count += 1;
  }
  return count;
}

function jsonLines<T>(value: string, name: string): T[] {
  const values: T[] = [];
  for (const [index, line] of value.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try { values.push(JSON.parse(line) as T); } catch { throw new Error(`${name} line ${index + 1} is not valid JSON.`); }
  }
  return values;
}

function sourceFiles(directory: string) {
  return {
    manifest: join(directory, "manifest.json"),
    staged: join(directory, "staged-products.jsonl"),
    exclusions: join(directory, "exclusions.jsonl"),
  };
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2).concat("\n");
}

async function checksumFiles(directory: string, files: string[]): Promise<string> {
  const entries = await Promise.all(files.sort().map(async (file) => {
    const bytes = await readFile(join(directory, file));
    return `${sha256(bytes)}  ${file}`;
  }));
  return `${entries.join("\n")}\n`;
}

function assertManifest(manifest: SourceManifest, expectedSource: string, stagedRecords: number): void {
  if (manifest.source !== expectedSource || manifest.sourceKind !== "brand") {
    throw new Error(`Official-brand artifact ${expectedSource} does not retain its configured source identity.`);
  }
  if (manifest.mode !== "production" || manifest.sourceComplete !== true || manifest.terminalEvidence !== "end_of_file") {
    throw new Error(`Official-brand artifact ${expectedSource} is not a complete production snapshot.`);
  }
  if (!manifest.inputHash || !/^[a-f0-9]{64}$/.test(manifest.inputHash)) {
    throw new Error(`Official-brand artifact ${expectedSource} has no valid input hash.`);
  }
  if (!Number.isSafeInteger(manifest.stagedRecords) || manifest.stagedRecords < 1 || manifest.stagedRecords !== stagedRecords) {
    throw new Error(`Official-brand artifact ${expectedSource} staged-record accounting differs from its manifest.`);
  }
}

export async function prepareOfficialBrandPublication(input: {
  configPath: string;
  sourceDirectories: Record<string, string>;
  outputDirectory: string;
  now?: () => Date;
}): Promise<OfficialBrandPublicationSnapshot> {
  assertSafeOutputDirectory(input.outputDirectory);
  const config = JSON.parse(await readFile(input.configPath, "utf8")) as OfficialBrandDiscoveryConfig;
  validateOfficialBrandConfig(config);
  const configured = config.sources.map(({ id }) => id).sort();
  const provided = Object.keys(input.sourceDirectories).sort();
  if (configured.join("\n") !== provided.join("\n")) {
    throw new Error("Official-brand publication requires exactly one artifact directory for every configured source.");
  }
  const root = resolve(input.outputDirectory);
  await mkdir(root, { recursive: false });
  const now = input.now ?? (() => new Date());
  const sources: OfficialBrandPublicationSource[] = [];
  const staged: StagedProduct[] = [];
  const exclusions: Array<Record<string, unknown>> = [];
  const sourceIndexes: Array<{ source: string; sourceRecordId: string; contentHash: string }> = [];
  const sourceManifests: Array<{ source: string; manifest: SourceManifest }> = [];
  const hashes: Array<{ source: string; manifestSha256: string; stagedSha256: string; exclusionsSha256: string }> = [];

  for (const source of configured) {
    const directory = input.sourceDirectories[source]!;
    const files = sourceFiles(directory);
    const [manifestText, stagedText, exclusionsText] = await Promise.all([
      readFile(files.manifest, "utf8"), readFile(files.staged, "utf8"), readFile(files.exclusions, "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as SourceManifest;
    const records = jsonLines<StagedProduct>(stagedText, `${source} staged-products.jsonl`);
    const sourceExclusions = jsonLines<Record<string, unknown>>(exclusionsText, `${source} exclusions.jsonl`);
    assertManifest(manifest, source, records.length);
    const seenRecords = new Set<string>();
    const seenVariants = new Set<string>();
    let deduplicatedRecords = 0;
    for (const product of records) {
      if (product.source !== source || product.sourceKind !== "brand" || !product.sourceRecordId || !product.contentHash) {
        throw new Error(`Official-brand artifact ${source} contains a record outside its source boundary.`);
      }
      if (seenRecords.has(product.sourceRecordId)) throw new Error(`Official-brand artifact ${source} repeats a source record identifier.`);
      seenRecords.add(product.sourceRecordId);
      const variant = officialBrandVariantKey(product);
      if (seenVariants.has(variant)) {
        deduplicatedRecords += 1;
        exclusions.push({ source, reason: "publication_duplicate_product_variant", sourceRecordId: product.sourceRecordId });
        continue;
      }
      seenVariants.add(variant);
      staged.push(product);
      sourceIndexes.push({ source, sourceRecordId: product.sourceRecordId, contentHash: product.contentHash });
    }
    exclusions.push(...sourceExclusions.map((exclusion) => ({ source, ...exclusion })));
    const relativeFiles = Object.fromEntries(Object.entries(files).map(([name, path]) => [name, relative(resolve(directory), path)])) as OfficialBrandPublicationSource["files"];
    const effectiveManifest: SourceManifest = {
      ...manifest,
      indiaRecords: records.length - deduplicatedRecords,
      stagedRecords: records.length - deduplicatedRecords,
      duplicateRecords: manifest.duplicateRecords + deduplicatedRecords,
    };
    sources.push({ source, manifest: effectiveManifest, stagedRecords: records.length - deduplicatedRecords, excludedRecords: sourceExclusions.length, deduplicatedRecords, files: relativeFiles });
    sourceManifests.push({ source, manifest: effectiveManifest });
    hashes.push({ source, manifestSha256: sha256(manifestText), stagedSha256: sha256(stagedText), exclusionsSha256: sha256(exclusionsText) });
  }

  if (staged.length === 0) throw new Error("Official-brand publication cohort contains no staged products.");
  const at = now().toISOString();
  const manifest: OfficialBrandPublicationManifest = {
    schemaVersion: 1,
    kind: "official_brand_publication",
    adapterVersion: "official-brand-publication-v1",
    inputHash: sha256(JSON.stringify(hashes.sort((left, right) => left.source.localeCompare(right.source)))),
    sourceComplete: true,
    marketComplete: false,
    startedAt: at,
    completedAt: at,
    sources,
    stagedRecords: staged.length,
    exclusions: exclusions.length,
  };
  const report: OfficialBrandPublicationReport = {
    sourceComplete: true,
    marketComplete: false,
    sources: sources.map(({ source, stagedRecords, excludedRecords, deduplicatedRecords }) => ({ source, stagedRecords, excludedRecords, deduplicatedRecords })),
    stagedRecords: staged.length,
    exclusions: { records: exclusions.length, reconcilesConfiguredSources: true },
  };
  await Promise.all([
    writeFile(join(root, "manifest.json"), stableJson(manifest)),
    writeFile(join(root, "report.json"), stableJson(report)),
    writeFile(join(root, "staged-products.jsonl"), staged.map((product) => JSON.stringify(product)).join("\n").concat("\n")),
    writeFile(join(root, "exclusions.jsonl"), exclusions.map((exclusion) => JSON.stringify(exclusion)).join("\n").concat("\n")),
    writeFile(join(root, "source-index.jsonl"), sourceIndexes.map((index) => JSON.stringify(index)).join("\n").concat("\n")),
    writeFile(join(root, "source-manifests.jsonl"), sourceManifests.map((entry) => JSON.stringify(entry)).join("\n").concat("\n")),
  ]);
  const checksumFilesList = ["manifest.json", "report.json", "staged-products.jsonl", "exclusions.jsonl", "source-index.jsonl", "source-manifests.jsonl"];
  await writeFile(join(root, "checksums.sha256"), await checksumFiles(root, checksumFilesList));
  return validateOfficialBrandPublicationSnapshot(root);
}

export async function validateOfficialBrandPublicationSnapshot(directory: string): Promise<OfficialBrandPublicationSnapshot> {
  const root = resolve(directory);
  const [manifestText, reportText, stagedText, sourceManifestsText, checksumText] = await Promise.all([
    readFile(join(root, "manifest.json"), "utf8"),
    readFile(join(root, "report.json"), "utf8"),
    readFile(join(root, "staged-products.jsonl"), "utf8"),
    readFile(join(root, "source-manifests.jsonl"), "utf8"),
    readFile(join(root, "checksums.sha256"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as OfficialBrandPublicationManifest;
  const report = JSON.parse(reportText) as OfficialBrandPublicationReport;
  if (manifest.schemaVersion !== 1 || manifest.kind !== "official_brand_publication" || manifest.adapterVersion !== "official-brand-publication-v1" || manifest.sourceComplete !== true || manifest.marketComplete !== false) {
    throw new Error("Official-brand publication manifest is invalid.");
  }
  const stagedRecords = countLines(stagedText, "official-brand publication staged-products.jsonl");
  const sourceManifests = jsonLines<{ source: string; manifest: SourceManifest }>(sourceManifestsText, "official-brand publication source-manifests.jsonl");
  if (stagedRecords !== manifest.stagedRecords || sourceManifests.length !== manifest.sources.length || report.stagedRecords !== manifest.stagedRecords || report.sourceComplete !== true || report.marketComplete !== false || report.exclusions?.reconcilesConfiguredSources !== true) {
    throw new Error("Official-brand publication accounting is inconsistent.");
  }
  const expected = new Map<string, string>();
  for (const line of checksumText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s{2}([a-z0-9.-]+)$/.exec(line);
    if (!match?.[1] || !match[2]) throw new Error("Official-brand publication checksum is malformed.");
    expected.set(match[2], match[1]);
  }
  const required = ["manifest.json", "report.json", "staged-products.jsonl", "exclusions.jsonl", "source-index.jsonl", "source-manifests.jsonl"];
  if (required.some((file) => !expected.has(file))) throw new Error("Official-brand publication checksum is incomplete.");
  for (const [file, digest] of expected) {
    if (sha256(await readFile(join(root, file))) !== digest) throw new Error(`Official-brand publication checksum mismatch for ${file}.`);
  }
  return { directory: root, manifest, report, stagedPath: join(root, "staged-products.jsonl"), sourceManifestsPath: join(root, "source-manifests.jsonl") };
}

export async function emitOfficialBrandPublicationImportSql(input: {
  directory: string;
  outputPath: string;
}): Promise<{ outputPath: string; products: number; runIds: string[] }> {
  const snapshot = await validateOfficialBrandPublicationSnapshot(input.directory);
  const [sourceManifestText, stagedText] = await Promise.all([
    readFile(snapshot.sourceManifestsPath, "utf8"),
    readFile(snapshot.stagedPath, "utf8"),
  ]);
  const manifests = jsonLines<{ source: string; manifest: SourceManifest }>(sourceManifestText, "official-brand publication source-manifests.jsonl")
    .sort((left, right) => left.source.localeCompare(right.source));
  const records = jsonLines<StagedProduct>(stagedText, "official-brand publication staged-products.jsonl");
  const bySource = new Map<string, StagedProduct[]>();
  for (const record of records) {
    const sourceRecords = bySource.get(record.source) ?? [];
    sourceRecords.push(record);
    bySource.set(record.source, sourceRecords);
  }
  if (bySource.size !== manifests.length || manifests.some(({ source, manifest }) => bySource.get(source)?.length !== manifest.stagedRecords)) {
    throw new Error("Official-brand publication source-set accounting is inconsistent before import SQL generation.");
  }
  const temporary = await mkdtemp(join(tmpdir(), "protein-brand-import-"));
  const runIds: string[] = [];
  let products = 0;
  try {
    const combinedSqlPath = join(temporary, "official-brand-import.sql");
    await writeFile(combinedSqlPath, "PRAGMA foreign_keys = ON;\nBEGIN IMMEDIATE;\n", "utf8");
    for (const { source, manifest } of manifests) {
      const stagedPath = join(temporary, `${source}.staged-products.jsonl`);
      const manifestPath = join(temporary, `${source}.manifest.json`);
      const sourceSqlPath = join(temporary, `${source}.sql`);
      await Promise.all([
        writeFile(stagedPath, bySource.get(source)!.map((record) => JSON.stringify(record)).join("\n").concat("\n")),
        writeFile(manifestPath, stableJson(manifest)),
      ]);
      const generated = await emitImportSql({
        stagedPath,
        manifestPath,
        outputPath: sourceSqlPath,
        includePragma: false,
        includeTransaction: false,
      });
      products += generated.products;
      runIds.push(generated.runId);
      await appendFile(combinedSqlPath, await readFile(sourceSqlPath, "utf8"));
    }
    await appendFile(combinedSqlPath, "COMMIT;\n");
    await writeFile(input.outputPath, await readFile(combinedSqlPath, "utf8"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { outputPath: input.outputPath, products, runIds };
}
