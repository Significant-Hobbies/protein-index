import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SourceManifest } from "../shared/types";

interface PublicationReport {
  sourceComplete?: boolean;
  marketComplete?: boolean;
  requestedBarcodes?: number;
  accountedBarcodes?: number;
  outcomes?: {
    failed?: number;
  };
  continuity?: {
    currentStagedRecords?: number;
    previousStagedRecords?: number;
    missingSinceRecords?: number;
    maximumDropRatio?: number;
  };
  exclusions?: {
    records?: number;
    reconcilesIndiaSlice?: boolean;
  };
}

const BARCODE_ACCOUNTED_SOURCES = new Set([
  "open_food_facts_api",
  "open_food_facts_robotoff",
  "open_food_facts_robotoff_ingredients",
]);

const MULTI_PREDICTION_SOURCES = new Set([
  "open_food_facts_robotoff",
  "open_food_facts_robotoff_ingredients",
]);

export interface PublicationSnapshot {
  directory: string;
  manifestPath: string;
  reportPath: string;
  stagedPath: string;
  checksumsPath: string;
  manifest: SourceManifest;
  report: PublicationReport;
}

export function assertPublicationEvidence(manifest: SourceManifest, report: PublicationReport): void {
  const failures: string[] = [];
  if (manifest.mode !== "production") failures.push("manifest mode is not production");
  if (manifest.sourceComplete !== true) failures.push("manifest is not source complete");
  if (manifest.terminalEvidence !== "end_of_file") failures.push("terminal evidence is not end_of_file");
  if (!Number.isInteger(manifest.stagedRecords) || manifest.stagedRecords <= 0) failures.push("staged record count is empty or invalid");
  if (!Number.isInteger(manifest.indiaRecords) || manifest.indiaRecords <= 0) failures.push("India record count is empty or invalid");
  if (report.sourceComplete !== true) failures.push("report is not source complete");
  if (report.marketComplete !== false) failures.push("report must not claim market completeness");
  if (report.exclusions?.reconcilesIndiaSlice !== true) failures.push("India source accounting does not reconcile");
  const excluded = report.exclusions?.records;
  if (!MULTI_PREDICTION_SOURCES.has(manifest.source)
    && (!Number.isInteger(excluded) || manifest.stagedRecords + (excluded ?? 0) !== manifest.indiaRecords)) {
    failures.push("staged plus excluded records do not equal the India slice");
  }
  if (report.continuity?.currentStagedRecords !== undefined && report.continuity.currentStagedRecords !== manifest.stagedRecords) {
    failures.push("continuity staged count differs from manifest");
  }
  if ((report.continuity?.missingSinceRecords ?? 0) > 0) {
    const previous = report.continuity?.previousStagedRecords ?? 0;
    const missing = report.continuity?.missingSinceRecords ?? 0;
    const maximumDropRatio = report.continuity?.maximumDropRatio ?? 0;
    if (previous > 0 && missing / previous > maximumDropRatio) failures.push("snapshot exceeds the permitted continuity drop");
  }
  if (BARCODE_ACCOUNTED_SOURCES.has(manifest.source)) {
    if (report.requestedBarcodes !== manifest.indiaRecords) failures.push("requested barcode count differs from the manifest");
    if (report.accountedBarcodes !== report.requestedBarcodes) failures.push("barcode accounting does not reconcile");
    if (report.outcomes?.failed !== 0) failures.push("enrichment contains failed barcodes");
  }
  if (failures.length > 0) throw new Error(`Publication snapshot rejected: ${failures.join("; ")}`);
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function validatePublicationSnapshot(directory: string): Promise<PublicationSnapshot> {
  const manifestPath = join(directory, "manifest.json");
  const reportPath = join(directory, "report.json");
  const stagedPath = join(directory, "staged-products.jsonl");
  const checksumsPath = join(directory, "checksums.sha256");
  const [manifestText, reportText, checksumText] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(reportPath, "utf8"),
    readFile(checksumsPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestText) as SourceManifest;
  const report = JSON.parse(reportText) as PublicationReport;
  assertPublicationEvidence(manifest, report);

  const expectedFiles = new Map<string, string>();
  for (const line of checksumText.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match?.[1] || !match[2]) throw new Error(`Publication checksum line is malformed: ${line}`);
    const file = match[2].replace(/^\.\//, "");
    if (isAbsolute(file) || file.includes("\\") || file.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`Publication checksum path is not a safe portable relative path: ${match[2]}`);
    }
    expectedFiles.set(file, match[1]);
  }
  const requiredFiles = ["manifest.json", "report.json", "source-index.jsonl", "exclusions.jsonl", "staged-products.jsonl"];
  if (BARCODE_ACCOUNTED_SOURCES.has(manifest.source)) requiredFiles.push("outcomes.jsonl");
  for (const required of requiredFiles) {
    if (!expectedFiles.has(required)) throw new Error(`Publication checksum is missing ${required}`);
  }
  for (const [file, expected] of expectedFiles) {
    const actual = await sha256(join(directory, file));
    if (actual !== expected) throw new Error(`Publication checksum mismatch for ${file}`);
  }
  return { directory, manifestPath, reportPath, stagedPath, checksumsPath, manifest, report };
}
