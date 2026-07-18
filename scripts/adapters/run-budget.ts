/**
 * Per-run cost/volume budget tracker for provider adapters.
 *
 * Each adapter main loop records API calls, bytes downloaded, and image counts.
 * When a budget is exceeded the tracker throws an {@link RunBudgetExceededError}
 * with an inspectable reason, so the run fails closed instead of silently
 * amplifying unbounded provider work from input size.
 *
 * Budgets are intentionally generous defaults that only catch runaway loops
 * (e.g. a pagination bug or a retry storm). Normal production runs should never
 * approach them.
 */

export const DEFAULT_MAX_API_CALLS_PER_RUN = 6_000;
export const DEFAULT_MAX_BANDWIDTH_BYTES_PER_RUN = 2 * 1024 * 1024 * 1024; // 2 GiB
export const DEFAULT_MAX_IMAGES_PER_RUN = 20_000;

export interface RunBudgetOptions {
  maxApiCalls?: number;
  maxBandwidthBytes?: number;
  maxImages?: number;
}

export interface RunBudgetSnapshot {
  apiCalls: number;
  bytesDownloaded: number;
  imagesDownloaded: number;
  maxApiCalls: number;
  maxBandwidthBytes: number;
  maxImages: number;
}

export class RunBudgetExceededError extends Error {
  readonly kind: "api_calls" | "bandwidth" | "images";
  readonly snapshot: RunBudgetSnapshot;

  constructor(kind: RunBudgetExceededError["kind"], message: string, snapshot: RunBudgetSnapshot) {
    super(message);
    this.name = "RunBudgetExceededError";
    this.kind = kind;
    this.snapshot = snapshot;
  }
}

export class RunBudget {
  private apiCalls = 0;
  private bytesDownloaded = 0;
  private imagesDownloaded = 0;
  readonly maxApiCalls: number;
  readonly maxBandwidthBytes: number;
  readonly maxImages: number;

  constructor(options: RunBudgetOptions = {}) {
    this.maxApiCalls = options.maxApiCalls ?? DEFAULT_MAX_API_CALLS_PER_RUN;
    this.maxBandwidthBytes = options.maxBandwidthBytes ?? DEFAULT_MAX_BANDWIDTH_BYTES_PER_RUN;
    this.maxImages = options.maxImages ?? DEFAULT_MAX_IMAGES_PER_RUN;
  }

  /** Record one API call and fail closed when the call budget is exceeded. */
  recordApiCall(): void {
    this.apiCalls += 1;
    if (this.apiCalls > this.maxApiCalls) {
      throw new RunBudgetExceededError(
        "api_calls",
        `Run budget exceeded: ${this.apiCalls} API calls (max ${this.maxApiCalls}).`,
        this.snapshot(),
      );
    }
  }

  /** Record downloaded bytes and fail closed when the bandwidth budget is exceeded. */
  recordBytes(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    this.bytesDownloaded += bytes;
    if (this.bytesDownloaded > this.maxBandwidthBytes) {
      throw new RunBudgetExceededError(
        "bandwidth",
        `Run budget exceeded: ${this.bytesDownloaded} bytes downloaded (max ${this.maxBandwidthBytes}).`,
        this.snapshot(),
      );
    }
  }

  /** Record one downloaded image and fail closed when the image budget is exceeded. */
  recordImage(): void {
    this.imagesDownloaded += 1;
    if (this.imagesDownloaded > this.maxImages) {
      throw new RunBudgetExceededError(
        "images",
        `Run budget exceeded: ${this.imagesDownloaded} images downloaded (max ${this.maxImages}).`,
        this.snapshot(),
      );
    }
  }

  snapshot(): RunBudgetSnapshot {
    return {
      apiCalls: this.apiCalls,
      bytesDownloaded: this.bytesDownloaded,
      imagesDownloaded: this.imagesDownloaded,
      maxApiCalls: this.maxApiCalls,
      maxBandwidthBytes: this.maxBandwidthBytes,
      maxImages: this.maxImages,
    };
  }
}
