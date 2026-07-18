import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { extractMachineLabel, MACHINE_LABEL_ADAPTER_VERSION, type MachineLabelArtifact } from "./machine-label";

export interface MachineLabelBenchmarkCase {
  id: string;
  image: string;
  contentSha256: string;
  expect: {
    nutritionAccepted: boolean;
    ingredientsAccepted: boolean;
    basis?: "per_100g" | "per_100ml";
    nutrition?: Record<string, number | null>;
    ingredientsRaw?: string | null;
  };
}

export interface MachineLabelBenchmarkManifest { schemaVersion: 1; cases: MachineLabelBenchmarkCase[] }

function compare(caseInput: MachineLabelBenchmarkCase, artifact: MachineLabelArtifact): string[] {
  const errors: string[] = [];
  if (artifact.image.contentSha256 !== caseInput.contentSha256) errors.push("image_hash_mismatch");
  if (artifact.nutrition.accepted !== caseInput.expect.nutritionAccepted) errors.push("nutrition_acceptance_mismatch");
  if (artifact.ingredients.accepted !== caseInput.expect.ingredientsAccepted) errors.push("ingredient_acceptance_mismatch");
  if (caseInput.expect.basis && artifact.nutrition.basis !== caseInput.expect.basis) errors.push("basis_mismatch");
  for (const [field, expected] of Object.entries(caseInput.expect.nutrition ?? {})) {
    if (artifact.nutrition.nutrition?.[field as keyof typeof artifact.nutrition.nutrition] !== expected) errors.push(`nutrition_${field}_mismatch`);
  }
  if ("ingredientsRaw" in caseInput.expect && artifact.ingredients.ingredientsRaw !== caseInput.expect.ingredientsRaw) {
    errors.push("ingredients_raw_mismatch");
  }
  return errors;
}

async function reusableArtifact(path: string, contentSha256: string): Promise<MachineLabelArtifact | null> {
  try {
    const artifact = JSON.parse(await readFile(path, "utf8")) as Partial<MachineLabelArtifact>;
    return artifact.adapterVersion === MACHINE_LABEL_ADAPTER_VERSION && artifact.image?.contentSha256 === contentSha256
      ? artifact as MachineLabelArtifact
      : null;
  } catch {
    return null;
  }
}

export async function runMachineLabelBenchmark(manifestPath: string, artifactDirectory?: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as MachineLabelBenchmarkManifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.cases) || manifest.cases.length === 0) throw new Error("Benchmark manifest must contain non-empty schemaVersion 1 cases.");
  const results = [];
  for (const caseInput of manifest.cases) {
    if (!/^[a-f0-9]{64}$/.test(caseInput.contentSha256)) throw new Error(`${caseInput.id}: contentSha256 must be SHA-256.`);
    const artifactPath = artifactDirectory ? join(artifactDirectory, `${caseInput.id}.json`) : null;
    if (artifactDirectory) await mkdir(artifactDirectory, { recursive: true });
    const cached = artifactPath ? await reusableArtifact(artifactPath, caseInput.contentSha256) : null;
    const artifact = cached ?? await extractMachineLabel(resolve(dirname(manifestPath), caseInput.image));
    if (artifactPath) await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    results.push({ id: caseInput.id, errors: compare(caseInput, artifact), artifact });
  }
  const failed = results.filter(({ errors }) => errors.length > 0);
  const report = { schemaVersion: 1, manifestSha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex"), adapterVersion: MACHINE_LABEL_ADAPTER_VERSION, cases: results, passed: failed.length === 0 };
  if (!report.passed) throw new Error(`Machine-label benchmark failed: ${failed.map(({ id, errors }) => `${id}(${errors.join(",")})`).join(", ")}`);
  return report;
}

async function main(): Promise<void> {
  const manifest = process.argv[2]; const output = process.argv[3]; const artifacts = process.argv[4];
  if (!manifest || !output) throw new Error("Usage: pnpm data:machine-benchmark <manifest.json> <report.json>");
  const report = await runMachineLabelBenchmark(manifest, artifacts);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, passed: true, cases: (report.cases as unknown[]).length })}\n`);
}
if (process.argv[1]?.endsWith("machine-label-benchmark.ts")) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
