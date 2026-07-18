import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitOfficialBrandPublicationImportSql, prepareOfficialBrandPublication, validateOfficialBrandPublicationSnapshot } from "../scripts/official-brand-publication";
import type { SourceManifest, StagedProduct } from "../shared/types";

const at = "2026-07-18T00:00:00.000Z";

function product(source: string, id: string, gtin: string): StagedProduct {
  return {
    source, sourceKind: "brand", sourceAuthority: { identity: 70, nutrition: 40, ingredients: 40 }, sourceLicenseUrl: null, sourceRetentionNotes: "official", sourceRecordId: id,
    sourceUrl: `https://${source}.example/products/${id}`, observedAt: at, contentHash: `${source}${"0".repeat(64)}`.slice(0, 64), gtinRaw: gtin, gtin,
    brand: source, name: "Protein Bar", flavour: null, category: "protein_bar", categoryRaw: null, productKind: "retail_packaged", netQuantityGrams: 50, servingSizeGrams: null,
    imageUrl: null, nutritionImageUrl: null, ingredientImageUrl: null, offers: [{ retailer: source, retailerListingId: id, pincode: null, seller: null, mrp: null, sellingPrice: 100, available: true, url: `https://${source}.example/products/${id}`, observedAt: at }], ratings: [],
    nutrition: { per100g: { calories: null, proteinGrams: null, carbohydrateGrams: null, sugarGrams: null, fatGrams: null, saturatedFatGrams: null, fibreGrams: null, sodiumMg: null }, servingSizeGrams: null, basis: "unknown", preparationState: "as_sold", status: "missing", confidence: "medium", source, observedAt: at, labelVerifiedAt: null }, nutrients: [],
    ingredients: { raw: null, language: null, normalized: [], allergens: [], additives: [], status: "missing", confidence: "medium", source, observedAt: at },
    classification: { marketed: true, marketedReasons: ["protein"], nutritionallyDense: null, nutritionReasons: [], version: "protein-v3" }, completeness: 0, completenessMissing: ["nutrition", "ingredients"], rawEvidence: {}, validationIssues: [],
  };
}

function manifest(source: string, stagedRecords: number, sourceComplete = true): SourceManifest {
  return {
    schemaVersion: 1, source, sourceKind: "brand", sourceAuthority: { identity: 70, nutrition: 40, ingredients: 40 }, sourceLicenseUrl: null, sourceRetentionNotes: "official", adapterVersion: "official-brand-sitemap-v15", input: `https://${source}.example/sitemap.xml`, inputHash: "a".repeat(64), inputBytes: null, sourceUpdatedAt: null, startedAt: at, completedAt: at, mode: "production", terminalEvidence: sourceComplete ? "end_of_file" : "error", sourceComplete, marketComplete: false, advertisedTotal: null, recordsRead: stagedRecords, indiaRecords: stagedRecords, stagedRecords, invalidRecords: 0, duplicateRecords: 0, newRecords: 0, changedRecords: 0, unchangedRecords: 0, missingSinceRecords: 0, knownExclusions: [], disconnectedSources: [],
  };
}

async function artifact(root: string, source: string, record = product(source, "bar", "08900000000012"), sourceComplete = true): Promise<string> {
  const directory = join(root, source);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "manifest.json"), JSON.stringify(manifest(source, 1, sourceComplete))),
    writeFile(join(directory, "staged-products.jsonl"), `${JSON.stringify(record)}\n`),
    writeFile(join(directory, "exclusions.jsonl"), ""),
  ]);
  return directory;
}

