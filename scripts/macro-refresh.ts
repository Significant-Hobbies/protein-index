import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { discoverOfficialBrandCatalog, validateOfficialBrandConfig, type OfficialBrandDiscoveryConfig } from "./adapters/official-brand-sitemap";
import { OPEN_FOOD_FACTS_EXPORT_URL, stageOpenFoodFacts, type StageResult } from "./adapters/open-food-facts";
import { discoverMachineLabelCandidates, type MachineLabelDiscoveryReport } from "./machine-label-discovery";
import { runMachineLabelCandidates } from "./machine-label-run";
import type { SourceManifest } from "../shared/types";

export type MacroRefreshPhase = "all" | "sources" | "labels";

export interface MacroRefreshSourceOutcome {
  id: string;
  kind: "open_food_facts" | "official_brand";
  sourceComplete: boolean;
  stagedRecords: number | null;
  stagedPath: string | null;
  manifestPath: string | null;
  error: string | null;
}

export interface MacroRefreshReport {
  schemaVersion: 1;
  kind: "zero_cost_macro_refresh";
  runId: string;
  generatedAt: string;
  phase: MacroRefreshPhase;
  remotePublicationAttempted: false;
  configuredSources: string[];
  sourceBoundedComplete: boolean;
  marketComplete: false;
  sources: MacroRefreshSourceOutcome[];
  labels: {
    queuePath: string | null;
    queueSha256: string | null;
    eligible: number;
    selected: number;
    limit: number | null;
    machineRun: { processed: number; accepted: number; rejected: number; failed: number; cached: number } | null;
  };
}

interface Snapshot {
  id: string;
  kind: MacroRefreshSourceOutcome["kind"];
  stagedPath: string;
  manifestPath: string;
}

export interface MacroRefreshDependencies {
  download?: (input: { exportPath: string }) => Promise<void>;
  stage?: (input: { exportPath: string; outputDirectory: string }) => Promise<StageResult>;
  discoverBrand?: (input: { source: OfficialBrandDiscoveryConfig["sources"][number]; outputDirectory: string }) => Promise<{ manifest: SourceManifest; stagedPath: string; manifestPath: string }>;
  discoverCandidates?: (input: { stagedPath: string; sourceManifestPath: string; outputPath: string; reportPath: string }) => Promise<MachineLabelDiscoveryReport>;
  runLabels?: (input: { candidatesPath: string; outputDirectory: string; outcomesPath: string; limit: number | null }) => Promise<{ processed: number; accepted: number; rejected: number; failed: number; cached: number }>;
  now?: () => Date;
}

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function values(name: string): string[] {
  return process.argv.flatMap((value, index) => value === `--${name}` && process.argv[index + 1] ? [process.argv[index + 1]!] : []);
}

function phase(value: string | null): MacroRefreshPhase {
  if (value === null || value === "all" || value === "sources" || value === "labels") return value ?? "all";
  throw new Error("--phase must be all, sources, or labels.");
}

function positiveLimit(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--label-limit must be a positive integer.");
  return parsed;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function downloadOpenFoodFactsExport(input: { exportPath: string }): Promise<void> {
  await mkdir(join(input.exportPath, ".."), { recursive: true });
  const response = await fetch(OPEN_FOOD_FACTS_EXPORT_URL, {
    headers: {
      "user-agent": "protein-index/0.1 local-macro-refresh",
      ...(await exists(input.exportPath) ? { "if-modified-since": (await stat(input.exportPath)).mtime.toUTCString() } : {}),
    },
  });
  if (response.status === 304 && await exists(input.exportPath)) return;
  if (!response.ok || !response.body) throw new Error(`Open Food Facts export download failed: HTTP ${response.status}.`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(input.exportPath));
}

async function readCandidateLines(path: string): Promise<string[]> {
  const lines: string[] = [];
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of reader) if (line.trim()) lines.push(line);
  return lines;
}

