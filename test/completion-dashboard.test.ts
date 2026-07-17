// @vitest-environment happy-dom

import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletionLedgerItem, CompletionLedgerResponse, CompletionSummary, ReviewItem, ReviewResponse } from "../shared/api";
import type { TerminalEvidenceOptionsResponse } from "../shared/terminal-evidence";
import { CompletionEvidenceDialog, CompletionOutcomeEvidence, CompletionPrimaryAction, CompletionWorklist, IdentityEvidenceForm, Reviews, TerminalEvidenceForm } from "../src/App";
import { api, TerminalEvidenceRequestError } from "../src/api";

const mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  for (const { root, container } of mountedRoots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function renderInteractive(element: ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  mountedRoots.push({ root, container });
  return { container, root };
}

function setControlValue(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = control instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  act(() => {
    setter?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitForm(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

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
    reasonCodes: ["no_prediction", "z_requested_reason"],
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
        reasonCodes: ["no_prediction_for_requested_label"],
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
        reasonCodes: [],
      },
    ],
    labelsTruncated: true,
  };
}

function identityItem(): CompletionLedgerItem {
  const identity = item("source_evidence_needed");
  identity.family = "identity";
  identity.sourceId = "open_food_facts";
  identity.sourceRecordId = "source-record-identity";
  identity.sourceUrl = "https://world.openfoodfacts.org/product/08900000000012";
  identity.extraction = {
    labels: 0,
    candidate: 0,
    noPrediction: 0,
    rejected: 0,
    failed: 0,
    unattempted: 0,
    stale: 0,
    conflicts: 0,
  };
  identity.labels = [];
  identity.labelsTruncated = false;
  return identity;
}

function identitySummary(verified = 0): CompletionSummary {
  const outstanding = verified === 0 ? 1 : 0;
  return {
    family: "identity",
    activeProducts: 1,
    verified,
    terminalUnavailable: 0,
    outstanding,
    contradictions: 0,
    accounted: 1,
    invariantHolds: true,
    lanes: {
      evidence_inconsistent: 0,
      conflict_resolution: 0,
      review_ready: 0,
      retry_extraction: 0,
      run_extraction: 0,
      manual_label_review: 0,
      structured_evidence_review: 0,
      source_evidence_needed: outstanding,
    },
  };
}

function identityLedger(verified = false): CompletionLedgerResponse {
  return {
    items: verified ? [] : [identityItem()],
    summary: identitySummary(verified ? 1 : 0),
    pagination: { page: 1, pageSize: 50, total: verified ? 0 : 1, pages: 1 },
    filters: { family: "identity", state: "outstanding", lane: "all", q: "", page: 1, pageSize: 50 },
    snapshotAt: "2026-07-17T12:00:00.000Z",
  };
}

function IdentityWorklistHarness({ refreshFails = false, onRefresh }: {
  refreshFails?: boolean;
  onRefresh?: () => void;
}) {
  const [data, setData] = useState(() => identityLedger());
  return createElement(CompletionWorklist, {
    data,
    fallbackSummary: identitySummary(),
    fallbackSnapshotAt: data.snapshotAt,
    loading: false,
    error: null,
    filters: { family: "identity", state: "outstanding", lane: "all", q: "", page: 1, pageSize: 50 },
    focusRequest: 0,
    onFamily: () => undefined,
    onState: () => undefined,
    onLane: () => undefined,
    onQuery: () => undefined,
    onPage: () => undefined,
    onRetry: () => undefined,
    onOpenProduct: () => undefined,
    onOpenReview: () => undefined,
    onEvidenceCommitted: async () => {
      onRefresh?.();
      if (refreshFails) throw new Error("Completion ledger could not be refreshed.");
      setData(identityLedger(true));
    },
    readOnly: false,
  });
}

function terminalOptions(overrides: Partial<TerminalEvidenceOptionsResponse> = {}): TerminalEvidenceOptionsResponse {
  const source = {
    evidenceId: "source:source-record-current",
    kind: "source" as const,
    sourceId: "official_source",
    sourceName: "Official Source",
    sourceRecordId: "source-record-current",
    sourceRecordKey: "official-product-key",
    sourceContentHash: "a".repeat(64),
    sourceUrl: "https://official.example/products/exact-label-protein",
    observedAt: "2026-07-17T12:00:00.000Z",
    authority: 100,
    labelAssetId: null,
    labelContentSha256: null,
    labelUrl: null,
    labelFetchedAt: null,
  };
  const label = {
    evidenceId: "label:label-asset-current",
    kind: "label" as const,
    sourceId: "brand_source",
    sourceName: "Brand Source",
    sourceRecordId: "brand-record-current",
    sourceRecordKey: "brand-product-key",
    sourceContentHash: "b".repeat(64),
    sourceUrl: "https://brand.example/products/exact-label-protein",
    observedAt: "2026-07-17T11:00:00.000Z",
    authority: 90,
    labelAssetId: "label-asset-current",
    labelContentSha256: "c".repeat(64),
    labelUrl: "https://brand.example/labels/exact-label-protein.jpg",
    labelFetchedAt: "2026-07-17T11:05:00.000Z",
  };
  return {
    productId: "product-exact-labels",
    family: "nutrition",
    items: [source, label],
    pagination: { page: 1, pageSize: 100, total: 2, pages: 1 },
    history: [
      {
        decision: {
          id: "terminal-history-current",
          idempotencyKey: "terminal:history:current",
          outcome: "not_declared",
          evidence: {
            kind: "source",
            sourceId: source.sourceId,
            sourceRecordKey: source.sourceRecordKey,
            sourceRecordId: source.sourceRecordId,
            sourceContentHash: source.sourceContentHash,
            productId: "product-exact-labels",
            fieldFamily: "nutrition",
          },
          rationale: "The official declaration has no nutrition panel.",
          decidedBy: "local_operator",
          decidedAt: "2026-07-17T12:10:00.000Z",
          supersedesDecisionId: null,
        },
        current: true,
        stale: false,
        superseded: false,
      },
      {
        decision: {
          id: "terminal-history-stale-label",
          idempotencyKey: "terminal:history:stale-label",
          outcome: "not_applicable",
          evidence: {
            kind: "label",
            sourceId: "stale_brand_source",
            sourceRecordKey: "stale-brand-key",
            sourceRecordId: "stale-brand-record",
            sourceContentHash: "d".repeat(64),
            productId: "product-exact-labels",
            fieldFamily: "nutrition",
            labelAssetId: "stale-label-asset",
            labelContentSha256: "e".repeat(64),
          },
          rationale: "A prior package marked nutrition not applicable.",
          decidedBy: "local_operator",
          decidedAt: "2026-07-16T12:10:00.000Z",
          supersedesDecisionId: null,
        },
        current: false,
        stale: true,
        superseded: false,
      },
    ],
    historyTruncated: false,
    contradiction: {
      hasConflict: true,
      outcomes: ["not_applicable", "not_declared"],
      factStatus: "verified",
      legacyProjection: true,
    },
    ...overrides,
  };
}

function terminalSummary(terminalUnavailable = 0): CompletionSummary {
  const outstanding = terminalUnavailable === 0 ? 1 : 0;
  return {
    family: "nutrition",
    activeProducts: 1,
    verified: 0,
    terminalUnavailable,
    outstanding,
    contradictions: 0,
    accounted: 1,
    invariantHolds: true,
    lanes: {
      evidence_inconsistent: 0,
      conflict_resolution: 0,
      review_ready: 0,
      retry_extraction: 0,
      run_extraction: 0,
      manual_label_review: 0,
      structured_evidence_review: 0,
      source_evidence_needed: outstanding,
    },
  };
}

function terminalLedger(recorded = false): CompletionLedgerResponse {
  return {
    items: recorded ? [] : [item("source_evidence_needed")],
    summary: terminalSummary(recorded ? 1 : 0),
    pagination: { page: 1, pageSize: 50, total: recorded ? 0 : 1, pages: 1 },
    filters: { family: "nutrition", state: "outstanding", lane: "all", q: "", page: 1, pageSize: 50 },
    snapshotAt: "2026-07-17T12:00:00.000Z",
  };
}

function TerminalWorklistHarness({ refreshFails = false, readOnly = false, onRefresh }: {
  refreshFails?: boolean;
  readOnly?: boolean;
  onRefresh?: () => void;
}) {
  const [data, setData] = useState(() => terminalLedger());
  return createElement(CompletionWorklist, {
    data,
    fallbackSummary: terminalSummary(),
    fallbackSnapshotAt: data.snapshotAt,
    loading: false,
    error: null,
    filters: { family: "nutrition", state: "outstanding", lane: "all", q: "", page: 1, pageSize: 50 },
    focusRequest: 0,
    onFamily: () => undefined,
    onState: () => undefined,
    onLane: () => undefined,
    onQuery: () => undefined,
    onPage: () => undefined,
    onRetry: () => undefined,
    onOpenProduct: () => undefined,
    onOpenReview: () => undefined,
    onEvidenceCommitted: async () => {
      onRefresh?.();
      if (refreshFails) throw new Error("Completion ledger could not be refreshed.");
      setData(terminalLedger(true));
    },
    readOnly,
  });
}

describe("completion outcome dashboard", () => {
  it("renders textual counts, a semantic label list, and uniquely named label links", () => {
    const markup = renderToStaticMarkup(createElement(CompletionOutcomeEvidence, { item: item() }));
    expect(markup).toContain("<dl");
    expect(markup).toContain("<ol");
    expect(markup).toContain("No prediction");
    expect(markup).toContain("Candidate ready");
    expect(markup).toContain("Why outstanding:");
    expect(markup).toContain("No prediction · Z requested reason");
    expect(markup).toContain("Reasons: No prediction for requested label");
    expect(markup).toContain("Open nutrition label 1, nutrition-en.1, for Exact Label Protein");
    expect(markup).toContain("Open nutrition label 2, nutrition-en.2, for Exact Label Protein");
    expect(markup).toContain("View all 6 exact label outcomes");
    expect(markup).toContain("View all 6 exact nutrition label outcomes for Exact Label Protein");
    expect(markup).not.toContain("terminal failed");
  });

  it("renders readable exception codes even when no extraction exists", () => {
    const sourceMissing = identityItem();
    sourceMissing.reasonCodes = ["authoritative_source_missing"];
    const markup = renderToStaticMarkup(createElement(CompletionOutcomeEvidence, { item: sourceMissing }));
    expect(markup).toContain("No exact label extraction recorded");
    expect(markup).toContain("Why outstanding:");
    expect(markup).toContain("Authoritative source missing");
  });

  it("presents a no-label failure as an unresolved residual exception", () => {
    const residual = item("retry_extraction");
    residual.fieldStatus = null;
    residual.openCandidateCount = 0;
    residual.openReviewCount = 0;
    residual.reasonCodes = ["extraction_failed", "label_declared_size_exceeded", "label_http_error"];
    residual.extraction = {
      labels: 0,
      candidate: 0,
      noPrediction: 0,
      rejected: 0,
      failed: 1,
      unattempted: 0,
      stale: 0,
      conflicts: 0,
    };
    residual.labels = [];
    residual.labelsTruncated = false;

    const evidence = renderToStaticMarkup(createElement(CompletionOutcomeEvidence, { item: residual }));
    const action = renderToStaticMarkup(createElement(CompletionPrimaryAction, {
      item: residual,
      onOpenProduct: () => undefined,
      onOpenReview: () => undefined,
    }));
    expect(evidence).toContain("Residual exception:");
    expect(evidence).toContain("No linked per-label outcome is available for the current failed attempt");
    expect(evidence).toContain("neither verified nor evidence-backed unavailable");
    expect(evidence).toContain("Retry extraction is the current next action");
    expect(evidence).toContain("<dt>failed</dt><dd>1</dd>");
    expect(evidence).toContain("Extraction failed · Label declared size exceeded · Label http error");
    expect(evidence).not.toContain("No exact label extraction recorded");
    expect(action).toContain("Retry automated extraction");
    expect(action).not.toContain("Record unavailable");
  });

  it("keeps residual retry visible without replacing a higher-priority review action", () => {
    const residual = item("review_ready");
    residual.reasonCodes = ["extraction_failed", "label_http_error", "review_candidate_pending"];
    residual.extraction.failed = 1;

    const evidence = renderToStaticMarkup(createElement(CompletionOutcomeEvidence, { item: residual }));
    const action = renderToStaticMarkup(createElement(CompletionPrimaryAction, {
      item: residual,
      onOpenProduct: () => undefined,
      onOpenReview: () => undefined,
    }));
    expect(evidence).toContain("Residual exception:");
    expect(evidence).toContain("Retry extraction remains required after the higher-priority action");
    expect(action).toContain("Review exact candidate");
    expect(action).not.toContain("Retry automated extraction");
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

  it("renders a source-bound identity verification form with explicit immutable confirmation", () => {
    const identity = item("source_evidence_needed");
    identity.family = "identity";
    identity.sourceId = "open_food_facts";
    identity.sourceRecordId = "source-record-identity";
    identity.sourceUrl = "https://world.openfoodfacts.org/product/08900000000012";
    const action = renderToStaticMarkup(createElement(CompletionPrimaryAction, {
      item: identity,
      onOpenProduct: () => undefined,
      onOpenReview: () => undefined,
      onRecordEvidence: () => undefined,
      readOnly: false,
    }));
    const form = renderToStaticMarkup(createElement(IdentityEvidenceForm, {
      item: identity,
      onVerified: () => undefined,
      onCancel: () => undefined,
    }));
    expect(action).toContain("Verify identity");
    expect(form).toContain("Exact current binding");
    expect(form).toContain("source-record-identity");
    expect(form).toContain("This creates immutable audit history");
    expect(form).toContain('type="checkbox"');
  });

  it("posts only the exact identity evidence request contract", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status: "verified",
      productId: "product-exact-labels",
      sourceRecordId: "source-record-identity",
      decisionId: "ied_123456789012345678901234",
      idempotent: false,
    }), { status: 201 }));
    await api.verifyIdentityEvidence("product-exact-labels", {
      sourceRecordId: "source-record-identity",
      evidenceUrl: "https://example.invalid/current-product",
      rationale: "Exact current package identity",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/products/product-exact-labels/identity-evidence", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      sourceRecordId: "source-record-identity",
      evidenceUrl: "https://example.invalid/current-product",
      rationale: "Exact current package identity",
    });
  });

  it("passes the current identity source evidence through the review match action", async () => {
    const sourceUrl = "https://brand.example/products/exact-identity";
    const reviewItem: ReviewItem = {
      id: "review-identity",
      type: "identity",
      priority: 90,
      status: "open",
      productId: "incoming-product",
      productName: "Incoming exact identity",
      brand: "Evidence Foods",
      sourceRecordId: "source-record-identity",
      sourceUrl,
      candidateProductIds: ["canonical-product"],
      candidates: [{
        id: "canonical-product",
        gtin: "08900000000012",
        brand: "Evidence Foods",
        name: "Canonical exact identity",
        flavour: null,
        netQuantityGrams: 1000,
        category: "protein_powder",
      }],
      evidence: {},
      selectedProjection: null,
      redundantProjectionMatches: false,
      redundantEligible: false,
      createdAt: "2026-07-17T12:00:00.000Z",
      decision: null,
      rationale: null,
      decisionEvidenceUrl: null,
      decidedBy: null,
    };
    const data: ReviewResponse = {
      items: [reviewItem],
      counts: { open: 1, resolved: 0, dismissed: 0 },
      pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
    };
    const onResolve = vi.fn(async () => undefined);
    const { container } = renderInteractive(createElement(Reviews, {
      data,
      loading: false,
      error: null,
      onResolve,
      onOpenProduct: vi.fn(),
      typeFilter: "identity",
      statusFilter: "open",
      page: 1,
      onType: vi.fn(),
      onStatus: vi.fn(),
      onPage: vi.fn(),
    }));
    expect(container.querySelector<HTMLInputElement>('input[name="evidenceUrl-review-identity"]')?.value).toBe(sourceUrl);
    const rationale = container.querySelector<HTMLTextAreaElement>('textarea[name="rationale-review-identity"]');
    if (!rationale) throw new Error("Expected identity rationale field");
    setControlValue(rationale, "Exact current source identifies the same package variant.");
    const match = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Match");
    if (!match) throw new Error("Expected identity match action");
    await act(async () => {
      match.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(onResolve).toHaveBeenCalledWith(
      reviewItem,
      "match",
      "Exact current source identifies the same package variant.",
      sourceUrl,
      "canonical-product",
      null,
      null,
    );
  });

  it("keeps identity input and the outstanding row intact when verification fails", async () => {
    const verify = vi.spyOn(api, "verifyIdentityEvidence").mockRejectedValue(new Error("The source identity changed after this row loaded."));
    const { container } = renderInteractive(createElement(IdentityWorklistHarness));
    const trigger = container.querySelector<HTMLButtonElement>('.completion-desktop button[aria-label^="Verify exact identity"]');
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());
    const url = container.querySelector<HTMLInputElement>('.completion-decision-form input[type="url"]');
    const rationale = container.querySelector<HTMLTextAreaElement>(".completion-decision-form textarea");
    const confirmed = container.querySelector<HTMLInputElement>('.completion-decision-form input[type="checkbox"]');
    const form = container.querySelector<HTMLFormElement>(".completion-decision-form");
    expect(url?.value).toBe("https://world.openfoodfacts.org/product/08900000000012");
    expect(rationale).not.toBeNull();
    expect(confirmed).not.toBeNull();
    expect(form).not.toBeNull();
    setControlValue(url!, "https://example.invalid/exact-current-label.jpg");
    setControlValue(rationale!, "Exact brand, flavour, and pack inspected");
    act(() => confirmed?.click());
    await submitForm(form!);

    expect(verify).toHaveBeenCalledWith("product-exact-labels", {
      sourceRecordId: "source-record-identity",
      evidenceUrl: "https://example.invalid/exact-current-label.jpg",
      rationale: "Exact brand, flavour, and pack inspected",
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The source identity changed after this row loaded.");
    expect(url?.value).toBe("https://example.invalid/exact-current-label.jpg");
    expect(rationale?.value).toBe("Exact brand, flavour, and pack inspected");
    expect(confirmed?.checked).toBe(true);
    expect(container.querySelector('.completion-desktop button[aria-label^="Verify exact identity"]')).not.toBeNull();
  });

  it("refreshes the identity worklist after success and announces the verified removal", async () => {
    vi.spyOn(api, "verifyIdentityEvidence").mockResolvedValue({
      status: "verified",
      productId: "product-exact-labels",
      sourceRecordId: "source-record-identity",
      decisionId: "ied_interaction_success",
      idempotent: false,
    });
    const onRefresh = vi.fn();
    const { container } = renderInteractive(createElement(IdentityWorklistHarness, { onRefresh }));
    const trigger = container.querySelector<HTMLButtonElement>('.completion-desktop button[aria-label^="Verify exact identity"]');
    act(() => trigger?.click());
    const rationale = container.querySelector<HTMLTextAreaElement>(".completion-decision-form textarea");
    const confirmed = container.querySelector<HTMLInputElement>('.completion-decision-form input[type="checkbox"]');
    const form = container.querySelector<HTMLFormElement>(".completion-decision-form");
    setControlValue(rationale!, "Exact current package identity");
    act(() => confirmed?.click());
    await submitForm(form!);

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector(".completion-empty")?.textContent).toContain("No products match this ledger view.");
    expect(container.querySelector('.completion-desktop button[aria-label^="Verify exact identity"]')).toBeNull();
    const status = container.querySelector('[role="status"].completion-commit-notice');
    expect(status?.textContent).toContain("Verification complete");
    expect(status?.textContent).toContain("Coverage and the worklist are current.");
  });

  it("reports that verification was saved when the subsequent dashboard refresh fails", async () => {
    vi.spyOn(api, "verifyIdentityEvidence").mockResolvedValue({
      status: "verified",
      productId: "product-exact-labels",
      sourceRecordId: "source-record-identity",
      decisionId: "ied_interaction_refresh_failure",
      idempotent: false,
    });
    const { container } = renderInteractive(createElement(IdentityWorklistHarness, { refreshFails: true }));
    const trigger = container.querySelector<HTMLButtonElement>('.completion-desktop button[aria-label^="Verify exact identity"]');
    act(() => trigger?.click());
    setControlValue(container.querySelector<HTMLTextAreaElement>(".completion-decision-form textarea")!, "Exact current package identity");
    act(() => container.querySelector<HTMLInputElement>('.completion-decision-form input[type="checkbox"]')?.click());
    await submitForm(container.querySelector<HTMLFormElement>(".completion-decision-form")!);

    const alert = container.querySelector('[role="alert"].completion-commit-notice');
    expect(alert?.textContent).toContain("Verification saved; refresh needed");
    expect(alert?.textContent).toContain("was saved");
    expect(alert?.textContent).toContain("dashboard refresh failed");
    expect(container.querySelector('.completion-desktop button[aria-label^="Verify exact identity"]')).not.toBeNull();
  });

  it("keeps keyboard focus inside the mobile dialog and restores its trigger after Escape", () => {
    const { container } = renderInteractive(createElement(IdentityWorklistHarness));
    const trigger = container.querySelector<HTMLButtonElement>('.completion-mobile button[aria-label^="Verify exact identity"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.focus();
      trigger?.click();
    });
    const dialog = container.querySelector<HTMLElement>('[role="dialog"]');
    const heading = dialog?.querySelector<HTMLElement>("h2");
    const close = dialog?.querySelector<HTMLButtonElement>('[aria-label="Close evidence decision"]');
    const cancel = dialog?.querySelector<HTMLButtonElement>(".completion-decision-buttons .ghost");
    expect(dialog?.getAttribute("aria-describedby")).toBe(heading?.nextElementSibling?.id);
    expect(document.activeElement).toBe(heading);

    act(() => {
      cancel?.focus();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(close);
    act(() => {
      close?.focus();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(cancel);

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("restores focus to the worklist heading when a responsive switch hides the saved trigger", () => {
    const { container } = renderInteractive(createElement(IdentityWorklistHarness));
    const mobile = container.querySelector<HTMLElement>(".completion-mobile");
    const trigger = mobile?.querySelector<HTMLButtonElement>('button[aria-label^="Verify exact identity"]');
    const heading = container.querySelector<HTMLElement>("#completion-worklist-heading");
    expect(trigger).not.toBeNull();
    expect(heading).not.toBeNull();
    act(() => {
      trigger?.focus();
      trigger?.click();
    });
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();

    mobile!.style.display = "none";
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));

    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(heading);
  });

  it("offers local terminal evidence without equating extraction failure with unavailability", () => {
    const nutrition = item("source_evidence_needed");
    const action = renderToStaticMarkup(createElement(CompletionPrimaryAction, {
      item: nutrition,
      onOpenProduct: () => undefined,
      onOpenReview: () => undefined,
      onRecordEvidence: () => undefined,
      readOnly: false,
    }));
    const form = renderToStaticMarkup(createElement(TerminalEvidenceForm, {
      item: nutrition,
      onRecorded: () => undefined,
      onCancel: () => undefined,
    }));
    expect(action).toContain("Record unavailable");
    expect(form).toContain("Loading exact current evidence");
    expect(form).not.toContain("Extraction failed means unavailable");
  });

  it("loads every bounded evidence page and fails closed before an unbounded fan-out", async () => {
    const base = terminalOptions({ history: [], contradiction: { hasConflict: false, outcomes: [], factStatus: null, legacyProjection: false } });
    const firstItems = Array.from({ length: 100 }, (_, index) => ({
      ...base.items[0]!,
      evidenceId: `source:bounded-${index}`,
      sourceRecordId: `bounded-${index}`,
      sourceRecordKey: `bounded-${index}`,
    }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const page = new URL(String(input), "http://localhost").searchParams.get("page");
      return new Response(JSON.stringify({
        ...base,
        items: page === "1" ? firstItems : [{ ...base.items[1]!, evidenceId: "label:bounded-last" }],
        pagination: { page: Number(page), pageSize: 100, total: 101, pages: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const exhaustive = await api.terminalEvidence("product-exact-labels", "nutrition");
    expect(exhaustive.items).toHaveLength(101);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      ...base,
      items: firstItems,
      pagination: { page: 1, pageSize: 100, total: 2_001, pages: 21 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(api.terminalEvidence("product-exact-labels", "nutrition"))
      .rejects.toThrow("bounded 2000-option review limit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders deliberate source and label selection with complete contradiction and history lineage", async () => {
    vi.spyOn(api, "terminalEvidence").mockResolvedValue(terminalOptions());
    const { container } = renderInteractive(createElement(TerminalEvidenceForm, {
      item: item("source_evidence_needed"),
      onRecorded: () => undefined,
      onCancel: () => undefined,
    }));
    await flushEffects();

    const evidenceRadios = [...container.querySelectorAll<HTMLInputElement>('.completion-evidence-options input[type="radio"]')];
    expect(evidenceRadios).toHaveLength(2);
    expect(evidenceRadios.every(({ checked }) => !checked)).toBe(true);
    expect(container.textContent).toContain("Not declared");
    expect(container.textContent).toContain("Not applicable");
    expect(container.textContent).toContain("Current sources disagree: not_applicable versus not_declared.");
    expect(container.textContent).toContain("A verified nutrition fact conflicts with unavailable evidence.");
    expect(container.textContent).toContain("A legacy unavailable projection has no current immutable evidence decision.");
    expect(container.textContent).toContain("stale binding");
    expect(container.textContent).toContain("stale_brand_source · record stale-brand-key");
    expect(container.textContent).toContain("Asset stale-label-asset");
    expect(container.textContent).toContain("Source SHA-256 dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd");
    expect([...container.querySelectorAll<HTMLAnchorElement>(".completion-evidence-option a")].map((link) => link.getAttribute("aria-label")))
      .toEqual([
        "Inspect current source record from Official Source for Exact Label Protein",
        "Inspect retained label from Brand Source for Exact Label Protein",
      ]);
  });

  it("submits the exact deliberately selected label and immutable correction intent", async () => {
    const options = terminalOptions({ history: [], contradiction: { hasConflict: false, outcomes: [], factStatus: null, legacyProjection: false } });
    vi.spyOn(api, "terminalEvidence").mockResolvedValue(options);
    const record = vi.spyOn(api, "recordTerminalEvidence").mockResolvedValue({
      status: "created",
      decision: terminalOptions().history[0]!.decision,
    });
    const onRecorded = vi.fn();
    const { container } = renderInteractive(createElement(TerminalEvidenceForm, {
      item: item("source_evidence_needed"),
      onRecorded,
      onCancel: () => undefined,
    }));
    await flushEffects();
    act(() => container.querySelector<HTMLInputElement>('input[value="label:label-asset-current"]')?.click());
    act(() => container.querySelector<HTMLInputElement>('input[value="not_applicable"]')?.click());
    setControlValue(container.querySelector<HTMLTextAreaElement>(".completion-decision-form textarea")!, "The exact retained panel explicitly marks nutrition as not applicable.");
    act(() => container.querySelector<HTMLInputElement>('.completion-decision-confirm input[type="checkbox"]')?.click());
    await submitForm(container.querySelector<HTMLFormElement>(".completion-decision-form")!);

    expect(record).toHaveBeenCalledWith("product-exact-labels", expect.objectContaining({
      family: "nutrition",
      outcome: "not_applicable",
      evidenceId: "label:label-asset-current",
      sourceContentHash: "b".repeat(64),
      labelContentSha256: "c".repeat(64),
      rationale: "The exact retained panel explicitly marks nutrition as not applicable.",
      supersedesDecisionId: null,
    }));
    expect(record.mock.calls[0]?.[1].idempotencyKey).toMatch(/^terminal:/);
    expect(onRecorded).toHaveBeenCalledOnce();
  });

  it("refreshes stale options while preserving rationale and requiring a new deliberate confirmation", async () => {
    const initial = terminalOptions({ history: [], contradiction: { hasConflict: false, outcomes: [], factStatus: null, legacyProjection: false } });
    const refreshedLabel = {
      ...initial.items[1]!,
      evidenceId: "label:label-asset-refreshed",
      labelAssetId: "label-asset-refreshed",
      labelContentSha256: "f".repeat(64),
    };
    const refreshed = {
      ...initial,
      items: [initial.items[0]!, refreshedLabel],
    };
    const list = vi.spyOn(api, "terminalEvidence")
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    vi.spyOn(api, "recordTerminalEvidence").mockRejectedValue(new TerminalEvidenceRequestError(
      "Evidence changed after selection",
      409,
      "stale_evidence",
      { evidenceId: "label:label-asset-current" },
    ));
    const { container } = renderInteractive(createElement(TerminalEvidenceForm, {
      item: item("source_evidence_needed"),
      onRecorded: () => undefined,
      onCancel: () => undefined,
    }));
    await flushEffects();
    act(() => container.querySelector<HTMLInputElement>('input[value="label:label-asset-current"]')?.click());
    const rationale = container.querySelector<HTMLTextAreaElement>(".completion-decision-form textarea")!;
    setControlValue(rationale, "The full retained panel was inspected.");
    act(() => container.querySelector<HTMLInputElement>('.completion-decision-confirm input[type="checkbox"]')?.click());
    await submitForm(container.querySelector<HTMLFormElement>(".completion-decision-form")!);
    await flushEffects();

    expect(list).toHaveBeenCalledTimes(2);
    expect(rationale.value).toBe("The full retained panel was inspected.");
    expect(container.querySelector<HTMLInputElement>('input[value="label:label-asset-refreshed"]')).not.toBeNull();
    expect([...container.querySelectorAll<HTMLInputElement>('.completion-evidence-options input[type="radio"]')].every(({ checked }) => !checked)).toBe(true);
    expect(container.querySelector<HTMLInputElement>('.completion-decision-confirm input[type="checkbox"]')?.checked).toBe(false);
    const alert = container.querySelector<HTMLElement>('[role="alert"].completion-decision-error');
    expect(alert?.textContent).toContain("Current exact evidence is refreshed");
    expect(alert?.textContent).toContain("Your rationale was preserved");
    expect(document.activeElement).toBe(alert);
  });

  it("keeps terminal input and the outstanding row intact when mutation fails", async () => {
    vi.spyOn(api, "terminalEvidence").mockResolvedValue(terminalOptions({ history: [], contradiction: { hasConflict: false, outcomes: [], factStatus: null, legacyProjection: false } }));
    const record = vi.spyOn(api, "recordTerminalEvidence").mockRejectedValue(new Error("The decision could not be recorded."));
    const { container } = renderInteractive(createElement(TerminalWorklistHarness));
    act(() => container.querySelector<HTMLButtonElement>('.completion-desktop button[aria-label^="Record exact nutrition"]')?.click());
    await flushEffects();
    act(() => container.querySelector<HTMLInputElement>('input[value="source:source-record-current"]')?.click());
    const rationale = container.querySelector<HTMLTextAreaElement>(".completion-decision-form textarea")!;
    setControlValue(rationale, "The complete official record has no declaration.");
    act(() => container.querySelector<HTMLInputElement>('.completion-decision-confirm input[type="checkbox"]')?.click());
    await submitForm(container.querySelector<HTMLFormElement>(".completion-decision-form")!);

    expect(record).toHaveBeenCalledWith("product-exact-labels", expect.objectContaining({
      evidenceId: "source:source-record-current",
      sourceContentHash: "a".repeat(64),
      labelContentSha256: null,
    }));
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("The decision could not be recorded.");
    expect(rationale.value).toBe("The complete official record has no declaration.");
    expect(container.querySelector<HTMLInputElement>('input[value="source:source-record-current"]')?.checked).toBe(true);
    expect(container.querySelector<HTMLInputElement>('.completion-decision-confirm input[type="checkbox"]')?.checked).toBe(true);
    expect(container.querySelector('.completion-desktop button[aria-label^="Record exact nutrition"]')).not.toBeNull();
  });

  it("refreshes and removes a successfully completed terminal row, then moves focus to status", async () => {
    const options = terminalOptions({ history: [], contradiction: { hasConflict: false, outcomes: [], factStatus: null, legacyProjection: false } });
    vi.spyOn(api, "terminalEvidence").mockResolvedValue(options);
    vi.spyOn(api, "recordTerminalEvidence").mockResolvedValue({
      status: "created",
      decision: terminalOptions().history[0]!.decision,
    });
    const onRefresh = vi.fn();
    const { container } = renderInteractive(createElement(TerminalWorklistHarness, { onRefresh }));
    act(() => container.querySelector<HTMLButtonElement>('.completion-desktop button[aria-label^="Record exact nutrition"]')?.click());
    await flushEffects();
    act(() => container.querySelector<HTMLInputElement>('input[value="source:source-record-current"]')?.click());
    setControlValue(container.querySelector<HTMLTextAreaElement>(".completion-decision-form textarea")!, "The complete official record has no declaration.");
    act(() => container.querySelector<HTMLInputElement>('.completion-decision-confirm input[type="checkbox"]')?.click());
    await submitForm(container.querySelector<HTMLFormElement>(".completion-decision-form")!);
    await flushEffects();

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('.completion-desktop button[aria-label^="Record exact nutrition"]')).toBeNull();
    const status = container.querySelector<HTMLElement>('[role="status"].completion-commit-notice');
    expect(status?.textContent).toContain("Nutrition evidence decision saved");
    expect(document.activeElement).toBe(status);
  });

  it("hides terminal mutation controls remotely and keeps mobile modal controls at the responsive target size", async () => {
    const readOnly = renderToStaticMarkup(createElement(CompletionPrimaryAction, {
      item: item("source_evidence_needed"),
      onOpenProduct: () => undefined,
      onOpenReview: () => undefined,
      onRecordEvidence: () => undefined,
      readOnly: true,
    }));
    expect(readOnly).not.toContain("Record unavailable");
    expect(readOnly).toContain("Find authoritative source");
    const styles = await readFile("src/styles.css", "utf8");
    expect(styles).toContain(".completion-decision-dialog .drawer-close { flex: 0 0 44px; width: 44px; height: 44px; }");
    expect(styles).toContain(".completion-evidence-option { grid-template-columns: 1fr; }");
    expect(styles).toContain(".completion-decision-history li { grid-template-columns: 1fr; gap: 5px; }");
  });

  it("posts optimistic exact hashes and no arbitrary evidence URL for terminal decisions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      status: "created",
      decision: { id: "ted_test" },
    }), { status: 201 }));
    await api.recordTerminalEvidence("product-exact-labels", {
      family: "nutrition",
      outcome: "not_declared",
      evidenceId: "label:asset-one",
      sourceContentHash: "a".repeat(64),
      labelContentSha256: "b".repeat(64),
      idempotencyKey: "terminal:request:test-one",
      rationale: "The complete current panel contains no nutrition declaration",
      supersedesDecisionId: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/products/product-exact-labels/terminal-evidence", expect.objectContaining({ method: "POST" }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      evidenceId: "label:asset-one",
      sourceContentHash: "a".repeat(64),
      labelContentSha256: "b".repeat(64),
    });
    expect(body).not.toHaveProperty("evidenceUrl");
  });

  it("preserves structured stale-evidence errors for the operator form", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: "stale_evidence",
        message: "Evidence changed after selection",
        details: { evidenceId: "label:asset-one" },
      },
    }), { status: 409, headers: { "content-type": "application/json" } }));
    const request = api.recordTerminalEvidence("product-exact-labels", {
      family: "nutrition",
      outcome: "not_declared",
      evidenceId: "label:asset-one",
      sourceContentHash: "a".repeat(64),
      labelContentSha256: "b".repeat(64),
      idempotencyKey: "terminal:request:stale",
      rationale: "Exact evidence inspected",
      supersedesDecisionId: null,
    });
    await expect(request).rejects.toMatchObject({
      name: "TerminalEvidenceRequestError",
      status: 409,
      code: "stale_evidence",
      details: { evidenceId: "label:asset-one" },
    });
  });
});
