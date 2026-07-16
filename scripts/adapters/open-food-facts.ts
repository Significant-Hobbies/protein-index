import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { Transform, type TransformCallback } from "node:stream";
import { once } from "node:events";
import { createGunzip } from "node:zlib";
import { classifyProtein } from "../../shared/classification";
import { normalizeGtin, normalizeText, parseQuantity } from "../../shared/gtin";
import { invalidIngredientPercentages, parseAdditives, parseAllergens, parseIngredients } from "../../shared/ingredients";
import { calculateCompleteness } from "../../shared/metrics";
import { emptyNutrition, finiteNumber, hasNutritionErrors, validateNutrition } from "../../shared/nutrition";
import type {
  GenericNutrientValue,
  NutritionPer100g,
  ProductCategory,
  SourceManifest,
  StagedProduct,
  ValidationIssue,
} from "../../shared/types";

export const OPEN_FOOD_FACTS_ADAPTER_VERSION = "off-bulk-v2";
export const OPEN_FOOD_FACTS_EXPORT_URL =
  "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz";

export interface OpenFoodFactsStageOptions {
  input: string;
  outputDirectory: string;
  mode: "sample" | "production";
  limit: number | null;
  format?: "tsv" | "jsonl";
  previousIndexPath?: string;
  previousManifestPath?: string;
  sourceUpdatedAt?: string | null;
  maximumDropRatio?: number;
}

export interface StageResult {
  manifest: SourceManifest;
  stagedPath: string;
  manifestPath: string;
  reportPath: string;
  indexPath: string;
  exclusionsPath: string;
}

type RawRecord = Record<string, unknown>;

export interface OpenFoodFactsNormalizationSource {
  source: string;
  sourceAuthority: StagedProduct["sourceAuthority"];
  sourceRetentionNotes: string;
}

const BULK_SOURCE: OpenFoodFactsNormalizationSource = {
  source: "open_food_facts",
  sourceAuthority: { identity: 45, nutrition: 40, ingredients: 40 },
  sourceRetentionNotes: "Open Database License; preserve attribution and share-alike obligations.",
};

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function listValue(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  const text = stringValue(value);
  return text ? text.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function compactEvidence(record: RawRecord): RawRecord {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => {
      if (value === null || value === undefined || value === "") return false;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }),
  );
}

function nutritionContainer(record: RawRecord): RawRecord {
  return isRecord(record.nutriments) ? record.nutriments : record;
}

function nutrientValue(record: RawRecord, key: string): number | null {
  return finiteNumber(nutritionContainer(record)[key]);
}

function parseCoreNutrition(record: RawRecord): NutritionPer100g {
  const nutrition = emptyNutrition();
  nutrition.calories = nutrientValue(record, "energy-kcal_100g");
  nutrition.proteinGrams = nutrientValue(record, "proteins_100g");
  nutrition.carbohydrateGrams = nutrientValue(record, "carbohydrates_100g");
  nutrition.sugarGrams = nutrientValue(record, "sugars_100g");
  nutrition.fatGrams = nutrientValue(record, "fat_100g");
  nutrition.saturatedFatGrams = nutrientValue(record, "saturated-fat_100g");
  nutrition.fibreGrams = nutrientValue(record, "fiber_100g");
  const sodiumGrams = nutrientValue(record, "sodium_100g");
  nutrition.sodiumMg = sodiumGrams === null ? null : sodiumGrams * 1000;
  return nutrition;
}

function nutritionBasis(record: RawRecord): "per_100g" | "per_100ml" | "unknown" {
  const unit = normalizeText(stringValue(record.product_quantity_unit));
  const quantity = normalizeText(stringValue(record.quantity));
  const volumeUnit = /(?:^|[^a-z])(?:ml|cl|dl|l|litre|liter|litres|liters)(?:[^a-z]|$)/;
  if (volumeUnit.test(unit) || volumeUnit.test(quantity)) return "per_100ml";
  if (parseQuantity(stringValue(record.quantity))?.grams != null) return "per_100g";
  return "unknown";
}

