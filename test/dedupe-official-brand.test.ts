import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dedupeOfficialBrandSnapshot } from "../scripts/dedupe-official-brand";

describe("official brand snapshot deduplication", () => {
  it("preserves distinct variants and excludes only exact variant duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-brand-dedupe-"));
    const product = (sourceRecordId: string, flavour: string) => ({ source: "brand", sourceKind: "brand", sourceAuthority: { identity: 70, nutrition: 40, ingredients: 40 }, sourceLicenseUrl: null, sourceRetentionNotes: "", sourceRecordId, sourceUrl: `https://brand.example/${sourceRecordId}`, observedAt: "2026-07-18T00:00:00.000Z", contentHash: "a".repeat(64), gtinRaw: null, gtin: null, brand: "Acme", name: "Whey", flavour, category: "protein_powder", categoryRaw: null, productKind: "retail_packaged", netQuantityGrams: 1000, servingSizeGrams: null, imageUrl: null, nutritionImageUrl: null, ingredientImageUrl: null, offers: [], ratings: [], nutrition: { per100g: { calories: null, proteinGrams: null, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null }, servingSizeGrams: null, basis: "unknown", preparationState: "as_sold", status: "missing", confidence: "medium", source: "brand", observedAt: "2026-07-18T00:00:00.000Z", labelVerifiedAt: null }, nutrients: [], ingredients: { raw: null, language: null, normalized: [], allergens: [], additives: [], status: "missing", confidence: "medium", source: "brand", observedAt: "2026-07-18T00:00:00.000Z" }, classification: { marketed: true, marketedReasons: ["whey"], nutritionallyDense: null, nutritionReasons: [], version: "protein-v3" }, completeness: 0, completenessMissing: [], rawEvidence: {}, validationIssues: [] });
    const stagedPath = join(directory, "staged.jsonl"); const manifestPath = join(directory, "manifest.json");
    await writeFile(stagedPath, `${JSON.stringify(product("a", "Chocolate"))}\n${JSON.stringify(product("b", "Chocolate"))}\n${JSON.stringify(product("c", "Vanilla"))}\n`);
    await writeFile(manifestPath, JSON.stringify({ source: "brand", sourceKind: "brand", sourceComplete: true, terminalEvidence: "end_of_file", duplicateRecords: 0 }));
    const result = await dedupeOfficialBrandSnapshot({ stagedPath, manifestPath, outputDirectory: join(directory, "out") });
    expect(result).toMatchObject({ stagedRecords: 2, duplicateRecords: 1 });
    expect((await readFile(join(directory, "out", "staged-products.jsonl"), "utf8")).trim().split("\n")).toHaveLength(2);
  });
});
