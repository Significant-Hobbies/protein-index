import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { buildFixtureStage } from "./scripts/fixtures";
import { parseRobotoffNutritionEvidence } from "./scripts/adapters/robotoff";
import { emitImportSql } from "./scripts/reconcile";
import type { SourceManifest } from "./shared/types";

function sqlQueries(sql: string): string[] {
  return sql.split("\n")
    .map((statement) => statement.trim())
    .filter((statement) => statement && !["BEGIN IMMEDIATE;", "COMMIT;", "PRAGMA foreign_keys = ON;"].includes(statement));
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const outputDirectory = ".data/vitest-worker";
      const fixture = await buildFixtureStage(outputDirectory);
      const importSqlPath = join(outputDirectory, "import.sql");
      await emitImportSql({
        stagedPath: fixture.stagedPath,
        manifestPath: fixture.manifestPath,
        outputPath: importSqlPath,
      });
      const seedQueries = sqlQueries(await readFile(importSqlPath, "utf8"));
      const observedAt = "2026-07-15T10:00:00.000Z";
      const context = {
        code: "8900000000012",
        brand: "Test Brand",
        name: "Test Soya Chunks",
        flavour: null,
        category: "soy_product" as const,
        categoryRaw: "Soy products",
        netQuantityGrams: 500,
        servingSizeGrams: 50,
        imageUrl: null,
        nutritionImageUrl: "https://images.openfoodfacts.org/images/products/label.jpg",
      };
      const prediction = (id: number, imageId: string) => ({
        id,
        type: "nutrition_extraction",
        model_name: "nutrition_extractor",
        model_version: "nutrition_extractor-2.0",
        timestamp: "2026-07-15T10:00:00",
        image: { image_id: imageId, source_image: `/890/000/000/0012/${imageId}.jpg`, uploaded_at: "2026-07-15T09:00:00" },
        data: { nutrients: {
          "energy-kcal_100g": { value: "365", unit: "kcal", score: 0.98 },
          proteins_100g: { value: "25", unit: "g", score: 0.98 },
          carbohydrates_100g: { value: "46.5", unit: "g", score: 0.98 },
          fat_100g: { value: "8.9", unit: "g", score: 0.98 },
        } },
      });
      const robotoffProducts = [prediction(901, "901"), prediction(902, "902")]
        .flatMap((item) => parseRobotoffNutritionEvidence({ image_predictions: [item] }, context).staged);
      const robotoffStagedPath = join(outputDirectory, "robotoff-staged.jsonl");
      const robotoffManifestPath = join(outputDirectory, "robotoff-manifest.json");
      const robotoffSqlPath = join(outputDirectory, "robotoff-import.sql");
      const robotoffManifest: SourceManifest = {
        schemaVersion: 1,
        source: "open_food_facts_robotoff",
        sourceKind: "open_data",
        sourceAuthority: { identity: 0, nutrition: 20, ingredients: 0 },
        sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
        sourceRetentionNotes: "Synthetic replay candidate fixture",
        adapterVersion: "robotoff-replay-test",
        input: "synthetic-replay",
        inputHash: "b".repeat(64),
        inputBytes: 2,
        sourceUpdatedAt: null,
        startedAt: observedAt,
        completedAt: observedAt,
        mode: "sample",
        terminalEvidence: "end_of_file",
        sourceComplete: true,
        marketComplete: false,
        advertisedTotal: 2,
        recordsRead: 2,
        indiaRecords: 2,
        stagedRecords: 2,
        invalidRecords: 0,
        duplicateRecords: 0,
        newRecords: 2,
        changedRecords: 0,
        unchangedRecords: 0,
        missingSinceRecords: 0,
        knownExclusions: [],
        disconnectedSources: [],
      };
      await writeFile(robotoffStagedPath, `${robotoffProducts.map((product) => JSON.stringify(product)).join("\n")}\n`, "utf8");
      await writeFile(robotoffManifestPath, JSON.stringify(robotoffManifest), "utf8");
      await emitImportSql({ stagedPath: robotoffStagedPath, manifestPath: robotoffManifestPath, outputPath: robotoffSqlPath });
      const robotoffReplayQueries = sqlQueries(await readFile(robotoffSqlPath, "utf8"));
      const driftPrediction = prediction(901, "901");
      driftPrediction.data.nutrients["energy-kcal_100g"].value = "380";
      driftPrediction.data.nutrients.proteins_100g.value = "26";
      const driftProduct = parseRobotoffNutritionEvidence({ image_predictions: [driftPrediction] }, context).staged;
      const driftStagedPath = join(outputDirectory, "robotoff-drift-staged.jsonl");
      const driftManifestPath = join(outputDirectory, "robotoff-drift-manifest.json");
      const driftSqlPath = join(outputDirectory, "robotoff-drift-import.sql");
      await writeFile(driftStagedPath, `${driftProduct.map((product) => JSON.stringify(product)).join("\n")}\n`, "utf8");
      await writeFile(driftManifestPath, JSON.stringify({
        ...robotoffManifest,
        input: "synthetic-drift",
        inputHash: "c".repeat(64),
        inputBytes: 1,
        advertisedTotal: 1,
        recordsRead: 1,
        indiaRecords: 1,
        stagedRecords: 1,
        newRecords: 0,
        changedRecords: 1,
      } satisfies SourceManifest), "utf8");
      await emitImportSql({ stagedPath: driftStagedPath, manifestPath: driftManifestPath, outputPath: driftSqlPath });
      const robotoffDriftQueries = sqlQueries(await readFile(driftSqlPath, "utf8"));
      const migrations = await readD1Migrations("migrations");
      return {
        main: "./worker/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SEED_QUERIES: seedQueries,
            TEST_ROBOTOFF_REPLAY_QUERIES: robotoffReplayQueries,
            TEST_ROBOTOFF_DRIFT_QUERIES: robotoffDriftQueries,
          },
        },
      };
    }),
  ],
  test: {
    include: ["test/**/*.worker.test.ts"],
    setupFiles: ["./test/setup-worker.ts"],
  },
});