function massQuantity(raw: unknown, numeric: unknown, rawUnit: unknown, unitlessNumericIsGrams = false): number | null {
  const parsed = parseQuantity(stringValue(raw));
  if (parsed) return parsed.grams;
  const value = finiteNumber(numeric);
  if (value === null || value <= 0) return null;
  const unit = normalizeText(stringValue(rawUnit));
  if (unit === "g" || unit === "gram" || unit === "grams") return value;
  if (unit === "kg" || unit === "kilogram" || unit === "kilograms") return value * 1000;
  return unitlessNumericIsGrams && !unit ? value : null;
}

function parseGenericNutrients(record: RawRecord, basis: "per_100g" | "per_100ml" | "unknown"): GenericNutrientValue[] {
  const values: GenericNutrientValue[] = [];
  for (const [key, rawValue] of Object.entries(nutritionContainer(record))) {
    if (!key.endsWith("_100g") || key.endsWith("_value_100g") || key.endsWith("_unit_100g")) continue;
    const quantity = finiteNumber(rawValue);
    if (quantity === null || quantity < 0) continue;
    const code = key.slice(0, -5);
    const unit: GenericNutrientValue["unit"] =
      code === "energy-kcal" ? "kcal" : code === "energy-kj" || code === "energy" ? "kj" : "g";
    values.push({ code, quantity, unit, basis, preparationState: "as_sold" });
  }
  return values;
}

function isIndiaRecord(record: RawRecord): boolean {
  const tags = listValue(record.countries_tags).map(normalizeText);
  const countries = normalizeText(`${stringValue(record.countries) ?? ""} ${stringValue(record.countries_en) ?? ""}`);
  return tags.some((tag) => tag === "en india" || tag === "india") || countries.split(" ").includes("india");
}

function observationTime(record: RawRecord): string {
  const datetime = stringValue(record.last_modified_datetime) ?? stringValue(record.last_updated_datetime);
  if (datetime) {
    const parsed = new Date(datetime);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString();
  }
  const epoch = finiteNumber(record.last_modified_t) ?? finiteNumber(record.last_updated_t);
  if (epoch !== null && epoch > 0) return new Date(epoch * 1000).toISOString();
  return new Date(0).toISOString();
}

function categoryFor(record: RawRecord): ProductCategory {
  const category = normalizeText(
    `${stringValue(record.categories) ?? ""} ${stringValue(record.categories_tags) ?? ""} ${stringValue(record.product_name) ?? ""}`,
  );
  if (/whey|casein|protein powder|protein supplement/.test(category)) return "protein_powder";
  if (/protein bar|energy bar/.test(category)) return "protein_bar";
  if (/protein chip|protein snack/.test(category)) return "protein_snack";
  if (/soy chunk|soya chunk|tofu|soy product/.test(category)) return "soy_product";
  if (/greek yogurt|yoghurt|paneer|cheese|dairy/.test(category)) return "dairy";
  if (/plant milk|plant based milk|vegan milk/.test(category)) return "plant_dairy";
  if (/protein shake|ready to drink|beverage/.test(category)) return "ready_to_drink";
  if (/cereal|oat|muesli|breakfast/.test(category)) return "breakfast";
  if (/peanut butter|nut butter|spread/.test(category)) return "spread";
  return "other";
}

function sourceUrl(record: RawRecord, code: string): string {
  return stringValue(record.url) ?? `https://world.openfoodfacts.org/product/${code}`;
}

