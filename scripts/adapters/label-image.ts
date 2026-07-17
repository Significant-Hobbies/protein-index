import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
  ExtractionAttempt,
  ExtractionAttemptLabel,
  ExtractionFieldFamily,
  LabelEvidenceAsset,
} from "../../shared/extraction-outcomes";
import { validateLabelEvidenceAsset } from "../../shared/extraction-outcomes";
import { compositeIdentityKey } from "../../shared/gtin";
import type { StagedProduct } from "../../shared/types";

export const DEFAULT_LABEL_IMAGE_MAX_BYTES = 12 * 1024 * 1024;
export const DEFAULT_LABEL_IMAGE_MAX_CHUNKS = 65_536;
export const DEFAULT_LABEL_IMAGE_TIMEOUT_MS = 30_000;

export type LabelImageFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface HashedLabelImage {
  requestedUrl: string;
  effectiveUrl: string;
  contentSha256: string;
  byteLength: number;
  mediaType: string;
  fetchedAt: string;
}

export interface LabelImageReference {
  sourceImageId: string;
  sourceImageRevision: string | null;
  url: string;
}

export type LabelImageHashErrorCode =
  | "invalid_url"
  | "insecure_url"
  | "fetch_failed"
  | "request_timeout"
  | "http_error"
  | "invalid_redirect"
  | "invalid_media_type"
  | "invalid_content_length"
  | "declared_size_exceeded"
  | "stream_missing"
  | "stream_size_exceeded"
  | "stream_chunk_limit_exceeded"
  | "stream_read_failed";

export class LabelImageHashError extends Error {
  readonly code: LabelImageHashErrorCode;

  constructor(code: LabelImageHashErrorCode, message: string) {
    super(message);
    this.name = "LabelImageHashError";
    this.code = code;
  }
}

export function stableExtractionId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

export function stagedProductId(product: StagedProduct): string {
  const composite = compositeIdentityKey(product);
  const identity = product.gtin
    ? `gtin:${product.gtin}`
    : composite
      ? `composite:${composite}`
      : `source:${product.source}:${product.sourceRecordId}`;
  return stableExtractionId("prd", identity);
}

export function stagedSourceRecordId(product: StagedProduct): string {
  return stableExtractionId("src", `${product.source}:${product.sourceRecordId}`);
}

export function labelReferenceFromUrl(url: string, sourceImageId?: string | null): LabelImageReference {
  const parsed = parseHttpsUrl(url, "invalid_url");
  const basename = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "label";
  const revisionMatch = /^(.*)\.(\d+)(?:\.\d+)?\.[a-z0-9]+$/i.exec(basename);
  return {
    sourceImageId: sourceImageId?.trim() || parsed.pathname,
    sourceImageRevision: revisionMatch?.[2] ?? null,
    url: parsed.toString(),
  };
}