async function writeLines(path: string, lines: string[]): Promise<string> {
  const value = lines.length ? `${lines.join("\n")}\n` : "";
  await writeFile(path, value, "utf8");
  return hash(value);
}

function defaultRunId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

export async function runMacroRefresh(input: {
  rootDirectory: string;
  configPath: string;
  runId?: string;
  phase?: MacroRefreshPhase;
  sourceIds?: string[];
  openFoodFactsInput?: string | null;
  labelLimit?: number | null;
  runLabels?: boolean;
}, dependencies: MacroRefreshDependencies = {}): Promise<MacroRefreshReport> {
  const now = dependencies.now ?? (() => new Date());
  const generatedAt = now().toISOString();
  const runId = input.runId ?? defaultRunId(now());
  const phaseValue = input.phase ?? "all";
  const runDirectory = join(input.rootDirectory, "runs", runId);
  const sourceDirectory = join(runDirectory, "sources");
  const labelsDirectory = join(runDirectory, "labels");
  await mkdir(sourceDirectory, { recursive: true });
  const config = JSON.parse(await readFile(input.configPath, "utf8")) as OfficialBrandDiscoveryConfig;
  validateOfficialBrandConfig(config);
  const configuredBrandSources = input.sourceIds?.length
    ? config.sources.filter((source) => input.sourceIds!.includes(source.id))
    : config.sources;
  if (input.sourceIds?.some((id) => !config.sources.some((source) => source.id === id))) {
    throw new Error("--source contains an id absent from the official-brand configuration.");
  }
  const outcomes: MacroRefreshSourceOutcome[] = [];
  const snapshots: Snapshot[] = [];

  if (phaseValue !== "labels") {
    const exportPath = input.openFoodFactsInput ?? join(input.rootDirectory, "cache", "openfoodfacts.tsv.gz");
    try {
      if (!input.openFoodFactsInput) await (dependencies.download ?? downloadOpenFoodFactsExport)({ exportPath });
      const outputDirectory = join(sourceDirectory, "open-food-facts");
      const staged = await (dependencies.stage ?? ((value) => stageOpenFoodFacts({
        input: value.exportPath,
        outputDirectory: value.outputDirectory,
        mode: "production",
        limit: null,
        format: "tsv",
      })))({ exportPath, outputDirectory });
      outcomes.push({ id: "open_food_facts", kind: "open_food_facts", sourceComplete: staged.manifest.sourceComplete, stagedRecords: staged.manifest.stagedRecords, stagedPath: staged.stagedPath, manifestPath: staged.manifestPath, error: null });
      if (staged.manifest.sourceComplete) snapshots.push({ id: "open_food_facts", kind: "open_food_facts", stagedPath: staged.stagedPath, manifestPath: staged.manifestPath });
    } catch (error) {
      outcomes.push({ id: "open_food_facts", kind: "open_food_facts", sourceComplete: false, stagedRecords: null, stagedPath: null, manifestPath: null, error: error instanceof Error ? error.message : String(error) });
    }
    for (const source of configuredBrandSources) {
      try {
        const result = await (dependencies.discoverBrand ?? ((value) => discoverOfficialBrandCatalog(value)))({ source, outputDirectory: join(sourceDirectory, source.id) });
        outcomes.push({ id: source.id, kind: "official_brand", sourceComplete: result.manifest.sourceComplete, stagedRecords: result.manifest.stagedRecords, stagedPath: result.stagedPath, manifestPath: result.manifestPath, error: null });
        if (result.manifest.sourceComplete) snapshots.push({ id: source.id, kind: "official_brand", stagedPath: result.stagedPath, manifestPath: result.manifestPath });
      } catch (error) {
        outcomes.push({ id: source.id, kind: "official_brand", sourceComplete: false, stagedRecords: null, stagedPath: null, manifestPath: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } else {
    const previous = JSON.parse(await readFile(join(runDirectory, "report.json"), "utf8")) as MacroRefreshReport;
    outcomes.push(...previous.sources);
    for (const outcome of outcomes) {
      if (outcome.sourceComplete && outcome.stagedPath && outcome.manifestPath) snapshots.push({ id: outcome.id, kind: outcome.kind, stagedPath: outcome.stagedPath, manifestPath: outcome.manifestPath });
    }
  }

  const sourceBoundedComplete = outcomes.length > 0 && outcomes.every((outcome) => outcome.sourceComplete);
  const labels: MacroRefreshReport["labels"] = { queuePath: null, queueSha256: null, eligible: 0, selected: 0, limit: input.labelLimit ?? null, machineRun: null };
  if (phaseValue !== "sources" && sourceBoundedComplete) {
    await mkdir(labelsDirectory, { recursive: true });
    const candidateLines: string[] = [];
    for (const snapshot of snapshots) {
      const candidatePath = join(labelsDirectory, `${snapshot.id}.candidates.jsonl`);
      const reportPath = join(labelsDirectory, `${snapshot.id}.report.json`);
      const report = await (dependencies.discoverCandidates ?? discoverMachineLabelCandidates)({ stagedPath: snapshot.stagedPath, sourceManifestPath: snapshot.manifestPath, outputPath: candidatePath, reportPath });
      labels.eligible += report.selectedRecords;
      candidateLines.push(...await readCandidateLines(candidatePath));
    }
    const selected = candidateLines
      .sort((left, right) => JSON.parse(left).id.localeCompare(JSON.parse(right).id))
      .slice(0, input.labelLimit ?? candidateLines.length);
    labels.selected = selected.length;
    labels.queuePath = join(labelsDirectory, "candidates.jsonl");
    labels.queueSha256 = await writeLines(labels.queuePath, selected);
    if (input.runLabels && labels.selected > 0) {
      labels.machineRun = await (dependencies.runLabels ?? ((value) => runMachineLabelCandidates({
        candidatesPath: value.candidatesPath,
        outputDirectory: value.outputDirectory,
        outcomesPath: value.outcomesPath,
        limit: value.limit,
      })))({ candidatesPath: labels.queuePath, outputDirectory: join(labelsDirectory, "machine"), outcomesPath: join(labelsDirectory, "outcomes.jsonl"), limit: input.labelLimit ?? null });
    }
  }
  const report: MacroRefreshReport = {
    schemaVersion: 1,
    kind: "zero_cost_macro_refresh",
    runId,
    generatedAt,
    phase: phaseValue,
    remotePublicationAttempted: false,
    configuredSources: ["open_food_facts", ...configuredBrandSources.map((source) => source.id)],
    sourceBoundedComplete,
    marketComplete: false,
    sources: outcomes,
    labels,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(join(runDirectory, "report.json"), serialized, "utf8");
  await writeFile(join(runDirectory, "checksums.sha256"), `${hash(serialized)}  report.json\n`, "utf8");
  return report;
}

async function main(): Promise<void> {
  const rootDirectory = option("root") ?? ".data/macro-refresh";
  const configPath = option("config") ?? "config/official-brand-sources.json";
  const labelLimit = positiveLimit(option("label-limit"));
  const report = await runMacroRefresh({
    rootDirectory,
    configPath,
    runId: option("run-id") ?? undefined,
    phase: phase(option("phase")),
    sourceIds: values("source"),
    openFoodFactsInput: option("open-food-facts-input"),
    labelLimit,
    runLabels: process.argv.includes("--run-labels"),
  });
  process.stdout.write(`${JSON.stringify({ runId: report.runId, sourceBoundedComplete: report.sourceBoundedComplete, marketComplete: report.marketComplete, labels: report.labels, report: join(rootDirectory, "runs", report.runId, "report.json") })}\n`);
  if (!report.sourceBoundedComplete) process.exitCode = 2;
}

if (process.argv[1]?.endsWith("macro-refresh.ts")) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