export function normalizeOpenFoodFactsRecord(
  record: Record<string, unknown>,
  source: OpenFoodFactsNormalizationSource = BULK_SOURCE,
): { staged: StagedProduct | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const sourceRecordId = stringValue(record.code);
  const name = stringValue(record.product_name) ?? stringValue(record.generic_name);
  if (!sourceRecordId || !name) {
    issues.push({ code: "missing_identity", message: "Product code and name are required", severity: "error", field: "identity" });
    return { staged: null, issues };
  }

  const gtin = normalizeGtin(sourceRecordId);
  if (!gtin) {
    issues.push({ code: "invalid_gtin", message: "Product code is not a valid GTIN", severity: "error", field: "gtin" });
  }
  const nutritionPer100g = parseCoreNutrition(record);
  const nutritionIssues = validateNutrition(nutritionPer100g);
  issues.push(...nutritionIssues);
  const netQuantityGrams = massQuantity(record.quantity, record.product_quantity, record.product_quantity_unit);
  // Open Food Facts defines serving_quantity as a computed gram value when no
  // explicit unit is returned. An explicit volume in serving_size still wins
  // and deliberately produces no serving mass.
  const servingSizeGrams = massQuantity(record.serving_size, record.serving_quantity, record.serving_quantity_unit, true);
  if (netQuantityGrams !== null && servingSizeGrams !== null && servingSizeGrams > netQuantityGrams) {
    issues.push({ code: "serving_exceeds_pack", message: "Serving size exceeds net pack mass", severity: "error", field: "servingSizeGrams" });
  }

  const observedAt = observationTime(record);
  const basis = nutritionBasis(record);
  const ingredientRaw = stringValue(record.ingredients_text);
  const invalidPercentages = invalidIngredientPercentages(ingredientRaw);
  if (invalidPercentages.length > 0) {
    issues.push({
      code: "invalid_ingredient_percentage",
      message: `Ingredient percentage exceeds 100%: ${[...new Set(invalidPercentages)].join(", ")}`,
      severity: "warning",
      field: "ingredients",
    });
  }
  const evidence = compactEvidence(record);
  const contentHash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  const nutrition = {
    per100g: nutritionPer100g,
    servingSizeGrams,
    basis,
    preparationState: "as_sold" as const,
    status: nutritionPer100g.proteinGrams === null && nutritionPer100g.calories === null
      ? "missing" as const
      : hasNutritionErrors(nutritionIssues) ? "conflict" as const : "unverified" as const,
    confidence: "medium" as const,
    source: source.source,
    observedAt,
    labelVerifiedAt: null,
  };
  const classification = classifyProtein({
    name,
    categories: `${stringValue(record.categories) ?? ""} ${stringValue(record.categories_tags) ?? ""}`,
    labels: `${stringValue(record.labels) ?? ""} ${stringValue(record.labels_tags) ?? ""}`,
    nutrition,
  });
  const ingredients = {
    raw: ingredientRaw,
    language: stringValue(record.lang),
    normalized: parseIngredients(ingredientRaw),
    allergens: parseAllergens({
      contains: stringValue(record.allergens),
      traces: stringValue(record.traces),
      tags: listValue(record.allergens_tags),
    }),
    additives: parseAdditives(ingredientRaw, listValue(record.additives_tags)),
    status: ingredientRaw ? "unverified" as const : "missing" as const,
    confidence: "medium" as const,
    source: source.source,
    observedAt,
  };
  const completeness = calculateCompleteness({
    gtin,
    brand: stringValue(record.brands),
    name,
    netQuantityGrams,
    nutrition: nutrition.status === "missing" ? null : nutrition,
    ingredients: ingredientRaw,
    evidence: sourceUrl(record, sourceRecordId),
    offer: null,
  });

  return {
    issues,
    staged: {
      source: source.source,
      sourceKind: "open_data",
      sourceAuthority: source.sourceAuthority,
      sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
      sourceRetentionNotes: source.sourceRetentionNotes,
      sourceRecordId,
      sourceUrl: sourceUrl(record, sourceRecordId),
      observedAt,
      contentHash,
      gtinRaw: sourceRecordId,
      gtin,
      brand: stringValue(record.brands)?.split(",")[0]?.trim() || "Unknown brand",
      name,
      flavour: null,
      category: categoryFor(record),
      categoryRaw: stringValue(record.categories),
      productKind: "retail_packaged",
      netQuantityGrams,
      servingSizeGrams,
      imageUrl: stringValue(record.image_url),
      nutritionImageUrl: stringValue(record.image_nutrition_url),
      ingredientImageUrl: stringValue(record.image_ingredients_url),
      offers: [],
      ratings: [],
      nutrition,
      nutrients: parseGenericNutrients(record, basis),
      ingredients,
      classification,
      completeness: completeness.score,
      completenessMissing: completeness.missing,
      rawEvidence: evidence,
      validationIssues: issues,
    },
  };
}

