import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { downloadHttpsLabelImage, stableExtractionId } from "./adapters/label-image";
import { extractMachineLabel, MACHINE_LABEL_ADAPTER_VERSION, type MachineLabelArtifact } from "./machine-label";
import type { MachineLabelCandidate } from "./machine-label-discovery";
import type { LabelEvidenceAsset } from "../shared/extraction-outcomes";

export interface MachineLabelRunOutcome {
  schemaVersion: 1;
  candidate: MachineLabelCandidate;
  labelAsset: LabelEvidenceAsset | null;
  imagePath: string | null;
  artifactPath: string | null;
  artifact: MachineLabelArtifact | null;
  status: "accepted" | "rejected" | "failed" | "cached";
  error: string | null;
  completedAt: string;
}

function asCandidate(value: unknown): MachineLabelCandidate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Candidate must be an object.");
  const candidate = value as Partial<MachineLabelCandidate>;
  if (candidate.schemaVersion !== 1 || typeof candidate.id !== "string" || (candidate.source !== "open_food_facts" && candidate.source !== "official_brand")
    || typeof candidate.productId !== "string" || typeof candidate.subjectSourceRecordId !== "string"
    || typeof candidate.sourceRecordKey !== "string" || typeof candidate.sourceContentHash !== "string"
    || !candidate.label || typeof candidate.label.url !== "string") {
    throw new Error("Candidate is malformed.");
  }
  return candidate as MachineLabelCandidate;
}

async function readCandidates(path: string, limit: number | null, offset: number): Promise<MachineLabelCandidate[]> {
  const values: MachineLabelCandidate[] = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let seen = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (seen < offset) {
      seen += 1;
      continue;
    }
    values.push(asCandidate(JSON.parse(line)));
    if (limit !== null && values.length >= limit) break;
  }
  return values;
}

async function writeLine(stream: NodeJS.WritableStream, value: unknown): Promise<void> {
  if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
}

function cachedArtifact(value: unknown, contentSha256: string): MachineLabelArtifact | null {
  if (typeof value !== "object" || value === null) return null;
  const artifact = value as Partial<MachineLabelArtifact>;
  return artifact.adapterVersion === MACHINE_LABEL_ADAPTER_VERSION && artifact.image?.contentSha256 === contentSha256
    ? artifact as MachineLabelArtifact
    : null;
}

export async function runMachineLabelCandidates(input: {
  candidatesPath: string;
  outputDirectory: string;
  outcomesPath: string;
  limit?: number | null;
  offset?: number;
  now?: () => Date;
}): Promise<{ processed: number; accepted: number; rejected: number; failed: number; cached: number }> {
  const limit = input.limit ?? null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Machine-label run limit must be a positive integer.");
  const offset = input.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Machine-label run offset must be a non-negative integer.");
  await mkdir(input.outputDirectory, { recursive: true });
  const candidates = await readCandidates(input.candidatesPath, limit, offset);
  const outcomes = createWriteStream(input.outcomesPath, { encoding: "utf8" });
  const totals = { processed: 0, accepted: 0, rejected: 0, failed: 0, cached: 0 };
  try {
    // One local VLM process at a time keeps the 32B model deterministic and avoids
    // competing for unified memory. Downloads happen immediately before inference.
    for (const candidate of candidates) {
      const completedAt = (input.now ?? (() => new Date()))().toISOString();
      try {
        const downloaded = await downloadHttpsLabelImage({ url: candidate.label.url, userAgent: "ProteinIndex/1.0 label-verifier" });
        const labelDirectory = join(input.outputDirectory, candidate.id);
        await mkdir(labelDirectory, { recursive: true });
        const extension = downloaded.mediaType === "image/png" ? "png" : downloaded.mediaType === "image/webp" ? "webp" : "jpg";
        const imagePath = join(labelDirectory, `${downloaded.contentSha256}.${extension}`);
        await writeFile(imagePath, downloaded.bytes, { flag: "w" });
        const artifactPath = join(labelDirectory, "artifact.json");
        let artifact: MachineLabelArtifact | null = null;
        try { artifact = cachedArtifact(JSON.parse(await readFile(artifactPath, "utf8")), downloaded.contentSha256); } catch { /* no compatible artifact */ }
        const wasCached = artifact !== null;
        artifact ??= await extractMachineLabel(imagePath);
        if (!wasCached) await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
        const labelAsset: LabelEvidenceAsset = {
          id: stableExtractionId("lbl", [candidate.subjectSourceRecordId, candidate.sourceContentHash, candidate.productId, "nutrition", candidate.label.sourceImageId, candidate.label.sourceImageRevision ?? "", downloaded.effectiveUrl, downloaded.contentSha256].join(":")),
          subjectSourceRecordId: candidate.subjectSourceRecordId,
          subjectSourceContentHash: candidate.sourceContentHash,
          productId: candidate.productId,
          fieldFamily: "nutrition",
          sourceImageId: candidate.label.sourceImageId,
          sourceImageRevision: candidate.label.sourceImageRevision,
          requestedUrl: downloaded.requestedUrl,
          effectiveUrl: downloaded.effectiveUrl,
          contentSha256: downloaded.contentSha256,
          byteLength: downloaded.byteLength,
          mediaType: downloaded.mediaType,
          fetchedAt: downloaded.fetchedAt,
        };
        const status = wasCached ? "cached" : artifact.nutrition.accepted ? "accepted" : "rejected";
        totals[status] += 1;
        totals.processed += 1;
        await writeLine(outcomes, { schemaVersion: 1, candidate, labelAsset, imagePath, artifactPath, artifact, status, error: null, completedAt } satisfies MachineLabelRunOutcome);
        process.stdout.write(`${JSON.stringify({ candidateId: candidate.id, status, processed: totals.processed })}\n`);
      } catch (error) {
        totals.failed += 1;
        totals.processed += 1;
        await writeLine(outcomes, { schemaVersion: 1, candidate, labelAsset: null, imagePath: null, artifactPath: null, artifact: null, status: "failed", error: error instanceof Error ? error.message : String(error), completedAt } satisfies MachineLabelRunOutcome);
        process.stdout.write(`${JSON.stringify({ candidateId: candidate.id, status: "failed", processed: totals.processed })}\n`);
      }
    }
  } finally {
    outcomes.end();
    await once(outcomes, "finish");
  }
  return totals;
}

async function main(): Promise<void> {
  const [candidatesPath, outputDirectory, outcomesPath, rawLimit, rawOffset] = process.argv.slice(2);
  if (!candidatesPath || !outputDirectory || !outcomesPath) throw new Error("Usage: pnpm data:machine-run <candidates.jsonl> <output-directory> <outcomes.jsonl> [limit] [offset]");
  const limit = rawLimit === undefined ? null : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  const summary = await runMachineLabelCandidates({ candidatesPath, outputDirectory, outcomesPath, limit, offset });
  process.stdout.write(`${JSON.stringify({ candidates: basename(candidatesPath), outcomes: basename(outcomesPath), ...summary })}\n`);
}

if (process.argv[1]?.endsWith("machine-label-run.ts")) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`); process.exitCode = 1; });
}
