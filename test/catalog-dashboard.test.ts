import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CatalogTable } from "../src/App";
import type { CatalogProduct, CatalogResponse } from "../shared/api";
import { calculateMetrics } from "../shared/metrics";

function product(input: { calories: number | null; proteinGrams: number | null }): CatalogProduct {
  const nutrition = {
    calories: input.calories,
    proteinGrams: input.proteinGrams,
    carbohydrateGrams: 20,
    sugarGrams: 4,
    fatGrams: 8,
    saturatedFatGrams: 3,
    fibreGrams: 6,
    sodiumMg: 250,
  };
  return {
    id: "prd_fixture",
    gtin: "08900000000012",
    imageUrl: null,
    nutritionImageUrl: "https://images.openfoodfacts.org/fixture.jpg",
    brand: "Atlas",
    name: "Protein Food",
    flavour: null,
    category: "protein_powder",
    netQuantityGrams: 500,
    servingSizeGrams: 50,
    marketedProtein: true,
    marketedReasons: ["protein"],
    nutritionallyProteinDense: true,
    nutritionReasons: ["protein_at_least_10g_per_100kcal"],
    nutritionStatus: "verified",
    nutritionEvidenceUrl: "https://images.openfoodfacts.org/fixture.jpg",
    nutritionEvidenceKind: "label",
    ingredientStatus: "verified",
    ingredientEvidenceUrl: "https://images.openfoodfacts.org/fixture-ingredients.jpg",
    ingredientEvidenceKind: "label",
    ingredientTerminalOutcome: null,
    completeness: 100,
    nutrition: {
      ...nutrition,
      basis: "per_100g",
      observedAt: "2026-07-17T00:00:00.000Z",
      labelVerifiedAt: "2026-07-17T00:00:00.000Z",
    },
    currentOffer: null,
    metrics: calculateMetrics({
      nutrition,
      nutritionBasis: "per_100g",
      netQuantityGrams: 500,
      servingSizeGrams: 50,
      sellingPrice: null,
    }),
  };
}

function renderCatalog(item: CatalogProduct): string {
  const data: CatalogResponse = {
    products: [item],
    pagination: { page: 1, pageSize: 25, total: 1, pages: 1 },
    trustedDefault: true,
    filters: {},
  };
  return renderToStaticMarkup(createElement(CatalogTable, {
    data,
    onOpen: () => undefined,
    onExplore: () => undefined,
    page: 1,
    onPage: () => undefined,
  }));
}

describe("catalog comparison surface", () => {
  it("shows energy, protein, and protein density in the default table and mobile card", () => {
    const markup = renderCatalog(product({ calories: 360, proteinGrams: 52 }));

    expect(markup).toContain("Protein / 100 kcal");
    expect(markup).toContain("Energy");
    expect(markup).toContain("52 g protein · 360 kcal · per 100 g");
    expect(markup.match(/360 kcal/g)).toHaveLength(2);
  });

  it("shows separate nutrition and ingredient evidence on mobile cards", () => {
    const markup = renderCatalog(product({ calories: 360, proteinGrams: 52 }));
    const mobile = markup.slice(markup.indexOf('class="catalog-mobile"'));

    expect(mobile).toContain("Nutrition");
    expect(mobile).toContain("Ingredients");
    expect(mobile.match(/status-verified/g)).toHaveLength(2);
  });

  it("shows terminal ingredient evidence instead of calling it missing", () => {
    const item = product({ calories: 360, proteinGrams: 52 });
    item.ingredientStatus = "missing";
    item.ingredientTerminalOutcome = "not_declared";
    const markup = renderCatalog(item);

    expect(markup).toContain("ingredients: not declared");
    expect(markup).toContain("not declared");
  });

  it("keeps absent energy explicit instead of synthesizing a value", () => {
    const markup = renderCatalog(product({ calories: null, proteinGrams: 52 }));

    expect(markup).toContain("Energy missing");
    expect(markup).not.toMatch(/>0 kcal</);
  });
});
