import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyProtein } from "../shared/classification";
import { normalizeGtin } from "../shared/gtin";
import { parseAdditives, parseAllergens, parseIngredients } from "../shared/ingredients";
import { calculateCompleteness } from "../shared/metrics";
import { validateNutrition } from "../shared/nutrition";
import type {
  EvidenceStatus,
  NutritionPer100g,
  ProductCategory,
  SourceManifest,
  StagedProduct,
} from "../shared/types";

interface FixtureRecord {
  sourceRecordId: string;
  gtin: string;
  brand: string;
  name: string;
  flavour: string;
  category: ProductCategory;
  netQuantityGrams: number;
  servingSizeGrams: number;
  nutritionStatus: EvidenceStatus;
  nutrition: NutritionPer100g;
  ingredientsRaw: string;
  contains: string;
  traces: string;
  sellingPrice: number;
  mrp: number;
  rating: { stars: number; ratingCount: number; reviewCount: number };
}

function isFixtureRecord(value: unknown): value is FixtureRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sourceRecordId === "string" &&
    typeof candidate.gtin === "string" &&
    typeof candidate.brand === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.category === "string" &&
    typeof candidate.nutrition === "object" &&
    candidate.nutrition !== null
  );
}

export async function buildFixtureStage(outputDirectory: string): Promise<{
  stagedPath: string;
  manifestPath: string;
  reportPath: string;
}> {
  const sourcePath = "data/fixtures/label-verified-products.json";
  const raw = await readFile(sourcePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isFixtureRecord)) throw new Error("Fixture catalog is malformed.");
  await mkdir(outputDirectory, { recursive: true });
  const observedAt = "2026-07-15T00:00:00.000Z";
  const staged: StagedProduct[] = parsed.map((fixture) => {
    const gtin = normalizeGtin(fixture.gtin);
    if (!gtin) throw new Error(`Fixture has invalid GTIN: ${fixture.gtin}`);
    const nutrition = {
      per100g: fixture.nutrition,
      servingSizeGrams: fixture.servingSizeGrams,
      basis: "per_100g" as const,
      preparationState: "as_sold" as const,
      status: fixture.nutritionStatus,
      confidence: "high" as const,
      source: "label_fixture",
      observedAt,
      labelVerifiedAt: fixture.nutritionStatus === "verified" ? observedAt : null,
    };
    const classification = classifyProtein({ name: fixture.name, categories: fixture.category, labels: "", nutrition });
    const ingredients = {
      raw: fixture.ingredientsRaw,
      language: "en",
      normalized: parseIngredients(fixture.ingredientsRaw),
      allergens: parseAllergens({ contains: fixture.contains, traces: fixture.traces }),
      additives: parseAdditives(fixture.ingredientsRaw),
      status: fixture.nutritionStatus === "conflict" ? "conflict" as const : "verified" as const,
      confidence: "high" as const,
      source: "label_fixture",
      observedAt,
    };
    const completeness = calculateCompleteness({
      gtin,
      brand: fixture.brand,
      name: fixture.name,
      netQuantityGrams: fixture.netQuantityGrams,
      nutrition,
      ingredients,
      evidence: sourcePath,
      offer: fixture.sellingPrice,
    });
    const rawEvidence = { ...fixture, fixtureOnly: true };
    return {
      source: "label_fixture",
      sourceKind: "fixture",
      sourceAuthority: { identity: 100, nutrition: 100, ingredients: 100 },
      sourceLicenseUrl: null,
      sourceRetentionNotes: "Synthetic local fixture data; never represent as a real retail product.",
      sourceRecordId: fixture.sourceRecordId,
      sourceUrl: null,
      observedAt,
      contentHash: createHash("sha256").update(JSON.stringify(rawEvidence)).digest("hex"),
      gtinRaw: fixture.gtin,
      gtin,
      brand: fixture.brand,
      name: fixture.name,
      flavour: fixture.flavour,
      category: fixture.category,
      categoryRaw: fixture.category,
      productKind: "retail_packaged",
      netQuantityGrams: fixture.netQuantityGrams,
      servingSizeGrams: fixture.servingSizeGrams,
      imageUrl: null,
      nutritionImageUrl: null,
      ingredientImageUrl: null,
      offers: [{
        retailer: "fixture_retailer",
        retailerListingId: fixture.sourceRecordId,
        pincode: "560001",
        seller: "Fixture Seller",
        mrp: fixture.mrp,
        sellingPrice: fixture.sellingPrice,
        available: true,
        url: "https://example.invalid/fixture-only",
        observedAt,
      }],
      ratings: [{
        retailer: "fixture_retailer",
        retailerListingId: fixture.sourceRecordId,
        stars: fixture.rating.stars,
        ratingCount: fixture.rating.ratingCount,
        reviewCount: fixture.rating.reviewCount,
        observedAt,
      }],
      nutrition,
      nutrients: Object.entries(fixture.nutrition)
        .filter((entry): entry is [string, number] => entry[1] !== null)
        .map(([code, quantity]) => ({ code, quantity, unit: code === "calories" ? "kcal" as const : "g" as const, basis: "per_100g" as const, preparationState: "as_sold" as const })),
      ingredients,
      classification,
      completeness: completeness.score,
      completenessMissing: completeness.missing,
      rawEvidence,
      validationIssues: validateNutrition(fixture.nutrition),
    };
  });
  const stagedPath = join(outputDirectory, "staged-products.jsonl");
  const manifestPath = join(outputDirectory, "manifest.json");
  const reportPath = join(outputDirectory, "report.json");
  const startedAt = "2026-07-15T00:00:00.000Z";
  const manifest: SourceManifest = {
    schemaVersion: 1,
    source: "label_fixture",
    sourceKind: "fixture",
    sourceAuthority: { identity: 100, nutrition: 100, ingredients: 100 },
    sourceLicenseUrl: null,
    sourceRetentionNotes: "Synthetic local fixture data; never represent as a real retail product.",
    adapterVersion: "fixture-v1",
    input: sourcePath,
    inputHash: createHash("sha256").update(raw).digest("hex"),
    inputBytes: Buffer.byteLength(raw),
    sourceUpdatedAt: null,
    startedAt,
    completedAt: startedAt,
    mode: "sample",
    terminalEvidence: "end_of_file",
    sourceComplete: true,
    marketComplete: false,
    advertisedTotal: staged.length,
    recordsRead: staged.length,
    indiaRecords: staged.length,
    stagedRecords: staged.length,
    invalidRecords: 0,
    duplicateRecords: 0,
    newRecords: staged.length,
    changedRecords: 0,
    unchangedRecords: 0,
    missingSinceRecords: 0,
    knownExclusions: ["Fixture-only proof data; not market coverage"],
    disconnectedSources: ["open_food_facts", "gs1_india_datakart", "retailer_offer_feeds"],
  };
  await writeFile(stagedPath, `${staged.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(reportPath, `${JSON.stringify({ fixtureOnly: true, products: staged.length }, null, 2)}\n`, "utf8");
  return { stagedPath, manifestPath, reportPath };
}
