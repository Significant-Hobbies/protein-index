import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emitImportSql } from "../scripts/reconcile";
import { buildFixtureStage } from "../scripts/fixtures";
import type { SourceManifest } from "../shared/types";

describe("publication/import atomicity", () => {
  it("rejects an incomplete source set before durable import", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-import-incomplete-"));
    const fixture = await buildFixtureStage(directory);
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as SourceManifest;
    manifest.sourceComplete = false;
    manifest.terminalEvidence = "error";
    const manifestPath = join(directory, "incomplete-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const outputPath = join(directory, "import.sql");
    await expect(emitImportSql({ stagedPath: fixture.stagedPath, manifestPath, outputPath })).rejects.toThrow("Refusing to import an incomplete source set");
  });

  it("rejects a source set that terminated with a limit instead of end_of_file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-import-limit-"));
    const fixture = await buildFixtureStage(directory);
    const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8")) as SourceManifest;
    manifest.sourceComplete = false;
    manifest.terminalEvidence = "limit";
    const manifestPath = join(directory, "limit-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const outputPath = join(directory, "import.sql");
    await expect(emitImportSql({ stagedPath: fixture.stagedPath, manifestPath, outputPath })).rejects.toThrow("Refusing to import an incomplete source set");
  });

  it("accepts a source-complete manifest and emits import SQL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "protein-index-import-complete-"));
    const fixture = await buildFixtureStage(directory);
    const outputPath = join(directory, "import.sql");
    const result = await emitImportSql({ stagedPath: fixture.stagedPath, manifestPath: fixture.manifestPath, outputPath });
    expect(result.products).toBeGreaterThanOrEqual(1);
    const sql = await readFile(outputPath, "utf8");
    expect(sql).toContain("INSERT INTO ingestion_runs");
  });
});
