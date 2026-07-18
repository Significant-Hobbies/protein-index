import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { emitMachinePublicationBatch, type BenchmarkReport } from "./machine-publication";
import type { MachineLabelRunOutcome } from "./machine-label-run";

const hash = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  const [outcomesPath, candidatesPath, benchmarkPath, outputDirectory] = process.argv.slice(2);
  if (!outcomesPath || !candidatesPath || !benchmarkPath || !outputDirectory) {
    throw new Error("Usage: pnpm data:machine-release <outcomes.jsonl> <candidates.jsonl> <benchmark.json> <output-directory>");
  }
  const [outcomesText, candidatesText, benchmarkText] = await Promise.all([readFile(outcomesPath, "utf8"), readFile(candidatesPath, "utf8"), readFile(benchmarkPath, "utf8")]);
  const outcomes = outcomesText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as MachineLabelRunOutcome);
  const benchmark = JSON.parse(benchmarkText) as BenchmarkReport;
  const candidateIds = new Set(candidatesText.split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { id: string }).id));
  const batch = emitMachinePublicationBatch(outcomes, benchmark, candidateIds);
  const portableOutcomes = outcomes.map(({ candidate, labelAsset, artifact, status, error, completedAt }) => ({ schemaVersion: 1, candidate, labelAsset, artifact, status, error, completedAt }));
  const portableText = portableOutcomes.map((outcome) => JSON.stringify(outcome)).join("\n").concat("\n");
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory);
  const manifest = {
    schemaVersion: 1,
    kind: "machine_evidence_release",
    releaseManifestSha256: batch.manifest.releaseManifestSha256,
    adapterVersion: batch.manifest.adapterVersion,
    outcomeCount: batch.manifest.outcomeCount,
    acceptedCount: batch.manifest.acceptedCount,
    accepted: batch.manifest.accepted,
    inputs: { outcomes: basename(outcomesPath), candidates: basename(candidatesPath), benchmark: basename(benchmarkPath) },
  };
  await Promise.all([
    writeFile(join(outputDirectory, "outcomes.jsonl"), portableText, "utf8"),
    writeFile(join(outputDirectory, "candidates.jsonl"), candidatesText, "utf8"),
    writeFile(join(outputDirectory, "benchmark.json"), benchmarkText, "utf8"),
    writeFile(join(outputDirectory, "import.sql"), batch.sql, "utf8"),
    writeFile(join(outputDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  ]);
  const files = ["benchmark.json", "candidates.jsonl", "import.sql", "manifest.json", "outcomes.jsonl"];
  const checksums = await Promise.all(files.map(async (file) => `${hash(await readFile(join(outputDirectory, file)))}  ${file}`));
  await writeFile(join(outputDirectory, "checksums.sha256"), `${checksums.join("\n")}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ directory: outputDirectory, acceptedCount: batch.manifest.acceptedCount, releaseManifestSha256: batch.manifest.releaseManifestSha256 })}\n`);
}

if (process.argv[1]?.endsWith("create-machine-release-bundle.ts")) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
