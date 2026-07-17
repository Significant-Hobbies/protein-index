import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { auditDecisionDrift } from "./decision-drift-audit";

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function failureCategories(value: string | null): string[] {
  if (!value) return [];
  const categories = value.split(",").map((item) => item.trim()).filter(Boolean);
  return [...new Set(categories)].sort();
}

async function main(): Promise<void> {
  const artifactDirectory = resolve(requiredOption("artifact"));
  const bundlesDirectory = resolve(option("bundles") ?? "review-decisions");
  const output = option("output");
  const failOn = failureCategories(option("fail-on"));
  const report = await auditDecisionDrift({ artifactDirectory, bundlesDirectory });
  const classificationCounts: Record<string, number> = report.classificationCounts;
  const availableCategories = new Set([
    ...Object.keys(classificationCounts),
    "unreviewed_current_candidate",
  ]);
  const unknownCategories = failOn.filter((category) => !availableCategories.has(category));
  if (unknownCategories.length > 0) {
    throw new Error(`Unknown --fail-on categories: ${unknownCategories.join(", ")}`);
  }
  const policyFailures = failOn.filter((category) => category === "unreviewed_current_candidate"
    ? report.unreviewedCurrentCandidates.length > 0
    : (classificationCounts[category] ?? 0) > 0);
  const result = { ...report, policy: { failOn, failures: policyFailures, passed: !report.hasHardFailure && policyFailures.length === 0 } };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (output) {
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, "utf8");
  }
  process.stdout.write(json);
  process.stderr.write([
    `Decision drift audit: ${report.artifact.fieldFamily} ${report.artifact.adapterVersion}`,
    `${report.inputs.uniqueDecisions} unique decisions from ${report.inputs.bundleCount} bundles`,
    `${report.unreviewedCurrentCandidates.length} current candidates without a decision`,
    report.hasHardFailure ? `${report.conflicts.length} hard conflicts` : "no hard conflicts",
    policyFailures.length > 0 ? `policy failures: ${policyFailures.join(", ")}` : "policy passed",
  ].join("; ") + "\n");
  if (result.policy.passed === false) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exitCode = 1;
});
