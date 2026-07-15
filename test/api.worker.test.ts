import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { CatalogResponse, CoverageResponse, ProductDetailResponse, ReviewResponse } from "../shared/api";

const worker = exports.default;

async function json<T>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json() as Promise<T>;
}

describe("Worker catalog API", () => {
  it("reports seeded health and configured-source coverage", async () => {
    const healthResponse = await worker.fetch("http://localhost/api/health");
    expect(healthResponse.status).toBe(200);
    expect(await json<{ status: string; products: number }>(healthResponse)).toMatchObject({ status: "ok", products: 5 });

    const coverageResponse = await worker.fetch("http://localhost/api/coverage");
    expect(coverageResponse.status).toBe(200);
    const coverage = await json<CoverageResponse>(coverageResponse);
    expect(coverage.claim).toBe("configured_sources_only");
    expect(coverage.catalog).toMatchObject({ products: 5, validGtin: 5 });
    expect(coverage.sources[0]).toMatchObject({ id: "label_fixture", sourceComplete: true, marketComplete: false });
    expect(coverage.disconnectedSources).toContain("gs1_india_datakart");
  });

  it("uses trusted protein defaults and returns evidence-rich detail", async () => {
    const catalogResponse = await worker.fetch("http://localhost/api/products");
    expect(catalogResponse.status).toBe(200);
    const catalog = await json<CatalogResponse>(catalogResponse);
    expect(catalog.trustedDefault).toBe(true);
    expect(catalog.products.length).toBeGreaterThan(0);
    expect(catalog.products.every((product) => product.nutritionStatus === "verified")).toBe(true);
    const first = catalog.products[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("Expected a catalog product");

    const detailResponse = await worker.fetch(`http://localhost/api/products/${first.id}`);
    expect(detailResponse.status).toBe(200);
    const detail = await json<ProductDetailResponse>(detailResponse);
    expect(detail.id).toBe(first.id);
    expect(detail.sourceRecords[0]?.source).toBe("label_fixture");
    expect(detail.ingredientStatement).toBeTruthy();
    expect(detail.ingredients.length).toBeGreaterThan(0);
    expect(detail.nutrients.length).toBeGreaterThan(0);
    expect(detail.offers[0]?.retailer).toBe("fixture_retailer");
    expect(detail.ratings[0]?.ratingCount).toBeGreaterThan(0);
    expect(detail.provenance.some((observation) => observation.field.startsWith("nutrition."))).toBe(true);
  });

  it("validates bounded search and missing records", async () => {
    const invalid = await worker.fetch("http://localhost/api/products?pageSize=101");
    expect(invalid.status).toBe(400);
    expect(await json<{ error: { code: string } }>(invalid)).toMatchObject({ error: { code: "validation_error" } });

    const missing = await worker.fetch("http://localhost/api/products/not-a-product");
    expect(missing.status).toBe(404);
    expect(await json<{ error: { code: string } }>(missing)).toMatchObject({ error: { code: "not_found" } });
  });

  it("resolves a local review once and preserves conflict semantics", async () => {
    const listResponse = await worker.fetch("http://localhost/api/reviews?status=open");
    expect(listResponse.status).toBe(200);
    const reviews = await json<ReviewResponse>(listResponse);
    const review = reviews.items[0];
    expect(review).toBeDefined();
    if (!review) throw new Error("Expected an open review fixture");

    const unsupportedVerification = await worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "No evidence supplied" }),
    });
    expect(unsupportedVerification.status).toBe(400);
    expect(await json<{ error: { code: string } }>(unsupportedVerification)).toMatchObject({ error: { code: "validation_error" } });

    const resolve = () => worker.fetch(`http://localhost/api/reviews/${review.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "verify_nutrition", rationale: "Synthetic integration-test decision", evidenceUrl: "https://example.invalid/label-proof" }),
    });
    const resolved = await resolve();
    expect(resolved.status).toBe(200);
    expect(await json<{ status: string }>(resolved)).toMatchObject({ status: "resolved" });

    const conflict = await resolve();
    expect(conflict.status).toBe(409);
    expect(await json<{ error: { code: string } }>(conflict)).toMatchObject({ error: { code: "conflict" } });

    const resolvedList = await worker.fetch("http://localhost/api/reviews?status=resolved");
    const resolvedReviews = await json<ReviewResponse>(resolvedList);
    expect(resolvedReviews.items[0]).toMatchObject({
      id: review.id,
      decision: "verify_nutrition",
      decisionEvidenceUrl: "https://example.invalid/label-proof",
      decidedBy: "local_operator",
    });
  });
});
