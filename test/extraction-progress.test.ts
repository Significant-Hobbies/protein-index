import { afterEach, describe, expect, it, vi } from "vitest";
import { startExtractionProgress } from "../scripts/adapters/extraction-progress";

afterEach(() => {
  vi.useRealTimers();
});

describe("extraction progress", () => {
  it("emits a bounded heartbeat without changing the supplied counters", () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    const snapshot = {
      processedBarcodes: 0,
      fetchedBarcodes: 0,
      resumedBarcodes: 0,
      fetchedLabelAssets: 0,
      reusedLabelAssets: 0,
      outcomes: { candidate: 0, failed: 0 },
    };
    const reporter = startExtractionProgress({
      label: "nutrition-v8",
      totalBarcodes: 10,
      intervalMs: 60_000,
      snapshot: () => snapshot,
      write: (message) => messages.push(message),
    });

    snapshot.processedBarcodes = 4;
    snapshot.resumedBarcodes = 4;
    snapshot.reusedLabelAssets = 6;
    snapshot.outcomes.candidate = 4;
    vi.advanceTimersByTime(180_000);
    reporter.stop();
    vi.advanceTimersByTime(180_000);

    expect(messages).toHaveLength(5);
    expect(messages[0]).toContain("[nutrition-v8] started: 0/10 barcodes (0.0%)");
    expect(messages[1]).toContain("progress: 4/10 barcodes (40.0%)");
    expect(messages[1]).toContain("labels fetched=0 reused=6");
    expect(messages[4]).toContain("stopped: 4/10 barcodes (40.0%)");
  });

  it("reports completion and ignores a failing log sink", () => {
    vi.useFakeTimers();
    const messages: string[] = [];
    let calls = 0;
    const reporter = startExtractionProgress({
      label: "ingredients-v3",
      totalBarcodes: 1,
      intervalMs: 60_000,
      snapshot: () => ({
        processedBarcodes: 1,
        fetchedBarcodes: 0,
        resumedBarcodes: 1,
        fetchedLabelAssets: 0,
        reusedLabelAssets: 1,
        outcomes: { candidate: 1, failed: 0 },
      }),
      write: (message) => {
        calls += 1;
        if (calls === 1) throw new Error("logging unavailable");
        messages.push(message);
      },
    });

    reporter.stop();

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("[ingredients-v3] complete: 1/1 barcodes (100.0%)");
  });
});
