import { emitOfficialBrandPublicationImportSql } from "./official-brand-publication";

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function main(): Promise<void> {
  const directory = option("input");
  const outputPath = option("output");
  if (!directory || !outputPath) {
    throw new Error("Usage: pnpm data:brand-import-sql -- --input <publication-directory> --output <import.sql>");
  }
  process.stdout.write(`${JSON.stringify(await emitOfficialBrandPublicationImportSql({ directory, outputPath }), null, 2)}\n`);
}

if (process.argv[1]?.endsWith("emit-official-brand-import.ts")) {
  main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}
