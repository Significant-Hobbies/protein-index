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

## Product

- [Catalog UI](${ORIGIN}/): Human browse / compare experience (SPA)
- [This index](${ORIGIN}/llms.txt): Agent entrypoint
- [Agent catalog](${ORIGIN}/api/ai): Machine-readable surface list
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
    markdown: { suffix: ".md", negotiation: true },
    surfaces: [
      {
        id: "home",
        url: `${origin}/`,
        md: `${origin}/index.md`,
        kind: "spa",
        description: "Human SPA shell — use markdown/API instead",
      },
      {
        id: "llms",
        url: `${origin}/llms.txt`,
        md: null,
        kind: "static",
        description: "Agent index",
      },
      {
        id: "health",
        url: `${origin}/api/health`,
        md: null,
        kind: "api",
      },
      {
        id: "coverage",
        url: `${origin}/api/coverage`,
        md: null,
        kind: "api",
      },
      {
        id: "products_search",
        url: `${origin}/api/products`,
        md: null,
        kind: "api",
        description: "Search/list products as JSON",
      },
      {
        id: "product_detail",
        url: `${origin}/api/products/:id`,
        md: `${origin}/api/products/:id.md`,
        kind: "dynamic",
        description: "Single product JSON or markdown",
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
  <url><loc>${ORIGIN}/api/ai</loc></url>
  <url><loc>${ORIGIN}/api/health</loc></url>
  <url><loc>${ORIGIN}/api/coverage</loc></url>
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
