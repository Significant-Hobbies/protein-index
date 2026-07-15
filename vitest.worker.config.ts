import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { buildFixtureStage } from "./scripts/fixtures";
import { parseRobotoffNutritionEvidence } from "./scripts/adapters/robotoff";
import { stageRobotoffIngredientCandidate, type StoredIngredientCandidate } from "./scripts/adapters/robotoff-ingredients-api";
import { parseRobotoffIngredientEvidence } from "./scripts/adapters/robotoff-ingredients";
import { emitImportSql } from "./scripts/reconcile";
import { emitReviewDecisionSql, writeReviewDecisionBundle } from "./scripts/review-bundles";
import { nutritionCandidateFromEvidence, nutritionCandidateHash } from "./shared/evidence-decisions";
import { ingredientCandidateFromEvidence, ingredientCandidateHash } from "./shared/ingredient-evidence";
import { parseIngredients } from "./shared/ingredients";
import type { SourceManifest, StagedProduct } from "./shared/types";

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
      const fixtureProducts = (await readFile(fixture.stagedPath, "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as StagedProduct);
      const ingredientBaseProduct = fixtureProducts.find(({ sourceRecordId }) => sourceRecordId === "fixture-label-8900000000012");
      if (!ingredientBaseProduct?.gtin) throw new Error("Expected ingredient replay base product");
      const ingredientCode = ingredientBaseProduct.gtin;
      const ingredientImageUrl = (id: number) => `https://images.openfoodfacts.org/images/products/890/000/000/0012/${id}.jpg`;
      const ingredientPrediction = (id: number, text: string) => ({
        id,
        type: "ner",
        model_name: "ingredient_detection",
        model_version: "ingredient-detection-1.0",
        timestamp: "2026-07-15T10:00:00",
        image: {
          barcode: ingredientCode,
          image_id: String(id),
          source_image: `/890/000/000/0012/${id}.jpg`,
          uploaded_at: "2026-07-15T09:00:00",
        },
        data: { entities: [{
          lang: { lang: "en", confidence: 0.99 },
          text,
          score: 0.99,
          ingredients: text.split(",").map((item) => ({ text: item.trim(), in_taxonomy: true })),
          bounding_box: [10, 20, 300, 900],
          ingredients_n: text.split(",").length,
          known_ingredients_n: text.split(",").length,
          unknown_ingredients_n: 0,
        }] },
      });
      const ingredientStage = async (id: number, text: string): Promise<StagedProduct> => {
        const predictionRecord = ingredientPrediction(id, text);
        const parsed = parseRobotoffIngredientEvidence(
          { image_predictions: [predictionRecord] },
          { code: ingredientCode, ingredientImageUrl: ingredientImageUrl(id) },
        );
        const candidate = parsed.candidates[0];
        if (!candidate) throw new Error("Expected ingredient replay candidate");
        const stored: StoredIngredientCandidate = {
          requestedCode: ingredientCode,
          ingredientImageUrl: ingredientImageUrl(id),
          candidateHash: await ingredientCandidateHash(candidate),
          candidate,
          issues: parsed.issues,
          hasConflict: parsed.hasConflict,
          prediction: predictionRecord,
        };
        return stageRobotoffIngredientCandidate({ ...ingredientBaseProduct, ingredientImageUrl: ingredientImageUrl(id) }, stored);
      };
      const ingredientProduct = await ingredientStage(1901, "Defatted soy flour 100%, salt");
      const ingredientDriftProduct = await ingredientStage(1901, "Defatted soy flour 98%, salt, spices");
      const ingredientManifest: SourceManifest = {
        ...robotoffManifest,
        source: "open_food_facts_robotoff_ingredients",
        sourceAuthority: { identity: 0, nutrition: 0, ingredients: 20 },
        adapterVersion: "robotoff-ingredients-replay-test",
        input: "synthetic-ingredient-replay",
        inputHash: "e".repeat(64),
        advertisedTotal: 1,
        recordsRead: 1,
        indiaRecords: 1,
        stagedRecords: 1,
        newRecords: 1,
      };
      const ingredientStagedPath = join(outputDirectory, "robotoff-ingredient-staged.jsonl");
      const ingredientManifestPath = join(outputDirectory, "robotoff-ingredient-manifest.json");
      const ingredientSqlPath = join(outputDirectory, "robotoff-ingredient-import.sql");
      await writeFile(ingredientStagedPath, `${JSON.stringify(ingredientProduct)}\n`, "utf8");
      await writeFile(ingredientManifestPath, JSON.stringify(ingredientManifest), "utf8");
      await emitImportSql({ stagedPath: ingredientStagedPath, manifestPath: ingredientManifestPath, outputPath: ingredientSqlPath });
      const ingredientReplayQueries = sqlQueries(await readFile(ingredientSqlPath, "utf8"));
      const ingredientDriftStagedPath = join(outputDirectory, "robotoff-ingredient-drift-staged.jsonl");
      const ingredientDriftManifestPath = join(outputDirectory, "robotoff-ingredient-drift-manifest.json");
      const ingredientDriftSqlPath = join(outputDirectory, "robotoff-ingredient-drift-import.sql");
      await writeFile(ingredientDriftStagedPath, `${JSON.stringify(ingredientDriftProduct)}\n`, "utf8");
      await writeFile(ingredientDriftManifestPath, JSON.stringify({
        ...ingredientManifest,
        input: "synthetic-ingredient-drift",
        inputHash: "f".repeat(64),
        newRecords: 0,
        changedRecords: 1,
      } satisfies SourceManifest), "utf8");
      await emitImportSql({
        stagedPath: ingredientDriftStagedPath,
        manifestPath: ingredientDriftManifestPath,
        outputPath: ingredientDriftSqlPath,
      });
      const ingredientDriftQueries = sqlQueries(await readFile(ingredientDriftSqlPath, "utf8"));
      const bundleProduct = parseRobotoffNutritionEvidence({ image_predictions: [prediction(903, "903")] }, context).staged[0];
      if (!bundleProduct) throw new Error("Expected synthetic bundle product");
      const bundleIssue = bundleProduct.validationIssues.find(({ code }) => code === "robotoff_nutrition_candidate");
      const bundleCandidate = nutritionCandidateFromEvidence(bundleIssue, bundleProduct.gtin);
      if (!bundleCandidate) throw new Error("Expected synthetic bundle candidate");
      const stableId = (prefix: string, value: string) => `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
      const bundleStagedPath = join(outputDirectory, "review-bundle-staged.jsonl");
      const bundleManifestPath = join(outputDirectory, "review-bundle-source-manifest.json");
      const bundleSourceSqlPath = join(outputDirectory, "review-bundle-source.sql");
      await writeFile(bundleStagedPath, `${JSON.stringify(bundleProduct)}\n`, "utf8");
      await writeFile(bundleManifestPath, JSON.stringify({
        ...robotoffManifest,
        input: "synthetic-review-bundle",
        inputHash: "d".repeat(64),
        inputBytes: 1,
        advertisedTotal: 1,
        recordsRead: 1,
        indiaRecords: 1,
        stagedRecords: 1,
        newRecords: 1,
      } satisfies SourceManifest), "utf8");
      await emitImportSql({ stagedPath: bundleStagedPath, manifestPath: bundleManifestPath, outputPath: bundleSourceSqlPath });
      const reviewBundleSourceQueries = sqlQueries(await readFile(bundleSourceSqlPath, "utf8"));
      const candidateHash = await nutritionCandidateHash(bundleCandidate);
      const sourceRecordId = stableId("src", `${bundleProduct.source}:${bundleProduct.sourceRecordId}`);
      const productId = stableId("prd", `gtin:${bundleProduct.gtin}`);
      const reviewBundle = await writeReviewDecisionBundle({
        outputRoot: join(outputDirectory, "review-decisions"),
        createdAt: observedAt,
        decisions: [{
          id: "evd_bundle_fixture",
          sourceId: bundleProduct.source,
          sourceRecordKey: bundleProduct.sourceRecordId,
          sourceRecordId,
          sourceContentHash: bundleProduct.contentHash,
          productId,
          candidateHash,
          fieldFamily: "nutrition",
          decision: "verify",
          payload: bundleCandidate,
          evidenceUrl: bundleCandidate.imageUrl,
          rationale: "Synthetic bundle review",
          decidedBy: "test_operator",
          decidedAt: observedAt,
        }],
      });
      const reviewBundleSqlPath = join(outputDirectory, "review-bundle-apply.sql");
      await emitReviewDecisionSql(reviewBundle, reviewBundleSqlPath, false);
      const reviewBundleApplyQueries = sqlQueries(await readFile(reviewBundleSqlPath, "utf8"));
      const ingredientBundleProduct = await ingredientStage(1904, "Defatted soy flour 100%, salt, spices");
      const ingredientBundleStagedPath = join(outputDirectory, "ingredient-review-bundle-staged.jsonl");
      const ingredientBundleManifestPath = join(outputDirectory, "ingredient-review-bundle-manifest.json");
      const ingredientBundleSourceSqlPath = join(outputDirectory, "ingredient-review-bundle-source.sql");
      await writeFile(ingredientBundleStagedPath, `${JSON.stringify(ingredientBundleProduct)}\n`, "utf8");
      await writeFile(ingredientBundleManifestPath, JSON.stringify({
        ...ingredientManifest,
        input: "synthetic-ingredient-review-bundle",
        inputHash: "1".repeat(64),
      } satisfies SourceManifest), "utf8");
      await emitImportSql({
        stagedPath: ingredientBundleStagedPath,
        manifestPath: ingredientBundleManifestPath,
        outputPath: ingredientBundleSourceSqlPath,
      });
      const ingredientBundleSourceQueries = sqlQueries(await readFile(ingredientBundleSourceSqlPath, "utf8"));
      const ingredientBundleIssue = ingredientBundleProduct.validationIssues
        .find(({ code }) => code === "robotoff_ingredient_candidate");
      const ingredientBundleCandidate = ingredientCandidateFromEvidence(ingredientBundleIssue, ingredientBundleProduct.gtin);
      if (!ingredientBundleCandidate) throw new Error("Expected synthetic ingredient bundle candidate");
      const ingredientReviewedText = ingredientBundleCandidate.entityText;
      const ingredientBundle = await writeReviewDecisionBundle({
        outputRoot: join(outputDirectory, "ingredient-review-decisions"),
        createdAt: observedAt,
        decisions: [{
          id: "evd_ingredient_bundle_fixture",
          sourceId: ingredientBundleProduct.source,
          sourceRecordKey: ingredientBundleProduct.sourceRecordId,
          sourceRecordId: stableId("src", `${ingredientBundleProduct.source}:${ingredientBundleProduct.sourceRecordId}`),
          sourceContentHash: ingredientBundleProduct.contentHash,
          productId: stableId("prd", `gtin:${ingredientBundleProduct.gtin}`),
          candidateHash: await ingredientCandidateHash(ingredientBundleCandidate),
          fieldFamily: "ingredients",
          decision: "verify",
          payload: {
            candidate: ingredientBundleCandidate,
            reviewedText: ingredientReviewedText,
            normalizedIngredients: parseIngredients(ingredientReviewedText),
          },
          evidenceUrl: ingredientBundleCandidate.imageUrl,
          rationale: "Synthetic ingredient bundle review against the current package label",
          decidedBy: "test_operator",
          decidedAt: observedAt,
        }],
      });
      const ingredientBundleApplySqlPath = join(outputDirectory, "ingredient-review-bundle-apply.sql");
      await emitReviewDecisionSql(ingredientBundle, ingredientBundleApplySqlPath, false);
      const ingredientBundleApplyQueries = sqlQueries(await readFile(ingredientBundleApplySqlPath, "utf8"));
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
            TEST_INGREDIENT_REPLAY_QUERIES: ingredientReplayQueries,
            TEST_INGREDIENT_DRIFT_QUERIES: ingredientDriftQueries,
            TEST_REVIEW_BUNDLE_SOURCE_QUERIES: reviewBundleSourceQueries,
            TEST_REVIEW_BUNDLE_APPLY_QUERIES: reviewBundleApplyQueries,
            TEST_INGREDIENT_BUNDLE_SOURCE_QUERIES: ingredientBundleSourceQueries,
            TEST_INGREDIENT_BUNDLE_APPLY_QUERIES: ingredientBundleApplyQueries,
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
