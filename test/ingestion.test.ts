import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stageOpenFoodFacts } from "../scripts/adapters/open-food-facts";

const indiaProduct = {
  code: "8900000000012",
  product_name: "Test Soya Chunks",
  brands: "Test Brand",
  countries_tags: ["en:india"],
  quantity: "500 g",
  serving_size: "50 g",
  categories_tags: ["en:soy-products"],
  ingredients_text: "Defatted soy flour 100%",
  allergens_tags: ["en:soybeans"],
  nutriments: {
    "energy-kcal_100g": 345,
    proteins_100g: 52,
    carbohydrates_100g: 33,
    sugars_100g: 7,
    fat_100g: 1,
    "saturated-fat_100g": 0.2,
    fiber_100g: 13,
    sodium_100g: 0.025,
    calcium_100g: 0.35,
  },
  last_modified_t: 1_752_537_600,
};

describe("Open Food Facts bulk staging", () => {
  it("streams all India-tagged foods without protein prefiltering", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-ingest-"));
    const input = join(directory, "sample.jsonl");
    await writeFile(
      input,
      [
        JSON.stringify(indiaProduct),
        JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats", categories_tags: ["en:oats"] }),
        JSON.stringify({ ...indiaProduct, code: "8900000000036", countries_tags: ["en:united-states"] }),
      ].join("\n"),
      "utf8",
    );
    const result = await stageOpenFoodFacts({ input, outputDirectory: join(directory, "out"), mode: "sample", limit: null });
    expect(result.manifest).toMatchObject({ recordsRead: 3, indiaRecords: 2, stagedRecords: 2, sourceComplete: true, marketComplete: false });
    const staged = (await readFile(result.stagedPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { name: string; nutrition: { status: string }; nutrients: Array<{ code: string }> });
    expect(staged.map(({ name }) => name)).toEqual(["Test Soya Chunks", "Ordinary Oats"]);
    expect(staged[0]?.nutrition.status).toBe("unverified");
    expect(staged[0]?.nutrients.some(({ code }) => code === "calcium")).toBe(true);
  });

  it("fails closed for capped production traversal", async () => {
    await expect(stageOpenFoodFacts({ input: "unused", outputDirectory: "unused", mode: "production", limit: 10 })).rejects.toThrow(
      "Production source traversal cannot use a record limit",
    );
  });

  it("fails closed on an empty India snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-empty-"));
    const input = join(directory, "sample.jsonl");
    await writeFile(input, `${JSON.stringify({ ...indiaProduct, countries_tags: ["en:france"] })}\n`, "utf8");
    await expect(stageOpenFoodFacts({ input, outputDirectory: join(directory, "out"), mode: "sample", limit: null })).rejects.toThrow(
      "zero India-tagged staged records",
    );
  });

  it("compares a complete production snapshot with the prior source index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-continuity-"));
    const firstInput = join(directory, "first.jsonl");
    const secondInput = join(directory, "second.jsonl");
    await writeFile(firstInput, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
    ].join("\n"), "utf8");
    const first = await stageOpenFoodFacts({
      input: firstInput,
      outputDirectory: join(directory, "first"),
      mode: "production",
      limit: null,
      sourceUpdatedAt: "2026-07-14T00:00:00Z",
    });
    await writeFile(secondInput, [
      JSON.stringify({ ...indiaProduct, ingredients_text: "Defatted soy flour (100%)" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000043", product_name: "Plain Curd" }),
    ].join("\n"), "utf8");
    const second = await stageOpenFoodFacts({
      input: secondInput,
      outputDirectory: join(directory, "second"),
      mode: "production",
      limit: null,
      previousManifestPath: first.manifestPath,
      previousIndexPath: first.indexPath,
    });
    expect(second.manifest).toMatchObject({
      sourceComplete: true,
      newRecords: 1,
      changedRecords: 1,
      unchangedRecords: 1,
      missingSinceRecords: 0,
    });
    expect(second.manifest.sourceUpdatedAt).toBeNull();
  });

  it("fails closed when a production snapshot materially shrinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-drop-"));
    const firstInput = join(directory, "first.jsonl");
    const secondInput = join(directory, "second.jsonl");
    await writeFile(firstInput, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
      JSON.stringify({ ...indiaProduct, code: "8900000000043", product_name: "Plain Curd" }),
    ].join("\n"), "utf8");
    const first = await stageOpenFoodFacts({
      input: firstInput,
      outputDirectory: join(directory, "first"),
      mode: "production",
      limit: null,
    });
    await writeFile(secondInput, [
      JSON.stringify(indiaProduct),
      JSON.stringify({ ...indiaProduct, code: "8900000000029", product_name: "Ordinary Oats" }),
    ].join("\n"), "utf8");
    await expect(stageOpenFoodFacts({
      input: secondInput,
      outputDirectory: join(directory, "second"),
      mode: "production",
      limit: null,
      previousManifestPath: first.manifestPath,
      previousIndexPath: first.indexPath,
      maximumDropRatio: 0.2,
    })).rejects.toThrow("Source continuity failure");
  });
});
