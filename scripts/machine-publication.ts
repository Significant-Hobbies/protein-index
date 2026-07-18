import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { canonicalJson } from "../shared/evidence-decisions";
import type { MachineLabelArtifact } from "./machine-label";
import type { LabelEvidenceAsset } from "../shared/extraction-outcomes";
import type { MachineLabelRunOutcome } from "./machine-label-run";

export interface MachinePublicationInput {
  productId: string;
  sourceRecordId: string;
  sourceContentHash: string;
  labelAssetId: string;
  sourceImageRevision: string | null;
  releaseManifestSha256: string;
  artifact: MachineLabelArtifact;
}

export interface BenchmarkReport {
  passed: boolean;
  adapterVersion: string;
  cases: Array<{ errors: string[] }>;
}

export function assertMachineBenchmarkReport(benchmark: BenchmarkReport, adapterVersion: string): void {
  if (benchmark.passed !== true || benchmark.adapterVersion !== adapterVersion
    || !Array.isArray(benchmark.cases) || benchmark.cases.length < 2
    || benchmark.cases.some((entry) => !Array.isArray(entry.errors) || entry.errors.length > 0)) {
    throw new Error("Machine publication requires a passing benchmark report for this adapter version.");
  }
}

const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const sql = (value: string | number | null) => value === null ? "NULL" : typeof value === "number" ? String(value) : `'${value.replaceAll("'", "''")}'`;

