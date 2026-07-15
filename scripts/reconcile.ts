import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { nutritionCandidateFromEvidence, nutritionCandidateHash, type NutritionCandidate } from "../shared/evidence-decisions";
import { compositeIdentityKey, normalizeText } from "../shared/gtin";
import type { NormalizedIngredient, SourceManifest, StagedProduct } from "../shared/types";

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function sql(value: string | number | boolean | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot serialize non-finite SQL number");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${value.replace(/'/g, "''")}'`;
}

function json(value: unknown): string {
  return sql(JSON.stringify(value) ?? "null");
}

async function write(stream: NodeJS.WritableStream, statement: string): Promise<void> {
  if (!stream.write(`${statement}\n`)) await once(stream, "drain");
}

function productIdFor(product: StagedProduct): string {
  const composite = compositeIdentityKey(product);
  const identity = product.gtin ? `gtin:${product.gtin}` : composite ? `composite:${composite}` : `source:${product.source}:${product.sourceRecordId}`;
  return stableId("prd", identity);
}

export function identityEvidenceHash(product: Pick<StagedProduct, "gtin" | "brand" | "name" | "flavour" | "netQuantityGrams">): string {
  const evidence = {
    gtin: product.gtin,
    brand: normalizeText(product.brand),
    name: normalizeText(product.name),
    flavour: normalizeText(product.flavour) || null,
    netQuantityGrams: product.netQuantityGrams,
  };
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

interface PendingIdentityReview {
  reviewId: string;
  sourceRecordId: string;
  proposedProductId: string;
  source: string;
  sourceRecordKey: string;
  identityHash: string;
  brand: string;
  name: string;
  flavour: string | null;
  netQuantityGrams: number | null;
  createdAt: string;
}

interface NutritionDecisionCandidate {
  candidate: NutritionCandidate;
  candidateHash: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function nutritionDecisionCandidate(product: StagedProduct): Promise<NutritionDecisionCandidate | null> {
  const issue = product.validationIssues.find(({ code }) => code === "robotoff_nutrition_candidate");
  if (!issue) return null;
  const candidate = nutritionCandidateFromEvidence(issue, product.gtin);
  const declaredHash = record(issue.details)?.candidateHash;
  if (!candidate || (declaredHash !== undefined && typeof declaredHash !== "string")) return null;
  const computedHash = await nutritionCandidateHash(candidate);
  return declaredHash === undefined || computedHash === declaredHash
    ? { candidate, candidateHash: computedHash }
    : null;
}

function flattenIngredients(
  ingredients: NormalizedIngredient[],
  parentId: string | null,
  sourceRecordId: string,
  productId: string,
): Array<{ id: string; parentId: string | null; ingredient: NormalizedIngredient }> {
  return ingredients.flatMap((ingredient) => {
    const id = stableId("ing", `${sourceRecordId}:${parentId ?? "root"}:${ingredient.position}:${ingredient.raw}`);
    return [
      { id, parentId, ingredient },
      ...flattenIngredients(ingredient.children, id, sourceRecordId, productId),
    ];
  });
}

export async function emitImportSql(input: {
  stagedPath: string;
  manifestPath: string;
  outputPath: string;
  includeTransaction?: boolean;
}): Promise<{ products: number; outputPath: string }> {
  const manifest = JSON.parse(await readFile(input.manifestPath, "utf8")) as SourceManifest;
  const runId = stableId("run", `${manifest.source}:${manifest.startedAt}:${manifest.inputHash ?? manifest.input}`);
  const output = createWriteStream(input.outputPath, { encoding: "utf8" });
  await write(output, "PRAGMA foreign_keys = ON;");
  if (input.includeTransaction !== false) await write(output, "BEGIN IMMEDIATE;");
  await write(
    output,
    `INSERT INTO sources (id, name, kind, identity_authority, nutrition_authority, ingredient_authority, license_url, retention_notes, credential_requirement, created_at) VALUES (${sql(manifest.source)}, ${sql(manifest.source)}, ${sql(manifest.sourceKind)}, ${manifest.sourceAuthority.identity}, ${manifest.sourceAuthority.nutrition}, ${manifest.sourceAuthority.ingredients}, ${sql(manifest.sourceLicenseUrl)}, ${sql(manifest.sourceRetentionNotes)}, NULL, ${sql(manifest.startedAt)}) ON CONFLICT(id) DO UPDATE SET identity_authority = excluded.identity_authority, nutrition_authority = excluded.nutrition_authority, ingredient_authority = excluded.ingredient_authority, license_url = excluded.license_url, retention_notes = excluded.retention_notes;`,
  );
  await write(
    output,
    `INSERT INTO ingestion_runs (id, source_id, adapter_version, mode, input_identifier, input_hash, input_bytes, advertised_total, records_read, india_records, staged_records, invalid_records, duplicate_records, terminal_evidence, source_complete, market_complete, status, started_at, completed_at, manifest_json) VALUES (${sql(runId)}, ${sql(manifest.source)}, ${sql(manifest.adapterVersion)}, ${sql(manifest.mode)}, ${sql(manifest.input)}, ${sql(manifest.inputHash)}, ${sql(manifest.inputBytes)}, ${sql(manifest.advertisedTotal)}, ${manifest.recordsRead}, ${manifest.indiaRecords}, ${manifest.stagedRecords}, ${manifest.invalidRecords}, ${manifest.duplicateRecords}, ${sql(manifest.terminalEvidence)}, ${sql(manifest.sourceComplete)}, 0, 'running', ${sql(manifest.startedAt)}, NULL, ${json(manifest)}) ON CONFLICT(id) DO UPDATE SET status = 'running', completed_at = NULL, manifest_json = excluded.manifest_json;`,
  );

  const lines = createInterface({ input: createReadStream(input.stagedPath), crlfDelay: Infinity });
  let products = 0;
  const pendingIdentityReviews: PendingIdentityReview[] = [];
  for await (const line of lines) {
    if (!line.trim()) continue;
    const product = JSON.parse(line) as StagedProduct;
    const productId = productIdFor(product);
    const sourceRecordId = stableId("src", `${product.source}:${product.sourceRecordId}`);
    const identityHash = identityEvidenceHash(product);
    const nutritionCandidate = await nutritionDecisionCandidate(product);
    const decisionProductSql = `(SELECT d.target_product_id FROM identity_decisions d WHERE d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.identity_hash = ${sql(identityHash)} AND d.active = 1 ORDER BY d.decided_at DESC LIMIT 1)`;
    const decisionKindSql = `(SELECT d.decision FROM identity_decisions d WHERE d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.identity_hash = ${sql(identityHash)} AND d.active = 1 ORDER BY d.decided_at DESC LIMIT 1)`;
    const productIdSql = `COALESCE(${decisionProductSql}, ${sql(productId)})`;
    const sourceProductIdSql = `CASE WHEN ${decisionKindSql} = 'no_match' THEN NULL ELSE ${productIdSql} END`;
    const automaticRule = product.gtin ? "exact_gtin" : compositeIdentityKey(product) ? "deterministic_composite" : "source_identity";
    const resolutionRuleSql = `COALESCE('manual_' || ${decisionKindSql}, ${sql(automaticRule)})`;
    const now = manifest.completedAt;
    await write(
      output,
      `INSERT INTO products (id, product_kind, gtin, brand, brand_normalized, name, name_normalized, flavour, flavour_normalized, category, category_raw, net_quantity_grams, serving_size_grams, image_url, nutrition_image_url, ingredient_image_url, marketed_protein, marketed_reasons_json, nutritionally_protein_dense, nutrition_reasons_json, classifier_version, completeness, completeness_missing_json, identity_authority, created_at, updated_at) VALUES (${productIdSql}, ${sql(product.productKind)}, ${sql(product.gtin)}, ${sql(product.brand)}, ${sql(normalizeText(product.brand))}, ${sql(product.name)}, ${sql(normalizeText(product.name))}, ${sql(product.flavour)}, ${sql(normalizeText(product.flavour) || null)}, ${sql(product.category)}, ${sql(product.categoryRaw)}, ${sql(product.netQuantityGrams)}, ${sql(product.servingSizeGrams)}, ${sql(product.imageUrl)}, ${sql(product.nutritionImageUrl)}, ${sql(product.ingredientImageUrl)}, ${sql(product.classification.marketed)}, ${json(product.classification.marketedReasons)}, ${sql(product.classification.nutritionallyDense)}, ${json(product.classification.nutritionReasons)}, ${sql(product.classification.version)}, ${product.completeness}, ${json(product.completenessMissing)}, ${product.sourceAuthority.identity}, ${sql(now)}, ${sql(now)}) ON CONFLICT(id) DO UPDATE SET brand = excluded.brand, brand_normalized = excluded.brand_normalized, name = excluded.name, name_normalized = excluded.name_normalized, flavour = COALESCE(excluded.flavour, products.flavour), flavour_normalized = COALESCE(excluded.flavour_normalized, products.flavour_normalized), category = excluded.category, category_raw = COALESCE(excluded.category_raw, products.category_raw), net_quantity_grams = COALESCE(excluded.net_quantity_grams, products.net_quantity_grams), serving_size_grams = COALESCE(excluded.serving_size_grams, products.serving_size_grams), image_url = COALESCE(excluded.image_url, products.image_url), nutrition_image_url = COALESCE(excluded.nutrition_image_url, products.nutrition_image_url), ingredient_image_url = COALESCE(excluded.ingredient_image_url, products.ingredient_image_url), marketed_protein = excluded.marketed_protein, marketed_reasons_json = excluded.marketed_reasons_json, nutritionally_protein_dense = excluded.nutritionally_protein_dense, nutrition_reasons_json = excluded.nutrition_reasons_json, classifier_version = excluded.classifier_version, completeness_missing_json = CASE WHEN excluded.completeness >= products.completeness THEN excluded.completeness_missing_json ELSE products.completeness_missing_json END, completeness = MAX(products.completeness, excluded.completeness), identity_authority = MAX(products.identity_authority, excluded.identity_authority), updated_at = excluded.updated_at WHERE excluded.identity_authority >= products.identity_authority;`,
    );
    await write(
      output,
      `INSERT INTO source_records (id, source_id, source_record_id, product_id, source_url, content_hash, identity_hash, observed_at, first_seen_run_id, last_seen_run_id, raw_evidence_json, resolution_rule) VALUES (${sql(sourceRecordId)}, ${sql(product.source)}, ${sql(product.sourceRecordId)}, ${sourceProductIdSql}, ${sql(product.sourceUrl)}, ${sql(product.contentHash)}, ${sql(identityHash)}, ${sql(product.observedAt)}, ${sql(runId)}, ${sql(runId)}, ${json(product.rawEvidence)}, ${resolutionRuleSql}) ON CONFLICT(source_id, source_record_id) DO UPDATE SET product_id = excluded.product_id, source_url = excluded.source_url, content_hash = excluded.content_hash, identity_hash = excluded.identity_hash, observed_at = excluded.observed_at, last_seen_run_id = excluded.last_seen_run_id, raw_evidence_json = excluded.raw_evidence_json, resolution_rule = excluded.resolution_rule;`,
    );
    await write(
      output,
      `UPDATE products SET is_active = 1 WHERE id = ${sql(productId)} AND NOT EXISTS (SELECT 1 FROM identity_decisions d WHERE d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.identity_hash = ${sql(identityHash)} AND d.active = 1 AND (d.decision = 'no_match' OR d.target_product_id <> ${sql(productId)}));`,
    );
    if (!product.gtin && !compositeIdentityKey(product)) {
      pendingIdentityReviews.push({
        reviewId: stableId("rev", `${sourceRecordId}:identity:${identityHash}`),
        sourceRecordId,
        proposedProductId: productId,
        source: product.source,
        sourceRecordKey: product.sourceRecordId,
        identityHash,
        brand: normalizeText(product.brand),
        name: normalizeText(product.name),
        flavour: normalizeText(product.flavour) || null,
        netQuantityGrams: product.netQuantityGrams,
        createdAt: now,
      });
    }

    const nutritionHasError = product.validationIssues.some((issue) => issue.severity === "error" && issue.field !== "gtin");
    if (!nutritionHasError && product.nutrition.status !== "missing") {
      const nutrient = product.nutrition.per100g;
      await write(
        output,
        `INSERT INTO nutrition_facts (product_id, source_record_id, status, confidence, authority, basis, preparation_state, calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams, fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at) VALUES (${productIdSql}, ${sql(sourceRecordId)}, ${sql(product.nutrition.status)}, ${sql(product.nutrition.confidence)}, ${product.sourceAuthority.nutrition}, ${sql(product.nutrition.basis)}, ${sql(product.nutrition.preparationState)}, ${sql(nutrient.calories)}, ${sql(nutrient.proteinGrams)}, ${sql(nutrient.carbohydrateGrams)}, ${sql(nutrient.sugarGrams)}, ${sql(nutrient.fatGrams)}, ${sql(nutrient.saturatedFatGrams)}, ${sql(nutrient.fibreGrams)}, ${sql(nutrient.sodiumMg)}, ${sql(product.nutrition.labelVerifiedAt)}, ${sql(product.nutrition.observedAt)}, ${sql(now)}) ON CONFLICT(product_id) DO UPDATE SET source_record_id = excluded.source_record_id, status = excluded.status, confidence = excluded.confidence, authority = excluded.authority, basis = excluded.basis, preparation_state = excluded.preparation_state, calories = excluded.calories, protein_grams = excluded.protein_grams, carbohydrate_grams = excluded.carbohydrate_grams, sugar_grams = excluded.sugar_grams, fat_grams = excluded.fat_grams, saturated_fat_grams = excluded.saturated_fat_grams, fibre_grams = excluded.fibre_grams, sodium_mg = excluded.sodium_mg, label_verified_at = excluded.label_verified_at, observed_at = excluded.observed_at, updated_at = excluded.updated_at WHERE excluded.authority > nutrition_facts.authority OR (excluded.authority = nutrition_facts.authority AND excluded.observed_at > nutrition_facts.observed_at);`,
      );
    }

    const nutritionDecisionWhere = nutritionCandidate
      ? `d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.source_record_id = ${sql(sourceRecordId)} AND d.source_content_hash = ${sql(product.contentHash)} AND d.product_id = ${productIdSql} AND d.candidate_hash = ${sql(nutritionCandidate.candidateHash)} AND d.field_family = 'nutrition' AND d.active = 1`
      : null;
    if (nutritionCandidate && nutritionDecisionWhere) {
      const verifyWhere = `${nutritionDecisionWhere} AND d.decision = 'verify'`;
      const driftWhere = `d.source_id = ${sql(product.source)} AND d.source_record_key = ${sql(product.sourceRecordId)} AND d.product_id = ${productIdSql} AND d.field_family = 'nutrition' AND d.active = 1 AND (d.source_content_hash <> ${sql(product.contentHash)} OR d.candidate_hash <> ${sql(nutritionCandidate.candidateHash)})`;
      await write(
        output,
        `UPDATE nutrition_facts SET status = 'conflict', confidence = 'low', label_verified_at = NULL, updated_at = ${sql(now)} WHERE product_id = ${productIdSql} AND source_record_id = ${sql(sourceRecordId)} AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND NOT EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${nutritionDecisionWhere});`,
      );
      await write(
        output,
        `DELETE FROM evidence_outcomes WHERE product_id = ${productIdSql} AND field_family = 'nutrition' AND source_record_id = ${sql(sourceRecordId)} AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${driftWhere}) AND NOT EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${nutritionDecisionWhere});`,
      );
      await write(
        output,
        `INSERT INTO nutrition_facts (product_id, source_record_id, status, confidence, authority, basis, preparation_state, calories, protein_grams, carbohydrate_grams, sugar_grams, fat_grams, saturated_fat_grams, fibre_grams, sodium_mg, label_verified_at, observed_at, updated_at) SELECT d.product_id, d.source_record_id, 'verified', 'high', 100, 'per_100g', 'as_sold', json_extract(d.payload_json, '$.nutritionPer100g.calories'), json_extract(d.payload_json, '$.nutritionPer100g.proteinGrams'), json_extract(d.payload_json, '$.nutritionPer100g.carbohydrateGrams'), json_extract(d.payload_json, '$.nutritionPer100g.sugarGrams'), json_extract(d.payload_json, '$.nutritionPer100g.fatGrams'), json_extract(d.payload_json, '$.nutritionPer100g.saturatedFatGrams'), json_extract(d.payload_json, '$.nutritionPer100g.fibreGrams'), json_extract(d.payload_json, '$.nutritionPer100g.sodiumMg'), d.decided_at, json_extract(d.payload_json, '$.observedAt'), d.decided_at FROM evidence_decisions d WHERE ${verifyWhere} ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(product_id) DO UPDATE SET source_record_id = excluded.source_record_id, status = excluded.status, confidence = excluded.confidence, authority = excluded.authority, basis = excluded.basis, preparation_state = excluded.preparation_state, calories = excluded.calories, protein_grams = excluded.protein_grams, carbohydrate_grams = excluded.carbohydrate_grams, sugar_grams = excluded.sugar_grams, fat_grams = excluded.fat_grams, saturated_fat_grams = excluded.saturated_fat_grams, fibre_grams = excluded.fibre_grams, sodium_mg = excluded.sodium_mg, label_verified_at = excluded.label_verified_at, observed_at = excluded.observed_at, updated_at = excluded.updated_at;`,
      );
      await write(
        output,
        `UPDATE field_observations SET selected = 0 WHERE product_id = ${productIdSql} AND field_path LIKE 'nutrition.%' AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${verifyWhere});`,
      );
      const reviewedNutritionFields = [
        ["calories", "kcal"],
        ["proteinGrams", "g"],
        ["carbohydrateGrams", "g"],
        ["sugarGrams", "g"],
        ["fatGrams", "g"],
        ["saturatedFatGrams", "g"],
        ["fibreGrams", "g"],
        ["sodiumMg", "mg"],
      ] as const;
      for (const [field, unit] of reviewedNutritionFields) {
        const path = `$.nutritionPer100g.${field}`;
        const valueHash = `reviewed:${nutritionCandidate.candidateHash}:${field}`;
        const observationId = stableId("obs", `${sourceRecordId}:${valueHash}`);
        const nutrientId = stableId("nut", `${sourceRecordId}:${nutritionCandidate.candidateHash}:${field}`);
        await write(
          output,
          `INSERT INTO field_observations (id, product_id, source_record_id, field_path, raw_value_json, normalized_value_json, confidence, authority, observed_at, evidence_url, selected, value_hash) SELECT ${sql(observationId)}, d.product_id, d.source_record_id, ${sql(`nutrition.${field}`)}, json(json_extract(d.payload_json, ${sql(path)})), json(json_extract(d.payload_json, ${sql(path)})), 'high', 100, json_extract(d.payload_json, '$.observedAt'), d.evidence_url, 1, ${sql(valueHash)} FROM evidence_decisions d WHERE ${verifyWhere} AND json_type(d.payload_json, ${sql(path)}) IN ('integer', 'real') ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(source_record_id, field_path, value_hash) DO UPDATE SET product_id = excluded.product_id, confidence = excluded.confidence, authority = excluded.authority, observed_at = excluded.observed_at, evidence_url = excluded.evidence_url, selected = 1;`,
        );
        await write(
          output,
          `INSERT INTO nutrient_values (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at) SELECT ${sql(nutrientId)}, d.product_id, d.source_record_id, ${sql(field)}, json_extract(d.payload_json, ${sql(path)}), ${sql(unit)}, 'per_100g', 'as_sold', 'verified', json_extract(d.payload_json, '$.observedAt') FROM evidence_decisions d WHERE ${verifyWhere} AND json_type(d.payload_json, ${sql(path)}) IN ('integer', 'real') ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(source_record_id, nutrient_code, basis, preparation_state) DO UPDATE SET product_id = excluded.product_id, quantity = excluded.quantity, unit = excluded.unit, status = excluded.status, observed_at = excluded.observed_at;`,
        );
      }
      await write(
        output,
        `INSERT INTO evidence_outcomes (product_id, field_family, outcome, source_record_id, evidence_url, observed_at, verified_at, decided_by, notes) SELECT d.product_id, 'nutrition', 'verified', d.source_record_id, d.evidence_url, json_extract(d.payload_json, '$.observedAt'), d.decided_at, d.decided_by, d.rationale FROM evidence_decisions d WHERE ${verifyWhere} ORDER BY d.decided_at DESC LIMIT 1 ON CONFLICT(product_id, field_family) DO UPDATE SET outcome = excluded.outcome, source_record_id = excluded.source_record_id, evidence_url = excluded.evidence_url, observed_at = excluded.observed_at, verified_at = excluded.verified_at, decided_by = excluded.decided_by, notes = excluded.notes;`,
      );
    }

    if (product.ingredients.status !== "missing") {
      await write(
        output,
        `INSERT INTO ingredient_statements (product_id, source_record_id, raw_text, language, status, confidence, authority, observed_at, updated_at) VALUES (${productIdSql}, ${sql(sourceRecordId)}, ${sql(product.ingredients.raw)}, ${sql(product.ingredients.language)}, ${sql(product.ingredients.status)}, ${sql(product.ingredients.confidence)}, ${product.sourceAuthority.ingredients}, ${sql(product.ingredients.observedAt)}, ${sql(now)}) ON CONFLICT(product_id) DO UPDATE SET source_record_id = excluded.source_record_id, raw_text = excluded.raw_text, language = excluded.language, status = excluded.status, confidence = excluded.confidence, authority = excluded.authority, observed_at = excluded.observed_at, updated_at = excluded.updated_at WHERE excluded.authority > ingredient_statements.authority OR (excluded.authority = ingredient_statements.authority AND excluded.observed_at > ingredient_statements.observed_at);`,
      );
    }

    for (const nutrient of product.nutrients) {
      const nutrientId = stableId("nut", `${sourceRecordId}:${nutrient.code}:${nutrient.basis}:${nutrient.preparationState}`);
      await write(
        output,
        `INSERT INTO nutrient_values (id, product_id, source_record_id, nutrient_code, quantity, unit, basis, preparation_state, status, observed_at) VALUES (${sql(nutrientId)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(nutrient.code)}, ${nutrient.quantity}, ${sql(nutrient.unit)}, ${sql(nutrient.basis)}, ${sql(nutrient.preparationState)}, ${sql(product.nutrition.status === "verified" ? "verified" : "unverified")}, ${sql(product.observedAt)}) ON CONFLICT(source_record_id, nutrient_code, basis, preparation_state) DO UPDATE SET product_id = excluded.product_id, quantity = excluded.quantity, unit = excluded.unit, status = excluded.status, observed_at = excluded.observed_at;`,
      );
    }

    const flattenedIngredients = flattenIngredients(product.ingredients.normalized, null, sourceRecordId, productId);
    for (const item of flattenedIngredients) {
      const percentage = item.ingredient.percentage !== null && item.ingredient.percentage >= 0 && item.ingredient.percentage <= 100
        ? item.ingredient.percentage
        : null;
      await write(
        output,
        `INSERT INTO product_ingredients (id, product_id, source_record_id, parent_id, position, raw_text, normalized_name, percentage, resolved) VALUES (${sql(item.id)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(item.parentId)}, ${item.ingredient.position}, ${sql(item.ingredient.raw)}, ${sql(item.ingredient.normalizedName)}, ${sql(percentage)}, ${sql(item.ingredient.normalizedName !== null)}) ON CONFLICT(id) DO UPDATE SET product_id = excluded.product_id, raw_text = excluded.raw_text, normalized_name = excluded.normalized_name, percentage = excluded.percentage, resolved = excluded.resolved;`,
      );
      if (item.ingredient.percentage !== percentage) {
        const reviewId = stableId("rev", `${sourceRecordId}:invalid_ingredient_percentage:${item.id}`);
        await write(
          output,
          `INSERT OR IGNORE INTO review_items (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json, evidence_json, created_at) VALUES (${sql(reviewId)}, 'ingredient_conflict', 50, 'open', ${sql(sourceRecordId)}, ${productIdSql}, '[]', ${json({ code: "invalid_ingredient_percentage", raw: item.ingredient.raw, percentage: item.ingredient.percentage })}, ${sql(now)});`,
        );
      }
    }
    for (const allergen of product.ingredients.allergens) {
      await write(
        output,
        `INSERT OR IGNORE INTO product_allergens (product_id, name, declaration, source_record_id) VALUES (${productIdSql}, ${sql(allergen.name)}, ${sql(allergen.declaration)}, ${sql(sourceRecordId)});`,
      );
    }
    for (const additive of product.ingredients.additives) {
      await write(
        output,
        `INSERT OR IGNORE INTO product_additives (product_id, identifier, source_record_id, confidence) VALUES (${productIdSql}, ${sql(additive)}, ${sql(sourceRecordId)}, ${sql(product.ingredients.confidence)});`,
      );
    }
    for (const offer of product.offers) {
      const offerId = stableId("off", `${offer.retailer}:${offer.retailerListingId}:${offer.pincode ?? ""}:${offer.seller ?? ""}:${offer.observedAt}`);
      await write(
        output,
        `INSERT INTO offers (id, product_id, source_record_id, retailer, retailer_listing_id, pincode, seller, mrp, selling_price, available, url, observed_at) VALUES (${sql(offerId)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(offer.retailer)}, ${sql(offer.retailerListingId)}, ${sql(offer.pincode)}, ${sql(offer.seller)}, ${sql(offer.mrp)}, ${offer.sellingPrice}, ${sql(offer.available)}, ${sql(offer.url)}, ${sql(offer.observedAt)}) ON CONFLICT(retailer, retailer_listing_id, pincode, seller, observed_at) DO UPDATE SET product_id = excluded.product_id, source_record_id = excluded.source_record_id, mrp = excluded.mrp, selling_price = excluded.selling_price, available = excluded.available, url = excluded.url;`,
      );
    }
    for (const rating of product.ratings) {
      const ratingId = stableId("rat", `${rating.retailer}:${rating.retailerListingId}:${rating.observedAt}`);
      await write(
        output,
        `INSERT INTO ratings (id, product_id, source_record_id, retailer, retailer_listing_id, stars, rating_count, review_count, observed_at) VALUES (${sql(ratingId)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(rating.retailer)}, ${sql(rating.retailerListingId)}, ${rating.stars}, ${rating.ratingCount}, ${sql(rating.reviewCount)}, ${sql(rating.observedAt)}) ON CONFLICT(retailer, retailer_listing_id, observed_at) DO UPDATE SET product_id = excluded.product_id, source_record_id = excluded.source_record_id, stars = excluded.stars, rating_count = excluded.rating_count, review_count = excluded.review_count;`,
      );
    }

    const observations: Array<[string, unknown, unknown, number]> = [
      ["identity.brand", product.rawEvidence.brands ?? product.brand, product.brand, product.sourceAuthority.identity],
      ["identity.name", product.rawEvidence.product_name ?? product.name, product.name, product.sourceAuthority.identity],
      ["identity.gtin", product.gtinRaw, product.gtin, product.sourceAuthority.identity],
      ["nutrition.protein_grams_per_100g", product.rawEvidence["proteins_100g"], product.nutrition.per100g.proteinGrams, product.sourceAuthority.nutrition],
      ["nutrition.calories_per_100g", product.rawEvidence["energy-kcal_100g"], product.nutrition.per100g.calories, product.sourceAuthority.nutrition],
      ["ingredients.raw", product.ingredients.raw, product.ingredients.raw, product.sourceAuthority.ingredients],
    ];
    for (const [field, raw, normalized, authority] of observations) {
      if (normalized === null || normalized === undefined) continue;
      const valueHash = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
      const observationId = stableId("obs", `${sourceRecordId}:${field}:${valueHash}`);
      await write(
        output,
        `INSERT INTO field_observations (id, product_id, source_record_id, field_path, raw_value_json, normalized_value_json, confidence, authority, observed_at, evidence_url, selected, value_hash) VALUES (${sql(observationId)}, ${productIdSql}, ${sql(sourceRecordId)}, ${sql(field)}, ${json(raw)}, ${json(normalized)}, ${sql(field.startsWith("identity") ? "medium" : product.nutrition.confidence)}, ${authority}, ${sql(product.observedAt)}, ${sql(product.sourceUrl)}, 0, ${sql(valueHash)}) ON CONFLICT(source_record_id, field_path, value_hash) DO UPDATE SET product_id = excluded.product_id, observed_at = excluded.observed_at, evidence_url = excluded.evidence_url;`,
      );
      await write(output, `UPDATE field_observations SET selected = 0 WHERE product_id = ${productIdSql} AND field_path = ${sql(field)};`);
      await write(output, `UPDATE field_observations SET selected = 1 WHERE id = (SELECT id FROM field_observations WHERE product_id = ${productIdSql} AND field_path = ${sql(field)} ORDER BY authority DESC, observed_at DESC, id LIMIT 1);`);
    }

    for (const issue of product.validationIssues) {
      const type = issue.code === "invalid_gtin" ? "invalid_gtin" : issue.code.startsWith("invalid_ingredient") ? "ingredient_conflict" : "nutrition_validation";
      const reviewIdentity = issue.code === "robotoff_nutrition_candidate" && nutritionCandidate
        ? `${sourceRecordId}:${issue.code}:${issue.field}:${product.contentHash}:${nutritionCandidate.candidateHash}`
        : `${sourceRecordId}:${issue.code}:${issue.field}`;
      const reviewId = stableId("rev", reviewIdentity);
      const matchingDecisionAbsent = issue.code === "robotoff_nutrition_candidate" && nutritionDecisionWhere
        ? `NOT EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${nutritionDecisionWhere})`
        : "1 = 1";
      const reviewEvidence = issue.code === "robotoff_nutrition_candidate" && nutritionCandidate
        ? { ...issue, details: { ...issue.details, candidateHash: nutritionCandidate.candidateHash } }
        : issue;
      await write(
        output,
        `INSERT OR IGNORE INTO review_items (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json, evidence_json, created_at) SELECT ${sql(reviewId)}, ${sql(type)}, ${issue.severity === "error" ? 80 : 50}, 'open', ${sql(sourceRecordId)}, ${productIdSql}, '[]', ${json(reviewEvidence)}, ${sql(now)} WHERE ${matchingDecisionAbsent};`,
      );
      if (issue.code === "robotoff_nutrition_candidate" && nutritionDecisionWhere) {
        await write(
          output,
          `UPDATE review_items SET status = 'resolved', decision = CASE (SELECT d.decision FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1) WHEN 'verify' THEN 'verify_nutrition' ELSE 'reject_nutrition' END, decision_rationale = (SELECT d.rationale FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1), decision_evidence_url = (SELECT d.evidence_url FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1), decided_by = (SELECT d.decided_by FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1), resolved_at = (SELECT d.decided_at FROM evidence_decisions d WHERE ${nutritionDecisionWhere} ORDER BY d.decided_at DESC LIMIT 1) WHERE id = ${sql(reviewId)} AND status = 'open' AND EXISTS (SELECT 1 FROM evidence_decisions d WHERE ${nutritionDecisionWhere});`,
        );
      }
    }
    if (product.classification.marketed && product.nutrition.status !== "verified") {
      const reviewId = stableId("rev", `${sourceRecordId}:coverage:verified_nutrition`);
      await write(
        output,
        `INSERT OR IGNORE INTO review_items (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json, evidence_json, created_at) VALUES (${sql(reviewId)}, 'coverage_gap', 70, 'open', ${sql(sourceRecordId)}, ${productIdSql}, '[]', ${json({ gap: "verified_nutrition", marketedReasons: product.classification.marketedReasons })}, ${sql(now)});`,
      );
    }
    products += 1;
  }
  for (const review of pendingIdentityReviews) {
    const candidateFilter = `p.is_active = 1 AND p.id <> ${sql(review.proposedProductId)} AND (p.gtin IS NOT NULL OR p.net_quantity_grams IS NOT NULL OR p.flavour_normalized IS NOT NULL) AND p.brand_normalized = ${sql(review.brand)} AND (p.name_normalized = ${sql(review.name)} OR substr(p.name_normalized, 1, ${review.name.length + 1}) = ${sql(`${review.name} `)} OR substr(${sql(review.name)}, 1, length(p.name_normalized) + 1) = p.name_normalized || ' ')`;
    const candidateRows = `SELECT p.id AS candidate_id, CASE WHEN p.name_normalized = ${sql(review.name)} THEN 92 ELSE 78 END AS score FROM products p WHERE ${candidateFilter} ORDER BY score DESC, p.id LIMIT 8`;
    const decisionAbsent = `NOT EXISTS (SELECT 1 FROM identity_decisions d WHERE d.source_id = ${sql(review.source)} AND d.source_record_key = ${sql(review.sourceRecordKey)} AND d.identity_hash = ${sql(review.identityHash)} AND d.active = 1)`;
    await write(
      output,
      `INSERT OR IGNORE INTO review_items (id, type, priority, status, source_record_id, product_id, candidate_product_ids_json, evidence_json, created_at) SELECT ${sql(review.reviewId)}, 'identity', 80, 'open', ${sql(review.sourceRecordId)}, ${sql(review.proposedProductId)}, json_group_array(candidate_id), json_object('rule', 'brand_name_similarity', 'identityHash', ${sql(review.identityHash)}, 'incoming', json(${json({ brand: review.brand, name: review.name, flavour: review.flavour, netQuantityGrams: review.netQuantityGrams })}), 'candidateScores', json_group_array(json_object('productId', candidate_id, 'score', score))), ${sql(review.createdAt)} FROM (${candidateRows}) WHERE ${decisionAbsent} HAVING COUNT(*) > 0;`,
    );
    await write(
      output,
      `UPDATE products SET is_active = 0 WHERE id = ${sql(review.proposedProductId)} AND ${decisionAbsent} AND EXISTS (SELECT 1 FROM review_items r WHERE r.id = ${sql(review.reviewId)} AND r.status = 'open');`,
    );
  }
  await write(output, `UPDATE ingestion_runs SET status = 'completed', completed_at = ${sql(manifest.completedAt)} WHERE id = ${sql(runId)};`);
  if (input.includeTransaction !== false) await write(output, "COMMIT;");
  await new Promise<void>((resolve, reject) => {
    output.once("error", reject);
    output.end(resolve);
  });
  return { products, outputPath: input.outputPath };
}
