import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { assertDataKartConfigured, DATAKART_ADAPTER_STATUS } from "./adapters/datakart";
import { stageOpenFoodFacts } from "./adapters/open-food-facts";
import { buildFixtureStage } from "./fixtures";
import { emitImportSql } from "./reconcile";

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? "unknown"}: ${stderr.trim()}`)));
  });
}

async function splitSqlFile(inputPath: string, maxBytes = 60_000): Promise<string[]> {
  const directory = `${inputPath}.chunks-${Date.now()}`;
  await mkdir(directory, { recursive: true });
  const chunks: string[] = [];
  let statements: string[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (statements.length === 0) return;
    const path = join(directory, `${String(chunks.length + 1).padStart(5, "0")}.sql`);
    await writeFile(path, `${statements.join("\n")}\n`, "utf8");
    chunks.push(path);
    statements = [];
    bytes = 0;
  };
  const lines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "BEGIN IMMEDIATE;" || trimmed === "COMMIT;") continue;
    const lineBytes = Buffer.byteLength(line) + 1;
    if (bytes > 0 && bytes + lineBytes > maxBytes) await flush();
    statements.push(line);
    bytes += lineBytes;
  }
  await flush();
  return chunks;
}

async function applyLocal(importSqlPath: string): Promise<void> {
  await run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "protein-index", "--local"]);
  const chunks = await splitSqlFile(importSqlPath);
  for (const chunk of chunks) {
    await run("pnpm", ["exec", "wrangler", "d1", "execute", "protein-index", "--local", "--file", chunk]);
  }
}

async function stageCommand(): Promise<void> {
  const source = option("source") ?? "open-food-facts";
  if (source === "datakart") assertDataKartConfigured();
  if (source !== "open-food-facts") throw new Error(`Unsupported source: ${source}`);
  const input = option("input");
  if (!input) throw new Error("--input is required for stage.");
  const mode = option("mode") === "production" ? "production" : "sample";
  const rawLimit = option("limit");
  const limit = rawLimit === null ? (mode === "sample" ? 100 : null) : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer.");
  const outputDirectory = option("output") ?? ".data/sync";
  const maximumDropPercent = Number(option("maximum-drop-percent") ?? "20");
  if (!Number.isFinite(maximumDropPercent) || maximumDropPercent < 0 || maximumDropPercent >= 100) {
    throw new Error("--maximum-drop-percent must be at least 0 and less than 100.");
  }
  const result = await stageOpenFoodFacts({
    input,
    outputDirectory,
    mode,
    limit,
    format: option("format") === "tsv" ? "tsv" : option("format") === "jsonl" ? "jsonl" : undefined,
    previousManifestPath: option("previous-manifest") ?? undefined,
    previousIndexPath: option("previous-index") ?? undefined,
    sourceUpdatedAt: option("source-updated-at"),
    maximumDropRatio: maximumDropPercent / 100,
  });
  const importSqlPath = join(outputDirectory, "import.sql");
  await emitImportSql({ stagedPath: result.stagedPath, manifestPath: result.manifestPath, outputPath: importSqlPath });
  if (hasFlag("apply-local")) await applyLocal(importSqlPath);
  process.stdout.write(`${JSON.stringify({ ...result, importSqlPath }, null, 2)}\n`);
}

async function seedCommand(): Promise<void> {
  const outputDirectory = ".data/fixture";
  await mkdir(outputDirectory, { recursive: true });
  const fixture = await buildFixtureStage(outputDirectory);
  const importSqlPath = join(outputDirectory, "import.sql");
  await emitImportSql({ stagedPath: fixture.stagedPath, manifestPath: fixture.manifestPath, outputPath: importSqlPath });
  await applyLocal(importSqlPath);
  process.stdout.write("Local fixture catalog migrated and seeded.\n");
}

async function coverageCommand(): Promise<void> {
  const directory = option("input") ?? ".data/sync";
  const [manifest, report] = await Promise.all([
    readFile(join(directory, "manifest.json"), "utf8"),
    readFile(join(directory, "report.json"), "utf8"),
  ]);
  process.stdout.write(`${JSON.stringify({ manifest: JSON.parse(manifest), report: JSON.parse(report) }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "stage") return stageCommand();
  if (command === "seed") return seedCommand();
  if (command === "coverage") return coverageCommand();
  if (command === "datakart-status") {
    process.stdout.write(`${JSON.stringify(DATAKART_ADAPTER_STATUS, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: sync.ts <stage|seed|coverage|datakart-status> [options]");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : null;
  process.stderr.write(`${JSON.stringify({ error: message, stack })}\n`);
  process.exitCode = 1;
});