function requiredHash(value: string, name: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be a lower-case SHA-256.`);
  return value;
}

function labelAssetSql(asset: LabelEvidenceAsset): string {
  if (asset.fieldFamily !== "nutrition") throw new Error("Machine nutrition requires a nutrition label asset.");
  requiredHash(asset.subjectSourceContentHash, "label asset source hash"); requiredHash(asset.contentSha256, "label asset content hash");
  const values = [asset.id, asset.subjectSourceRecordId, asset.subjectSourceContentHash, asset.productId, asset.fieldFamily, asset.sourceImageId, asset.sourceImageRevision, asset.requestedUrl, asset.effectiveUrl, asset.contentSha256, asset.byteLength, asset.mediaType, asset.fetchedAt];
  return `INSERT INTO label_evidence_assets (id, subject_source_record_id, subject_source_content_hash, product_id, field_family, source_image_id, source_image_revision, requested_url, effective_url, content_sha256, byte_length, media_type, fetched_at) VALUES (${values.map(sql).join(", ")}) ON CONFLICT(id) DO NOTHING;\n`;
}

/** Emits transaction-free, idempotent SQL. D1 re-checks the label/source bindings. */
export function emitMachineNutritionSql(input: MachinePublicationInput): string {
  const { artifact } = input;
  if (!artifact.nutrition.accepted || !artifact.nutrition.nutrition) throw new Error("Only accepted nutrition artifacts may be published.");
  if (artifact.nutrition.basis !== "per_100g" && artifact.nutrition.basis !== "per_100ml") throw new Error("Machine nutrition requires a mass or volume basis.");
  const nutrition = artifact.nutrition.nutrition;
  if (nutrition.calories === null || nutrition.proteinGrams === null) throw new Error("Machine nutrition requires calories and protein.");
  requiredHash(input.sourceContentHash, "sourceContentHash");
  requiredHash(input.releaseManifestSha256, "releaseManifestSha256");
  const normalized = { basis: artifact.nutrition.basis, nutrition };
  const normalizedResultSha256 = hash(normalized);
  const id = `mvn_${createHash("sha256").update(`${input.productId}\n${input.sourceRecordId}\n${input.labelAssetId}\n${normalizedResultSha256}`).digest("hex").slice(0, 24)}`;
  const values = [
    id, input.productId, input.sourceRecordId, input.sourceContentHash, input.labelAssetId, artifact.image.contentSha256,
    input.sourceImageRevision, artifact.nutrition.basis, nutrition.calories, nutrition.proteinGrams,
    nutrition.carbohydrateGrams, nutrition.sugarGrams, nutrition.fatGrams, nutrition.saturatedFatGrams, nutrition.fibreGrams, nutrition.sodiumMg,
    artifact.vision.engine, artifact.vision.version, hash(artifact.vision), artifact.model.model, artifact.model.digest,
    hash(artifact.model.raw), artifact.model.promptHash, artifact.adapterVersion, normalizedResultSha256,
    "nutrition-v1", hash({ accepted: artifact.nutrition.accepted, reasons: artifact.nutrition.reasons }), input.releaseManifestSha256, artifact.generatedAt,
  ];
  const columns = "id, product_id, subject_source_record_id, subject_source_content_hash, label_asset_id, label_content_sha256, source_image_revision, basis, calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams, fibre_grams, sodium_mg, ocr_engine, ocr_version, ocr_output_sha256, model_id, model_digest, model_output_sha256, prompt_sha256, normalizer_version, normalized_result_sha256, validator_version, validation_report_sha256, release_manifest_sha256, verified_at";
  return `INSERT INTO machine_nutrition_verifications (${columns}) VALUES (${values.map(sql).join(", ")}) ON CONFLICT(id) DO NOTHING;\n`;
}

export interface MachinePublicationBatch {
  schemaVersion: 1;
  adapterVersion: string;
  outcomeCount: number;
  acceptedCount: number;
  releaseManifestSha256: string;
  accepted: Array<{ candidateId: string; productId: string; labelAssetId: string; sourceContentHash: string; labelContentSha256: string }>;
}

/** Builds a local-only, immutable SQL batch. Every accepted fact rebinds to its exact current source and label. */
export function emitMachinePublicationBatch(
  outcomes: MachineLabelRunOutcome[],
  benchmark: BenchmarkReport,
  eligibleCandidateIds?: ReadonlySet<string>,
): { sql: string; manifest: MachinePublicationBatch } {
  const accepted = outcomes.filter((outcome) => outcome.status === "accepted" && (eligibleCandidateIds === undefined || eligibleCandidateIds.has(outcome.candidate.id)));
  if (accepted.length === 0) throw new Error("Machine publication batch contains no accepted label outcomes.");
  const adapterVersion = accepted[0]?.artifact?.adapterVersion;
  if (!adapterVersion) throw new Error("Accepted machine outcome is missing its artifact.");
  assertMachineBenchmarkReport(benchmark, adapterVersion);
  const duplicateProducts = new Set<string>(); const seenProducts = new Map<string, string>();
  for (const outcome of accepted) {
    const artifact = outcome.artifact; const asset = outcome.labelAsset;
    if (!artifact || !asset || !artifact.nutrition.accepted || !artifact.nutrition.nutrition) throw new Error(`Accepted outcome ${outcome.candidate.id} is incomplete.`);
    if (artifact.adapterVersion !== adapterVersion || artifact.image.contentSha256 !== asset.contentSha256 || asset.productId !== outcome.candidate.productId || asset.subjectSourceRecordId !== outcome.candidate.subjectSourceRecordId || asset.subjectSourceContentHash !== outcome.candidate.sourceContentHash || asset.sourceImageRevision !== outcome.candidate.label.sourceImageRevision) throw new Error(`Accepted outcome ${outcome.candidate.id} has a mismatched source or label binding.`);
    const normalized = canonicalJson({ basis: artifact.nutrition.basis, nutrition: artifact.nutrition.nutrition }); const existing = seenProducts.get(asset.productId);
    if (existing && existing !== normalized) duplicateProducts.add(asset.productId); else seenProducts.set(asset.productId, normalized);
  }
  if (duplicateProducts.size > 0) throw new Error(`Machine publication refuses conflicting accepted labels for ${[...duplicateProducts].join(", ")}.`);
  const chosen = [...accepted].sort((left, right) => left.candidate.id.localeCompare(right.candidate.id)).filter((outcome, index, values) => values.findIndex((other) => other.labelAsset?.productId === outcome.labelAsset?.productId) === index);
  const releaseManifestSha256 = hash({ adapterVersion, benchmark: { adapterVersion: benchmark.adapterVersion, cases: benchmark.cases.length }, accepted: chosen.map((outcome) => ({ candidateId: outcome.candidate.id, productId: outcome.candidate.productId, sourceContentHash: outcome.candidate.sourceContentHash, labelContentSha256: outcome.labelAsset!.contentSha256, artifact: hash(outcome.artifact) })) });
  const manifest: MachinePublicationBatch = { schemaVersion: 1, adapterVersion, outcomeCount: outcomes.length, acceptedCount: chosen.length, releaseManifestSha256, accepted: chosen.map((outcome) => ({ candidateId: outcome.candidate.id, productId: outcome.candidate.productId, labelAssetId: outcome.labelAsset!.id, sourceContentHash: outcome.candidate.sourceContentHash, labelContentSha256: outcome.labelAsset!.contentSha256 })) };
  const statements = chosen.map((outcome) => `${labelAssetSql(outcome.labelAsset!)}${emitMachineNutritionSql({ productId: outcome.candidate.productId, sourceRecordId: outcome.candidate.subjectSourceRecordId, sourceContentHash: outcome.candidate.sourceContentHash, labelAssetId: outcome.labelAsset!.id, sourceImageRevision: outcome.candidate.label.sourceImageRevision, releaseManifestSha256, artifact: outcome.artifact! })}`);
  return { sql: statements.join(""), manifest };
}

async function main(): Promise<void> {
  if (process.argv[2] === "batch") {
    const [outcomesPath, outputPath, manifestPath, benchmarkPath, candidatesPath] = process.argv.slice(3);
    if (!outcomesPath || !outputPath || !manifestPath || !benchmarkPath) throw new Error("Usage: pnpm data:machine-publish-batch <outcomes.jsonl> <output.sql> <manifest.json> <benchmark-report.json> [current-candidates.jsonl]");
    const outcomes = (await readFile(outcomesPath, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as MachineLabelRunOutcome);
    const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8")) as BenchmarkReport;
    const candidateIds = candidatesPath
      ? new Set((await readFile(candidatesPath, "utf8")).split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { id: string }).id))
      : undefined;
    const batch = emitMachinePublicationBatch(outcomes, benchmark, candidateIds);
    await Promise.all([writeFile(outputPath, batch.sql, "utf8"), writeFile(manifestPath, `${JSON.stringify(batch.manifest, null, 2)}\n`, "utf8")]);
    process.stdout.write(`${JSON.stringify({ acceptedCount: batch.manifest.acceptedCount, releaseManifestSha256: batch.manifest.releaseManifestSha256 })}\n`);
    return;
  }
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  const benchmarkPath = process.argv[4];
  if (!inputPath || !outputPath || !benchmarkPath) throw new Error("Usage: pnpm data:machine-publish-sql <input.json> <output.sql> <benchmark-report.json>");
  const input = JSON.parse(await readFile(inputPath, "utf8")) as MachinePublicationInput;
  const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8")) as BenchmarkReport;
  assertMachineBenchmarkReport(benchmark, input.artifact.adapterVersion);
  await writeFile(outputPath, emitMachineNutritionSql(input), "utf8");
}

if (process.argv[1]?.endsWith("machine-publication.ts")) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
