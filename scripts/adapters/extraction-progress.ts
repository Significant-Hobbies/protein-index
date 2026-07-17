export interface ExtractionProgressSnapshot {
  processedBarcodes: number;
  fetchedBarcodes: number;
  resumedBarcodes: number;
  fetchedLabelAssets: number;
  reusedLabelAssets: number;
  outcomes: Record<string, number>;
}

export type ExtractionProgressSink = (message: string) => void;

export function startExtractionProgress(options: {
  label: string;
  totalBarcodes: number;
  snapshot: () => ExtractionProgressSnapshot;
  write: ExtractionProgressSink;
  intervalMs?: number;
}): { stop: () => void } {
  const intervalMs = options.intervalMs ?? 60_000;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("Extraction progress interval must be positive.");
  }
  const startedAt = Date.now();
  let active = true;
  const emit = (phase: "started" | "progress" | "complete" | "stopped"): void => {
    if (!active && phase === "progress") return;
    const snapshot = options.snapshot();
    const percentage = options.totalBarcodes === 0
      ? "100.0"
      : ((snapshot.processedBarcodes / options.totalBarcodes) * 100).toFixed(1);
    const outcomes = Object.entries(snapshot.outcomes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, count]) => `${name}=${count}`)
      .join(" ");
    try {
      options.write(
        `[${options.label}] ${phase}: ${snapshot.processedBarcodes}/${options.totalBarcodes} barcodes (${percentage}%); `
        + `labels fetched=${snapshot.fetchedLabelAssets} reused=${snapshot.reusedLabelAssets}; `
        + `responses fetched=${snapshot.fetchedBarcodes} resumed=${snapshot.resumedBarcodes}; `
        + `outcomes ${outcomes}; elapsed=${Math.floor((Date.now() - startedAt) / 1_000)}s`,
      );
    } catch {
      // Progress reporting must never alter extraction behavior or artifacts.
    }
  };
  emit("started");
  const timer = setInterval(() => emit("progress"), intervalMs);
  timer.unref();
  return {
    stop: () => {
      if (!active) return;
      active = false;
      clearInterval(timer);
      const snapshot = options.snapshot();
      emit(snapshot.processedBarcodes === options.totalBarcodes ? "complete" : "stopped");
    },
  };
}
