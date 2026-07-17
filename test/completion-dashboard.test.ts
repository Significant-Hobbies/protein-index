import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CompletionLedgerItem } from "../shared/api";
import { CompletionOutcomeEvidence, CompletionPrimaryAction } from "../src/App";

function item(lane: CompletionLedgerItem["lane"] = "review_ready"): CompletionLedgerItem {
  return {
    product: {
      id: "product-exact-labels",
      gtin: "08900000000012",
      brand: "Evidence Foods",
      name: "Exact Label Protein",
      category: "protein_powder",
      imageUrl: null,
    },
    family: "nutrition",
    state: "outstanding",
    lane,
    fieldStatus: "unverified",
    terminalOutcome: null,
    labelUrl: "https://example.invalid/current-label.jpg",
    sourceUrl: null,
    sourceId: null,
    sourceRecordId: null,
    evidenceObservedAt: null,
    openCandidateCount: 1,
    openReviewCount: 1,
    primaryReviewId: lane === "review_ready" ? "review-exact-candidate" : null,
    primaryActionId: lane === "review_ready" ? "review-exact-candidate" : "product-exact-labels",
    extraction: {
      labels: 6,
      candidate: 1,
      noPrediction: 1,
      rejected: 1,
      failed: 1,
      unattempted: 1,
      stale: 1,
      conflicts: 0,
    },
    labels: [
      {
        attemptId: "attempt-current",
        labelAssetId: "asset-one",
        sourceImageId: "nutrition-en.1",
        role: "requested",
        outcome: "no_prediction",
        labelUrl: "https://example.invalid/label-one.jpg",
        contentSha256: "a".repeat(64),
        fetchedAt: "2026-07-17T12:00:00.000Z",
        attemptedAt: "2026-07-17T12:05:00.000Z",
      },
      {
        attemptId: "attempt-current",
        labelAssetId: "asset-two",
        sourceImageId: "nutrition-en.2",
        role: "prediction",
        outcome: "candidate",
        labelUrl: "https://example.invalid/label-two.jpg",
        contentSha256: "b".repeat(64),
        fetchedAt: "2026-07-17T12:00:00.000Z",
        attemptedAt: "2026-07-17T12:05:00.000Z",
      },
    ],
    labelsTruncated: true,
  };
}

describe("completion outcome dashboard", () => {
  it("renders textual counts, a semantic label list, and uniquely named label links", () => {
    const markup = renderToStaticMarkup(createElement(CompletionOutcomeEvidence, { item: item() }));
    expect(markup).toContain("<dl");
    expect(markup).toContain("<ol");
    expect(markup).toContain("No prediction");
    expect(markup).toContain("Candidate ready");
    expect(markup).toContain("Open nutrition label 1, nutrition-en.1, for Exact Label Protein");
    expect(markup).toContain("Open nutrition label 2, nutrition-en.2, for Exact Label Protein");
    expect(markup).toContain("View all 6 exact label outcomes");
    expect(markup).toContain("View all 6 exact nutrition label outcomes for Exact Label Protein");
    expect(markup).not.toContain("terminal failed");
  });

  it("uses exact review actions and explicit non-terminal extraction language", () => {
    const review = renderToStaticMarkup(createElement(CompletionPrimaryAction, {
      item: item("review_ready"),
      onOpenProduct: () => undefined,
      onOpenReview: () => undefined,
    }));
    const retry = renderToStaticMarkup(createElement(CompletionPrimaryAction, {
      item: item("retry_extraction"),
      onOpenProduct: () => undefined,
      onOpenReview: () => undefined,
    }));
    const manual = renderToStaticMarkup(createElement(CompletionPrimaryAction, {
      item: item("manual_label_review"),
      onOpenProduct: () => undefined,
      onOpenReview: () => undefined,
    }));
    expect(review).toContain("Review exact candidate");
    expect(retry).toContain("Retry automated extraction");
    expect(manual).toContain("Transcribe label manually");
  });
});