export function predictionLabelReference(value: unknown): LabelImageReference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prediction = value as Record<string, unknown>;
  const image = typeof prediction.image === "object" && prediction.image !== null && !Array.isArray(prediction.image)
    ? prediction.image as Record<string, unknown>
    : null;
  if (!image) return null;
  const source = typeof image.source_image === "string" ? image.source_image.trim() : "";
  if (!source) return null;
  let url: string;
  try {
    url = new URL(source.replace(/^\//, ""), "https://images.openfoodfacts.org/images/products/").toString();
  } catch {
    return null;
  }
  const sourceImageId = typeof image.image_id === "string" || typeof image.image_id === "number"
    ? String(image.image_id)
    : null;
  return labelReferenceFromUrl(url, sourceImageId);
}

export function createLabelEvidenceAsset(input: {
  product: StagedProduct;
  fieldFamily: ExtractionFieldFamily;
  reference: LabelImageReference;
  hash: HashedLabelImage;
}): LabelEvidenceAsset {
  const subjectSourceRecordId = stagedSourceRecordId(input.product);
  const productId = stagedProductId(input.product);
  const naturalKey = [
    subjectSourceRecordId,
    input.product.contentHash,
    productId,
    input.fieldFamily,
    input.reference.sourceImageId,
    input.reference.sourceImageRevision ?? "",
    input.hash.effectiveUrl,
    input.hash.contentSha256,
  ].join(":");
  return {
    id: stableExtractionId("lbl", naturalKey),
    subjectSourceRecordId,
    subjectSourceContentHash: input.product.contentHash,
    productId,
    fieldFamily: input.fieldFamily,
    sourceImageId: input.reference.sourceImageId,
    sourceImageRevision: input.reference.sourceImageRevision,
    requestedUrl: input.hash.requestedUrl,
    effectiveUrl: input.hash.effectiveUrl,
    contentSha256: input.hash.contentSha256,
    byteLength: input.hash.byteLength,
    mediaType: input.hash.mediaType,
    fetchedAt: input.hash.fetchedAt,
  };
}

export function createExtractionAttempt(input: Omit<ExtractionAttempt, "id">): ExtractionAttempt {
  return {
    ...input,
    id: stableExtractionId("xat", [
      input.extractionRunId,
      input.subjectSourceRecordId,
      input.subjectSourceContentHash,
      input.fieldFamily,
      input.responseEvidenceHash,
      input.attemptedAt,
    ].join(":")),
  };
}

export function createExtractionAttemptLabel(input: Omit<ExtractionAttemptLabel, "id">): ExtractionAttemptLabel {
  return {
    ...input,
    id: stableExtractionId("xal", `${input.attemptId}:${input.labelAssetId}:${input.role}`),
  };
}

export function labelAssetReuseKey(input: Pick<LabelEvidenceAsset,
  "subjectSourceRecordId" | "subjectSourceContentHash" | "fieldFamily" | "requestedUrl"
>): string {
  return [input.subjectSourceRecordId, input.subjectSourceContentHash, input.fieldFamily, input.requestedUrl].join(":");
}

export async function readPriorLabelAssets(path: string): Promise<Map<string, LabelEvidenceAsset>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Map();
    throw error;
  }
  const assets = new Map<string, LabelEvidenceAsset>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let asset: LabelEvidenceAsset;
    try {
      asset = JSON.parse(line) as LabelEvidenceAsset;
    } catch {
      throw new Error(`prior-label-assets.jsonl contains invalid JSON on line ${index + 1}`);
    }
    const errors = validateLabelEvidenceAsset(asset);
    if (errors.length > 0) throw new Error(`prior-label-assets.jsonl line ${index + 1} is invalid: ${errors.join("; ")}`);
    const key = labelAssetReuseKey(asset);
    if (assets.has(key)) throw new Error(`prior-label-assets.jsonl repeats ${key}`);
    assets.set(key, asset);
  }
  return assets;
}

export async function readReusableLabelAssets(paths: string[]): Promise<Map<string, LabelEvidenceAsset>> {
  const merged = new Map<string, LabelEvidenceAsset>();
  for (const path of paths) {
    const assets = await readPriorLabelAssets(path);
    for (const [key, asset] of assets) {
      const existing = merged.get(key);
      if (existing && existing.id !== asset.id) {
        throw new Error(`Reusable label evidence conflicts for ${key}`);
      }
      merged.set(key, asset);
    }
  }
  return merged;
}

function parseHttpsUrl(value: string, code: "invalid_url" | "invalid_redirect"): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new LabelImageHashError(code, code === "invalid_url"
      ? "Label image URL is invalid."
      : "Label image redirect URL is invalid.");
  }
  if (parsed.protocol !== "https:") {
    throw new LabelImageHashError(code === "invalid_url" ? "insecure_url" : "invalid_redirect", code === "invalid_url"
      ? "Label image URL must use HTTPS."
      : "Label image redirect must remain on HTTPS.");
  }
  return parsed;
}

