import { Hono } from "hono";
import { getProductDetail, searchProducts, validateSearch } from "./catalog";
import { getCoverage } from "./coverage";
import { listReviews, resolveReview, type ReviewDecision } from "./reviews";

export const app = new Hono<{ Bindings: Env }>();

function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

app.get("/api/health", async (c) => {
  const [productResult, runResult] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT COUNT(*) AS products FROM products WHERE is_active = 1"),
    c.env.DB.prepare("SELECT completed_at, source_complete FROM ingestion_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 1"),
  ]);
  const products = productResult?.results[0] as { products?: number } | undefined;
  const run = runResult?.results[0] as { completed_at?: string | null; source_complete?: number | null } | undefined;
  const hostname = new URL(c.req.url).hostname;
  const runtime = ["localhost", "127.0.0.1", "::1"].includes(hostname) ? "local" : "production";
  return c.json({
    status: "ok",
    products: products?.products ?? 0,
    runtime,
    latestPublishedAt: run?.completed_at ?? null,
    sourceComplete: run?.source_complete === undefined || run.source_complete === null ? null : run.source_complete === 1,
    mutations: "local_only",
  });
});

app.get("/api/products", async (c) => {
  const parsed = validateSearch(new URL(c.req.url).searchParams);
  if (!parsed.value) return c.json(errorBody("validation_error", parsed.error ?? "Invalid query"), 400);
  return c.json(await searchProducts(c.env.DB, parsed.value));
});

app.get("/api/products/:id", async (c) => {
  const product = await getProductDetail(c.env.DB, c.req.param("id"));
  return product ? c.json(product) : c.json(errorBody("not_found", "Product not found"), 404);
});

app.get("/api/coverage", async (c) => c.json(await getCoverage(c.env.DB)));

app.get("/api/reviews", async (c) => {
  const status = c.req.query("status") ?? "open";
  const limit = Number(c.req.query("limit") ?? 50);
  if (!["open", "resolved", "dismissed"].includes(status) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    return c.json(errorBody("validation_error", "Invalid review filters"), 400);
  }
  return c.json(await listReviews(c.env.DB, status, limit));
});

app.post("/api/reviews/:id/resolve", async (c) => {
  const hostname = new URL(c.req.url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
    return c.json(errorBody("mutations_disabled", "Review mutations are local-only until operator authentication is configured"), 403);
  }
  const body: unknown = await c.req.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json(errorBody("validation_error", "Expected a JSON object"), 400);
  }
  const input = body as Record<string, unknown>;
  const decisions: ReviewDecision[] = [
    "verify_nutrition",
    "reject_nutrition",
    "verify_ingredients",
    "reject_ingredients",
    "dismiss",
    "match",
    "create_new",
    "no_match",
  ];
  if (typeof input.decision !== "string" || !decisions.includes(input.decision as ReviewDecision)) {
    return c.json(errorBody("validation_error", "Invalid review decision"), 400);
  }
  if (typeof input.rationale !== "string" || input.rationale.trim().length < 3 || input.rationale.length > 2_000) {
    return c.json(errorBody("validation_error", "A rationale between 3 and 2,000 characters is required"), 400);
  }
  let evidenceUrl: string | null = null;
  if (input.evidenceUrl !== undefined && input.evidenceUrl !== null && input.evidenceUrl !== "") {
    if (typeof input.evidenceUrl !== "string") return c.json(errorBody("validation_error", "Evidence URL must be a string"), 400);
    try {
      const parsed = new URL(input.evidenceUrl);
      if (parsed.protocol !== "https:") throw new Error("unsupported protocol");
      evidenceUrl = parsed.toString();
    } catch {
      return c.json(errorBody("validation_error", "Evidence URL must be a valid HTTPS URL"), 400);
    }
  }
  if (["verify_nutrition", "verify_ingredients"].includes(input.decision) && evidenceUrl === null) {
    return c.json(errorBody("validation_error", "Verification requires a current label or authoritative-source evidence URL"), 400);
  }
  const candidateProductId = input.candidateProductId === undefined || input.candidateProductId === null || input.candidateProductId === ""
    ? null
    : typeof input.candidateProductId === "string" ? input.candidateProductId : undefined;
  if (candidateProductId === undefined) return c.json(errorBody("validation_error", "Candidate product ID must be a string"), 400);
  const reviewedText = input.reviewedText === undefined || input.reviewedText === null
    ? null
    : typeof input.reviewedText === "string" ? input.reviewedText : undefined;
  if (reviewedText === undefined) return c.json(errorBody("validation_error", "Reviewed ingredient text must be a string"), 400);
  if (input.decision === "verify_ingredients" && !reviewedText?.trim()) {
    return c.json(errorBody("validation_error", "Ingredient verification requires reviewer-confirmed label text"), 400);
  }
  if (reviewedText !== null && reviewedText.length > 25_000) {
    return c.json(errorBody("validation_error", "Reviewed ingredient text must not exceed 25,000 characters"), 400);
  }
  if (input.decision !== "verify_ingredients" && reviewedText !== null) {
    return c.json(errorBody("validation_error", "Reviewed ingredient text is only valid for ingredient verification"), 400);
  }
  const result = await resolveReview(
    c.env.DB,
    c.req.param("id"),
    input.decision as ReviewDecision,
    input.rationale.trim(),
    evidenceUrl,
    candidateProductId,
    reviewedText,
  );
  if (result === "not_found") return c.json(errorBody("not_found", "Review item not found"), 404);
  if (result === "conflict") return c.json(errorBody("conflict", "Review item was already resolved"), 409);
  if (result === "invalid_decision") return c.json(errorBody("validation_error", "Decision is not valid for this review type"), 400);
  if (result === "invalid_candidate") return c.json(errorBody("validation_error", "Candidate is not valid for this review item"), 400);
  return c.json({ status: "resolved", id: c.req.param("id"), decision: input.decision });
});

app.notFound((c) => c.json(errorBody("not_found", "Route not found"), 404));

app.onError((error, c) => {
  console.error(JSON.stringify({ message: "request_failed", error: error.message, path: c.req.path }));
  return c.json(errorBody("internal_error", "The request could not be completed"), 500);
});

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
