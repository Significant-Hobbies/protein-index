/**
 * Agent / LLM indexing surfaces (fleet GEO standard).
 * Spec: fleet-ops/docs/agent-indexing-standard.md
 *
 * Mode D: SPA + API — honest catalog + API resource markdown.
 * These routes must run via run_worker_first so SPA fallback never
 * returns HTML shells for /llms.txt or /api/ai.
 */

const ORIGIN = "https://protein.significanthobbies.com";

export const LLMS_TXT = `# Protein Index

> Source-aware catalog of Indian food products. Separates verified label
> evidence from broader discovery data. Does not claim complete coverage of
> the Indian market.

The human UI is a React SPA. Agents should use the API and markdown surfaces
below — do not scrape the empty client shell.

## When to use this

- Looking up Indian food products by GTIN, brand, or protein content with source-aware evidence
- Comparing protein foods with verified label evidence separated from discovery-only data
- Querying product nutrition, ingredients, offers, and ratings with explicit confidence levels
- Checking catalog coverage and evidence completion status for the Indian protein product market
- Accessing product detail as JSON or markdown for agent consumption

## Product

- [Catalog UI](${ORIGIN}/): Human browse / compare experience (SPA)
- [This index](${ORIGIN}/llms.txt): Agent entrypoint
- [Agent catalog](${ORIGIN}/api/ai): Machine-readable surface list
- [OpenAPI spec](${ORIGIN}/openapi.json): Machine-readable API contract
- [Homepage markdown](${ORIGIN}/index.md): Product brief without JS

## API (JSON)

- [Health](${ORIGIN}/api/health): Product count and publication status
- [Coverage](${ORIGIN}/api/coverage): Completion / evidence coverage
- [Search products](${ORIGIN}/api/products): Query catalog (\`q\`, filters)
- [Product detail](${ORIGIN}/api/products/:id): One canonical product
- [Product markdown](${ORIGIN}/api/products/:id.md): Same product as markdown

## Optional

- [Foundry](https://sassmaker.com): Parent fleet showcase
- [GitHub](https://github.com/Significant-Hobbies/protein-index): Source
`;

export const INDEX_MD = `# Protein Index

Source-aware catalog of Indian food products for comparing protein foods with
**verified label evidence** separated from broader discovery data.

## What it is

- Canonical products with GTIN-oriented identity
- Source-aware nutrition, offers, ratings, and confidence
- Operator review queues for entity resolution and nutrition conflicts
- Explicit about incomplete market coverage

## Who it's for

- Indian shoppers comparing protein foods
- Operators reviewing or correcting product evidence

## Not claims

- Not a complete Indian-market census
- Not medical advice
- Does not invent missing nutrition

## Agent entrypoints

| Surface | URL |
| --- | --- |
| LLM index | ${ORIGIN}/llms.txt |
| Agent catalog | ${ORIGIN}/api/ai |
| Health | ${ORIGIN}/api/health |
| Search | ${ORIGIN}/api/products |
| Product MD | ${ORIGIN}/api/products/:id.md |

Prefer JSON APIs or product markdown over the SPA HTML shell.
`;

export function buildApiAiCatalog(origin = ORIGIN) {
  return {
    name: "Protein Index",
    version: "1",
    url: origin,
    llms: `${origin}/llms.txt`,
    llmsFull: null,
    sitemap: `${origin}/sitemap.xml`,
    openapi: `${origin}/openapi.json`,
    markdown: { suffix: ".md", negotiation: true },
    surfaces: [
      {
        id: "home",
        url: `${origin}/`,
        md: `${origin}/index.md`,
        kind: "spa",
        description: "Human SPA shell — use markdown/API instead",
      },
    ],
    dataResources: [
      {
        id: "agent_catalog",
        url: `${origin}/api/ai`,
        kind: "json",
        description: "Inventory of public agent and data surfaces",
      },
      {
        id: "health",
        url: `${origin}/api/health`,
        kind: "json",
        description: "Catalog publication and runtime status",
      },
      {
        id: "coverage",
        url: `${origin}/api/coverage`,
        kind: "json",
        description: "Current source and evidence coverage ledger",
      },
      {
        id: "products_search",
        url: `${origin}/api/products`,
        kind: "json",
        description: "Search/list products as JSON",
      },
    ],
    auth: {
      public: true,
      notes:
        "Catalog read APIs are public. Review mutations are local/operator-only and denied in production.",
    },
  };
}

export const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${ORIGIN}/</loc></url>
  <url><loc>${ORIGIN}/index.md</loc></url>
  <url><loc>${ORIGIN}/llms.txt</loc></url>
</urlset>
`;

/**
 * Format a product detail record as agent-readable markdown.
 * Tolerates partial shapes from getProductDetail.
 */
export function productToMarkdown(product: Record<string, unknown>): string {
  const id = String(product.id ?? product.product_id ?? "");
  const name = String(product.name ?? product.product_name ?? "Product");
  const brand = product.brand ? String(product.brand) : null;
  const gtin = product.gtin ? String(product.gtin) : null;

  const lines = [
    `# ${name}`,
    "",
    brand ? `**Brand:** ${brand}` : null,
    gtin ? `**GTIN:** ${gtin}` : null,
    id ? `**ID:** ${id}` : null,
    "",
    `Canonical URL: ${ORIGIN}/ (SPA) · API: ${ORIGIN}/api/products/${id}`,
    "",
  ].filter((x) => x != null) as string[];

  const nutrition = product.nutrition ?? product.verified_nutrition;
  if (nutrition && typeof nutrition === "object") {
    lines.push("## Nutrition (as exposed by API)", "");
    lines.push("```json");
    lines.push(JSON.stringify(nutrition, null, 2));
    lines.push("```", "");
  }

  const protein = product.protein_g_per_100g ?? product.proteinDensity;
  if (protein != null) {
    lines.push(`**Protein density signal:** ${String(protein)}`, "");
  }

  lines.push(
    "## Evidence notes",
    "",
    "- Prefer verified label evidence fields over discovery-only sources.",
    "- Missing values mean not verified — do not invent numbers.",
    ""
  );

  return lines.join("\n");
}

export function buildOpenApiSpec(origin = ORIGIN) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Protein Index public API",
      version: "1.0.0",
      description:
        "Source-aware catalog of Indian food products. Separates verified label evidence from broader discovery data.",
      contact: { name: "Protein Index", url: origin },
    },
    servers: [{ url: origin }],
    tags: [{ name: "agent-surfaces", description: "Machine-readable public surfaces" }],
    paths: {
      "/api/ai": {
        get: {
          operationId: "getAgentCatalog",
          tags: ["agent-surfaces"],
          summary: "Agent catalog",
          responses: { "200": { description: "Agent catalog JSON", content: { "application/json": {} } } },
        },
      },
      "/llms.txt": {
        get: {
          operationId: "getLlmsTxt",
          tags: ["agent-surfaces"],
          summary: "llms.txt index",
          responses: { "200": { description: "Markdown index", content: { "text/plain": {} } } },
        },
      },
      "/sitemap.xml": {
        get: {
          operationId: "getSitemap",
          tags: ["agent-surfaces"],
          summary: "Sitemap",
          responses: { "200": { description: "XML sitemap", content: { "application/xml": {} } } },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApiSpec",
          tags: ["agent-surfaces"],
          summary: "OpenAPI specification",
          description: "This document.",
          responses: { "200": { description: "OpenAPI 3.1 spec", content: { "application/json": {} } } },
        },
      },
    },
  };
}
