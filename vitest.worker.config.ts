import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { buildFixtureStage } from "./scripts/fixtures";
import { emitImportSql } from "./scripts/reconcile";

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
      const seedQueries = (await readFile(importSqlPath, "utf8"))
        .split("\n")
        .map((statement) => statement.trim())
        .filter((statement) => statement && !["BEGIN IMMEDIATE;", "COMMIT;", "PRAGMA foreign_keys = ON;"].includes(statement));
      const migrations = await readD1Migrations("migrations");
      return {
        main: "./worker/index.ts",
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TEST_SEED_QUERIES: seedQueries,
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