function imageMediaType(value: string | null): string {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!/^image\/(?:avif|bmp|gif|jpeg|png|tiff|webp)$/.test(mediaType)) {
    throw new LabelImageHashError("invalid_media_type", "Label image response must use a supported image media type.");
  }
  return mediaType;
}

function declaredLength(value: string | null, maximumBytes: number): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) {
    throw new LabelImageHashError("invalid_content_length", "Label image Content-Length must be a non-negative integer.");
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new LabelImageHashError("invalid_content_length", "Label image Content-Length is outside the supported range.");
  }
  if (length > maximumBytes) {
    throw new LabelImageHashError("declared_size_exceeded", `Label image declared size exceeds ${maximumBytes} bytes.`);
  }
  return length;
}

export async function hashHttpsLabelImage(options: {
  url: string;
  fetcher?: LabelImageFetchLike;
  maximumBytes?: number;
  maximumChunks?: number;
  timeoutMilliseconds?: number;
  userAgent?: string;
  now?: () => Date;
}): Promise<HashedLabelImage> {
  const requested = parseHttpsUrl(options.url, "invalid_url");
  const maximumBytes = options.maximumBytes ?? DEFAULT_LABEL_IMAGE_MAX_BYTES;
  const maximumChunks = options.maximumChunks ?? DEFAULT_LABEL_IMAGE_MAX_CHUNKS;
  const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_LABEL_IMAGE_TIMEOUT_MS;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new RangeError("Label image maximumBytes must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(maximumChunks) || maximumChunks < 1) {
    throw new RangeError("Label image maximumChunks must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1) {
    throw new RangeError("Label image timeoutMilliseconds must be a positive safe integer.");
  }

  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
  try {
    let response: Response;
    try {
      response = await fetcher(requested, {
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
          ...(options.userAgent ? { "User-Agent": options.userAgent } : {}),
        },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted) {
        throw new LabelImageHashError("request_timeout", `Label image request exceeded ${timeoutMilliseconds} milliseconds.`);
      }
      throw new LabelImageHashError("fetch_failed", "Label image request failed before a response was received.");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new LabelImageHashError("http_error", `Label image returned HTTP ${response.status}.`);
    }
    const effective = parseHttpsUrl(response.url || requested.toString(), "invalid_redirect");
    const mediaType = imageMediaType(response.headers.get("content-type"));
    const expectedLength = declaredLength(response.headers.get("content-length"), maximumBytes);
    if (!response.body) throw new LabelImageHashError("stream_missing", "Label image response has no readable body.");

    const reader = response.body.getReader();
    const hash = createHash("sha256");
    let byteLength = 0;
    let chunks = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        if (!item.value) continue;
        chunks += 1;
        if (chunks > maximumChunks) {
          throw new LabelImageHashError("stream_chunk_limit_exceeded", `Label image stream exceeds ${maximumChunks} chunks.`);
        }
        byteLength += item.value.byteLength;
        if (byteLength > maximumBytes) {
          throw new LabelImageHashError("stream_size_exceeded", `Label image stream exceeds ${maximumBytes} bytes.`);
        }
        hash.update(item.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof LabelImageHashError) throw error;
      if (controller.signal.aborted) {
        throw new LabelImageHashError("request_timeout", `Label image request exceeded ${timeoutMilliseconds} milliseconds.`);
      }
      throw new LabelImageHashError("stream_read_failed", "Label image stream could not be read completely.");
    } finally {
      reader.releaseLock();
    }
    if (expectedLength !== null && expectedLength !== byteLength) {
      throw new LabelImageHashError("stream_read_failed", "Label image byte length does not match Content-Length.");
    }
    return {
      requestedUrl: requested.toString(),
      effectiveUrl: effective.toString(),
      contentSha256: hash.digest("hex"),
      byteLength,
      mediaType,
      fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}