describe("official brand publication preparation", () => {
  it("requires every configured complete source and writes a checksummed composite cohort", async () => {
    const root = await mkdtemp(join(tmpdir(), "protein-brand-publication-"));
    const configPath = join(root, "sources.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, sources: [
      { id: "brand_one", name: "Brand One", allowedHosts: ["brand-one.example"], sitemapUrls: ["https://brand-one.example/sitemap.xml"] },
      { id: "brand_two", name: "Brand Two", allowedHosts: ["brand-two.example"], sitemapUrls: ["https://brand-two.example/sitemap.xml"] },
    ] }));
    const one = await artifact(root, "brand_one", product("brand_one", "bar", "08900000000012"));
    const two = await artifact(root, "brand_two", product("brand_two", "bar", "08900000000013"));
    const snapshot = await prepareOfficialBrandPublication({ configPath, sourceDirectories: { brand_one: one, brand_two: two }, outputDirectory: join(root, "publication"), now: () => new Date(at) });
    expect(snapshot.manifest).toMatchObject({ sourceComplete: true, marketComplete: false, stagedRecords: 2 });
    expect(snapshot.manifest.sources.map((source) => source.source)).toEqual(["brand_one", "brand_two"]);
    expect((await readFile(snapshot.stagedPath, "utf8")).trim().split("\n")).toHaveLength(2);
    await expect(validateOfficialBrandPublicationSnapshot(snapshot.directory)).resolves.toMatchObject({ manifest: { stagedRecords: 2 } });
  });

  it("rejects a missing or incomplete configured source before publishing a cohort", async () => {
    const root = await mkdtemp(join(tmpdir(), "protein-brand-publication-"));
    const configPath = join(root, "sources.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, sources: [
      { id: "brand_one", name: "Brand One", allowedHosts: ["brand-one.example"], sitemapUrls: ["https://brand-one.example/sitemap.xml"] },
      { id: "brand_two", name: "Brand Two", allowedHosts: ["brand-two.example"], sitemapUrls: ["https://brand-two.example/sitemap.xml"] },
    ] }));
    const one = await artifact(root, "brand_one");
    await expect(prepareOfficialBrandPublication({ configPath, sourceDirectories: { brand_one: one }, outputDirectory: join(root, "missing") })).rejects.toThrow("every configured source");
    const two = await artifact(root, "brand_two", product("brand_two", "bar", "08900000000013"), false);
    await expect(prepareOfficialBrandPublication({ configPath, sourceDirectories: { brand_one: one, brand_two: two }, outputDirectory: join(root, "incomplete") })).rejects.toThrow("not a complete production snapshot");
  });

  it("rejects a changed composite artifact after preparation", async () => {
    const root = await mkdtemp(join(tmpdir(), "protein-brand-publication-"));
    const configPath = join(root, "sources.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, sources: [{ id: "brand_one", name: "Brand One", allowedHosts: ["brand-one.example"], sitemapUrls: ["https://brand-one.example/sitemap.xml"] }] }));
    const one = await artifact(root, "brand_one");
    const snapshot = await prepareOfficialBrandPublication({ configPath, sourceDirectories: { brand_one: one }, outputDirectory: join(root, "publication") });
    await writeFile(snapshot.stagedPath, `${JSON.stringify(product("brand_one", "changed", "08900000000012"))}\n`);
    await expect(validateOfficialBrandPublicationSnapshot(snapshot.directory)).rejects.toThrow("checksum mismatch");
  });

  it("imports each complete brand as its own source and ingestion run in one transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "protein-brand-publication-"));
    const configPath = join(root, "sources.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, sources: [
      { id: "brand_one", name: "Brand One", allowedHosts: ["brand-one.example"], sitemapUrls: ["https://brand-one.example/sitemap.xml"] },
      { id: "brand_two", name: "Brand Two", allowedHosts: ["brand-two.example"], sitemapUrls: ["https://brand-two.example/sitemap.xml"] },
    ] }));
    const one = await artifact(root, "brand_one", product("brand_one", "bar-one", "08900000000012"));
    const two = await artifact(root, "brand_two", product("brand_two", "bar-two", "08900000000013"));
    const snapshot = await prepareOfficialBrandPublication({ configPath, sourceDirectories: { brand_one: one, brand_two: two }, outputDirectory: join(root, "publication") });
    const importPath = join(root, "import.sql");
    const generated = await emitOfficialBrandPublicationImportSql({ directory: snapshot.directory, outputPath: importPath });
    expect(generated).toMatchObject({ products: 2, runIds: expect.arrayContaining([expect.any(String)]) });
    const db = new DatabaseSync(":memory:");
    for (const migration of (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort()) db.exec(await readFile(join("migrations", migration), "utf8"));
    db.exec(await readFile(importPath, "utf8"));
    expect(db.prepare("SELECT COUNT(*) AS count FROM sources WHERE id IN ('brand_one', 'brand_two')").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM ingestion_runs WHERE source_id IN ('brand_one', 'brand_two')").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM offers WHERE retailer IN ('brand_one', 'brand_two')").get()).toEqual({ count: 2 });
    db.close();
  });
});