function formatFor(input: string, explicit?: "tsv" | "jsonl"): "tsv" | "jsonl" {
  if (explicit) return explicit;
  const withoutGzip = extname(input).toLowerCase() === ".gz" ? input.slice(0, -3) : input;
  return /\.(?:csv|tsv)$/i.test(withoutGzip) ? "tsv" : "jsonl";
}

async function writeLine(stream: NodeJS.WritableStream, value: string): Promise<void> {
  if (!stream.write(`${value}\n`)) await once(stream, "drain");
}

interface SourceIndexRecord {
  sourceRecordId: string;
  contentHash: string;
}

interface ExcludedSourceRecord {
  sourceRow: number;
  sourceRecordId: string | null;
  productName: string | null;
  brand: string | null;
  reasonCodes: string[];
  evidenceHash: string;
}

function excludedSourceRecord(record: RawRecord, sourceRow: number, issues: ValidationIssue[]): ExcludedSourceRecord {
  return {
    sourceRow,
    sourceRecordId: stringValue(record.code),
    productName: stringValue(record.product_name) ?? stringValue(record.generic_name),
    brand: stringValue(record.brands),
    reasonCodes: issues.map((issue) => issue.code),
    evidenceHash: createHash("sha256").update(JSON.stringify(compactEvidence(record))).digest("hex"),
  };
}

async function readPreviousIndex(path?: string): Promise<Map<string, string> | null> {
  if (!path) return null;
  const index = new Map<string, string>();
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as Partial<SourceIndexRecord>;
    if (!parsed.sourceRecordId || !parsed.contentHash) throw new Error(`Invalid source index record in ${path}.`);
    index.set(parsed.sourceRecordId, parsed.contentHash);
  }
  return index;
}

function parseSourceUpdatedAt(value?: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) throw new Error("--source-updated-at must be a valid date.");
  return parsed.toISOString();
}

function assertContinuity(input: {
  current: SourceManifest;
  previous: SourceManifest | null;
  previousIndexSize: number | null;
  maximumDropRatio: number;
}): void {
  const { current, previous, previousIndexSize, maximumDropRatio } = input;
  if (current.mode !== "production") return;
  if (!current.sourceComplete || current.terminalEvidence !== "end_of_file") {
    throw new Error("Production source snapshot did not reach end-of-file.");
  }
  if (!previous) return;
  if (previous.source !== current.source || previous.mode !== "production" || !previous.sourceComplete) {
    throw new Error("Previous continuity manifest is not a complete production snapshot for this source.");
  }
  if (previousIndexSize === null || previousIndexSize !== previous.stagedRecords) {
    throw new Error("Previous source index is missing or does not match its manifest count.");
  }
  for (const field of ["recordsRead", "indiaRecords", "stagedRecords"] as const) {
    const previousCount = previous[field];
    if (previousCount === 0) continue;
    const dropRatio = (previousCount - current[field]) / previousCount;
    if (dropRatio > maximumDropRatio) {
      throw new Error(
        `Source continuity failure: ${field} dropped ${(dropRatio * 100).toFixed(1)}% ` +
        `from ${previousCount} to ${current[field]} (maximum ${(maximumDropRatio * 100).toFixed(1)}%).`,
      );
    }
  }
}

