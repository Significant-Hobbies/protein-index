import type {
  CatalogResponse,
  CoverageResponse,
  HealthResponse,
  ProductDetailResponse,
  ReviewResponse,
} from "../shared/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? ((body as { error?: { message?: string } }).error?.message ?? `Request failed (${response.status})`)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  health: () => request<HealthResponse>("/api/health"),
  catalog: (params: URLSearchParams, signal?: AbortSignal) =>
    request<CatalogResponse>(`/api/products?${params}`, { signal }),
  product: (id: string, signal?: AbortSignal) =>
    request<ProductDetailResponse>(`/api/products/${encodeURIComponent(id)}`, { signal }),
  reviews: (params = new URLSearchParams({ status: "open", type: "all", page: "1", pageSize: "50" }), signal?: AbortSignal) =>
    request<ReviewResponse>(`/api/reviews?${params}`, { signal }),
  coverage: () => request<CoverageResponse>("/api/coverage"),
  resolveReview: (id: string, decision: string, rationale: string, evidenceUrl: string | null, candidateProductId: string | null, reviewedText: string | null) =>
    request<{ status: string }>(`/api/reviews/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify({ decision, rationale, evidenceUrl, candidateProductId, reviewedText }),
    }),
};