export async function stageOpenFoodFacts(options: OpenFoodFactsStageOptions): Promise<StageResult> {
  if (options.mode === "production" && options.limit !== null) {
    throw new Error("Production source traversal cannot use a record limit.");
  }
  await mkdir(options.outputDirectory, { recursive: true });
  const stagedPath = join(options.outputDirectory, "staged-products.jsonl");
  const manifestPath = join(options.outputDirectory, "manifest.json");
  const reportPath = join(options.outputDirectory, "report.json");
  const indexPath = join(options.outputDirectory, "source-index.jsonl");
  const exclusionsPath = join(options.outputDirectory, "exclusions.jsonl");
  const output = createWriteStream(stagedPath, { encoding: "utf8" });
  const indexOutput = createWriteStream(indexPath, { encoding: "utf8" });
  const exclusionsOutput = createWriteStream(exclusionsPath, { encoding: "utf8" });
  const previousIndex = await readPreviousIndex(options.previousIndexPath);
  const previousManifest = options.previousManifestPath
    ? JSON.parse(await readFile(options.previousManifestPath, "utf8")) as SourceManifest
    : null;
  if ((previousIndex === null) !== (previousManifest === null)) {
    throw new Error("Previous continuity input requires both --previous-manifest and --previous-index.");
  }
  const maximumDropRatio = options.maximumDropRatio ?? 0.2;
  if (!Number.isFinite(maximumDropRatio) || maximumDropRatio < 0 || maximumDropRatio >= 1) {
    throw new Error("Maximum drop ratio must be at least 0 and less than 1.");
  }
  const inputStats = await stat(options.input);
  const inputHash = createHash("sha256");
  const source = createReadStream(options.input);
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      inputHash.update(chunk);
      callback(null, chunk);
    },
  });
  source.pipe(hashingStream);
  const decoded = options.input.endsWith(".gz") ? hashingStream.pipe(createGunzip()) : hashingStream;
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  const startedAt = new Date().toISOString();
  const format = formatFor(options.input, options.format);
  let headers: string[] | null = null;
  let recordsRead = 0;
  let indiaRecords = 0;
  let stagedRecords = 0;
  let invalidRecords = 0;
  let duplicateRecords = 0;
  let exclusionRecords = 0;
  let reachedLimit = false;
  const sourceRecordIds = new Set<string>();
  const issueCounts: Record<string, number> = {};
  const classificationCounts = { marketed: 0, nutritionallyDense: 0, neither: 0, unknownNutrition: 0 };
  let missingIngredients = 0;
  let missingNutrition = 0;
  let newRecords = 0;
  let changedRecords = 0;
  let unchangedRecords = 0;
  const seenPreviousIds = new Set<string>();

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (format === "tsv" && headers === null) {
        headers = line.split("\t");
        continue;
      }
      recordsRead += 1;
      let record: RawRecord;
      if (format === "tsv") {
        const values = line.split("\t");
        record = Object.fromEntries((headers ?? []).map((header, index) => [header, values[index] ?? ""]));
      } else {
        const parsed: unknown = JSON.parse(line);
        if (!isRecord(parsed)) {
          invalidRecords += 1;
          continue;
        }
        record = parsed;
      }
      if (!isIndiaRecord(record)) continue;
      indiaRecords += 1;
      const normalized = normalizeOpenFoodFactsRecord(record);
      for (const issue of normalized.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
      if (!normalized.staged) {
        invalidRecords += 1;
        exclusionRecords += 1;
        await writeLine(exclusionsOutput, JSON.stringify(excludedSourceRecord(record, recordsRead, normalized.issues)));
        continue;
      }
      if (sourceRecordIds.has(normalized.staged.sourceRecordId)) {
        duplicateRecords += 1;
        exclusionRecords += 1;
        await writeLine(exclusionsOutput, JSON.stringify(excludedSourceRecord(record, recordsRead, [{
          code: "duplicate_source_record_id",
          message: "Source record ID occurs more than once in the India slice",
          severity: "error",
          field: "identity",
        }])));
        continue;
      }
      sourceRecordIds.add(normalized.staged.sourceRecordId);
      if (normalized.staged.ingredients.status === "missing") missingIngredients += 1;
      if (normalized.staged.nutrition.status === "missing") missingNutrition += 1;
      if (normalized.staged.classification.marketed) classificationCounts.marketed += 1;
      if (normalized.staged.classification.nutritionallyDense) classificationCounts.nutritionallyDense += 1;
      if (!normalized.staged.classification.marketed && normalized.staged.classification.nutritionallyDense === false) {
        classificationCounts.neither += 1;
      }
      if (normalized.staged.classification.nutritionallyDense === null) classificationCounts.unknownNutrition += 1;
      await writeLine(output, JSON.stringify(normalized.staged));
      await writeLine(indexOutput, JSON.stringify({
        sourceRecordId: normalized.staged.sourceRecordId,
        contentHash: normalized.staged.contentHash,
      } satisfies SourceIndexRecord));
      const previousHash = previousIndex?.get(normalized.staged.sourceRecordId);
      if (previousHash === undefined) newRecords += 1;
      else if (previousHash === normalized.staged.contentHash) unchangedRecords += 1;
      else changedRecords += 1;
      if (previousHash !== undefined) seenPreviousIds.add(normalized.staged.sourceRecordId);
      stagedRecords += 1;
      if (options.limit !== null && stagedRecords >= options.limit) {
        reachedLimit = true;
        break;
      }
    }
  } finally {
    lines.close();
    if (reachedLimit) {
      source.destroy();
      hashingStream.destroy();
      decoded.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
    await new Promise<void>((resolve, reject) => {
      indexOutput.once("error", reject);
      indexOutput.end(resolve);
    });
    await new Promise<void>((resolve, reject) => {
      exclusionsOutput.once("error", reject);
      exclusionsOutput.end(resolve);
    });
  }

  if (indiaRecords === 0 || stagedRecords === 0) {
    throw new Error("Source sync produced zero India-tagged staged records; refusing to publish an empty snapshot.");
  }
  const completedAt = new Date().toISOString();
  const sourceComplete = !reachedLimit;
  const indiaSliceReconciles = indiaRecords === stagedRecords + exclusionRecords;
  if (!indiaSliceReconciles) {
    throw new Error(`India source accounting does not reconcile: ${indiaRecords} read, ${stagedRecords} staged, ${exclusionRecords} excluded.`);
  }
  const manifest: SourceManifest = {
    schemaVersion: 1,
    source: "open_food_facts",
    sourceKind: "open_data",
    sourceAuthority: { identity: 45, nutrition: 40, ingredients: 40 },
    sourceLicenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    sourceRetentionNotes: "Open Database License; preserve attribution and share-alike obligations.",
    adapterVersion: OPEN_FOOD_FACTS_ADAPTER_VERSION,
    input: basename(options.input),
    inputHash: sourceComplete ? inputHash.digest("hex") : null,
    inputBytes: inputStats.size,
    sourceUpdatedAt: parseSourceUpdatedAt(options.sourceUpdatedAt),
    startedAt,
    completedAt,
    mode: options.mode,
    terminalEvidence: sourceComplete ? "end_of_file" : "limit",
    sourceComplete,
    marketComplete: false,
    advertisedTotal: null,
    recordsRead,
    indiaRecords,
    stagedRecords,
    invalidRecords,
    duplicateRecords,
    newRecords,
    changedRecords,
    unchangedRecords,
    missingSinceRecords: previousIndex === null ? 0 : previousIndex.size - seenPreviousIds.size,
    knownExclusions: [
      "Records not tagged for India by Open Food Facts",
      "Source records without both a product code and product name",
      "Products absent from Open Food Facts",
    ],
    disconnectedSources: ["gs1_india_datakart", "brand_owner_feeds", "retailer_offer_feeds"],
  };
  const report = {
    generatedAt: completedAt,
    sourceComplete,
    marketComplete: false,
    continuity: {
      baselineAvailable: previousManifest !== null,
      previousCompletedAt: previousManifest?.completedAt ?? null,
      maximumDropRatio,
      currentStagedRecords: stagedRecords,
      previousStagedRecords: previousManifest?.stagedRecords ?? null,
      newRecords,
      changedRecords,
      unchangedRecords,
      missingSinceRecords: manifest.missingSinceRecords,
    },
    exclusions: {
      records: exclusionRecords,
      path: basename(exclusionsPath),
      reconcilesIndiaSlice: indiaSliceReconciles,
    },
    issueCounts,
    classificationCounts,
    coverageGaps: {
      missingIngredients,
      missingNutrition,
      unverifiedNutrition: stagedRecords - missingNutrition,
      unverifiedIngredients: stagedRecords - missingIngredients,
      disconnectedSources: manifest.disconnectedSources,
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  assertContinuity({ current: manifest, previous: previousManifest, previousIndexSize: previousIndex?.size ?? null, maximumDropRatio });
  return { manifest, stagedPath, manifestPath, reportPath, indexPath, exclusionsPath };
}
