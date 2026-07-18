import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { assertDataKartConfigured, DATAKART_ADAPTER_STATUS } from "./adapters/datakart";
import { stageOpenFoodFacts } from "./adapters/open-food-facts";
import { enrichOpenFoodFactsApi } from "./adapters/open-food-facts-api";
import { extractRobotoffApi, validateRobotoffNutritionArtifact } from "./adapters/robotoff-api";
import { extractRobotoffIngredientApi, validateRobotoffIngredientArtifact } from "./adapters/robotoff-ingredients-api";
import { buildFixtureStage } from "./fixtures";
import { emitImportSql } from "./reconcile";
import {
  assertAutomaticPublicationPostconditions,
  assertNoPendingD1Migrations,
  parsePublicationState,
  publicationStateQuery,
  validateAutomaticPublicationSnapshot,
  validatePublicationSnapshot,
  type AutomaticPublicationSnapshot,
  type AutomaticPublicationContract,
  type PublicationState,
} from "./publication";
import {
  emitReviewDecisionSql,
  emitReviewExistingDecisionQuery,
  emitReviewPostconditionQuery,
  emitReviewPublicationStateQuery,
  emitReviewSourceStateQuery,
  evidenceDecisionFromDatabaseRow,
  readReviewDecisionBundle,
  validateReviewPostconditions,
  validateReviewExistingDecisionState,
  validateReviewPublicationState,
  validateReviewSourceState,
  writeReviewDecisionBundle,
} from "./review-bundles";
import {
  generateExactLabelReattestation,
} from "./reattest-decisions";
import {
  liveNutritionSelectionQuery,
  prepareLiveNutritionSelection,
} from "./live-nutrition-selection";
import {
  emitGuardedSuccessorPublication,
  parseVerifiedProductState,
  verifiedProductStateQuery,
  writeExpectedVerifiedProductState,
} from "./guarded-publication";

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function run(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-20_000);
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? "unknown"}: ${stderr.trim()}`)));
  });
}

async function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-20_000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(stdout) : reject(new Error(`${command} exited with ${code ?? "unknown"}: ${stderr.trim()}`)));
  });
}

async function splitSqlFile(inputPath: string, maxBytes = 60_000): Promise<string[]> {
  const directory = `${inputPath}.chunks-${Date.now()}`;
  await mkdir(directory, { recursive: true });
  const chunks: string[] = [];
  let statements: string[] = [];
  let bytes = 0;
  const flush = async (): Promise<void> => {
    if (statements.length === 0) return;
    const path = join(directory, `${String(chunks.length + 1).padStart(5, "0")}.sql`);
    await writeFile(path, `${statements.join("\n")}\n`, "utf8");
    chunks.push(path);
    statements = [];
    bytes = 0;
  };
  const lines = createInterface({ input: createReadStream(inputPath), crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "BEGIN IMMEDIATE;" || trimmed === "COMMIT;") continue;
    const lineBytes = Buffer.byteLength(line) + 1;
    if (bytes > 0 && bytes + lineBytes > maxBytes) await flush();
    statements.push(line);
    bytes += lineBytes;
  }
  await flush();
  return chunks;
}

async function applyLocal(importSqlPath: string, persistTo?: string): Promise<void> {
  const persistence = persistTo ? ["--persist-to", persistTo] : [];
  await run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "protein-index", "--local", ...persistence]);
  const chunks = await splitSqlFile(importSqlPath);
  for (const chunk of chunks) {
    await run("pnpm", ["exec", "wrangler", "d1", "execute", "protein-index", "--local", ...persistence, "--file", chunk]);
  }
}

async function localImportCommand(): Promise<void> {
  const input = option("input");
  const persistTo = option("persist-to");
  if (!input || !persistTo) throw new Error("local-import requires --input <import.sql> and --persist-to <local-state-directory>.");
  await applyLocal(input, persistTo);
  process.stdout.write(`${JSON.stringify({ input, persistTo, target: "local" })}\n`);
}

async function stageCommand(): Promise<void> {
  const source = option("source") ?? "open-food-facts";
  if (source === "datakart") assertDataKartConfigured();
  if (source !== "open-food-facts") throw new Error(`Unsupported source: ${source}`);
  const input = option("input");
  if (!input) throw new Error("--input is required for stage.");
  const mode = option("mode") === "production" ? "production" : "sample";
  const rawLimit = option("limit");
  const limit = rawLimit === null ? (mode === "sample" ? 100 : null) : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer.");
  const outputDirectory = option("output") ?? ".data/sync";
  const maximumDropPercent = Number(option("maximum-drop-percent") ?? "20");
  if (!Number.isFinite(maximumDropPercent) || maximumDropPercent < 0 || maximumDropPercent >= 100) {
    throw new Error("--maximum-drop-percent must be at least 0 and less than 100.");
  }
  const result = await stageOpenFoodFacts({
    input,
    outputDirectory,
    mode,
    limit,
    format: option("format") === "tsv" ? "tsv" : option("format") === "jsonl" ? "jsonl" : undefined,
    previousManifestPath: option("previous-manifest") ?? undefined,
    previousIndexPath: option("previous-index") ?? undefined,
    sourceUpdatedAt: option("source-updated-at"),
    maximumDropRatio: maximumDropPercent / 100,
  });
  const importSqlPath = join(outputDirectory, "import.sql");
  await emitImportSql({ stagedPath: result.stagedPath, manifestPath: result.manifestPath, outputPath: importSqlPath });
  if (hasFlag("apply-local")) await applyLocal(importSqlPath);
  process.stdout.write(`${JSON.stringify({ ...result, importSqlPath }, null, 2)}\n`);
}

async function seedCommand(): Promise<void> {
  const outputDirectory = ".data/fixture";
  await mkdir(outputDirectory, { recursive: true });
  const fixture = await buildFixtureStage(outputDirectory);
  const importSqlPath = join(outputDirectory, "import.sql");
  await emitImportSql({ stagedPath: fixture.stagedPath, manifestPath: fixture.manifestPath, outputPath: importSqlPath });
  await applyLocal(importSqlPath);
  process.stdout.write("Local fixture catalog migrated and seeded.\n");
}

async function enrichCommand(): Promise<void> {
  const input = option("input");
  const inputManifest = option("manifest");
  if (!input || !inputManifest) throw new Error("--input and --manifest are required for enrich.");
  const mode = option("mode") === "production" ? "production" : "sample";
  const rawLimit = option("limit");
  const limit = rawLimit === null ? (mode === "sample" ? 100 : null) : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer.");
  const batchSize = Number(option("batch-size") ?? "100");
  const minimumIntervalMs = Number(option("minimum-interval-ms") ?? "6500");
  const requestTimeoutMs = Number(option("request-timeout-ms") ?? "30000");
  const outputDirectory = option("output") ?? ".data/enrichment";
  const result = await enrichOpenFoodFactsApi({
    input,
    inputManifest,
    outputDirectory,
    mode,
    limit,
    batchSize,
    minimumIntervalMs,
    requestTimeoutMs,
  });
  const importSqlPath = join(outputDirectory, "import.sql");
  await emitImportSql({ stagedPath: result.stagedPath, manifestPath: result.manifestPath, outputPath: importSqlPath });
  process.stdout.write(`${JSON.stringify({ ...result, importSqlPath }, null, 2)}\n`);
}

async function extractCommand(): Promise<void> {
  const input = option("input");
  const inputManifest = option("manifest");
  if (!input || !inputManifest) throw new Error("--input and --manifest are required for extract.");
  const source = option("source") ?? "robotoff";
  if (!["robotoff", "robotoff-ingredients"].includes(source)) throw new Error(`Unsupported extraction source: ${source}`);
  const mode = option("mode") === "production" ? "production" : "sample";
  const rawLimit = option("limit");
  const limit = rawLimit === null ? (mode === "sample" ? 100 : null) : Number(rawLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit must be a positive integer.");
  const minimumIntervalMs = Number(option("minimum-interval-ms") ?? "1100");
  const requestTimeoutMs = Number(option("request-timeout-ms") ?? "30000");
  const confidenceThreshold = Number(option("confidence-threshold") ?? "0.85");
  const outputDirectory = option("output") ?? (source === "robotoff-ingredients" ? ".data/robotoff-ingredients" : ".data/robotoff");
  const result = source === "robotoff-ingredients"
    ? await extractRobotoffIngredientApi({
      input,
      inputManifest,
      outputDirectory,
      mode,
      limit,
      minimumIntervalMs,
      requestTimeoutMs,
      confidenceThreshold,
      maximumAttempts: Number(option("maximum-attempts") ?? "4"),
      retryBaseMs: Number(option("retry-base-ms") ?? "1500"),
      progress: (message) => process.stderr.write(`${message}\n`),
    })
    : await extractRobotoffApi({
      input,
      inputManifest,
      outputDirectory,
      mode,
      limit,
      minimumIntervalMs,
      requestTimeoutMs,
      confidenceThreshold,
      progress: (message) => process.stderr.write(`${message}\n`),
    });
  if (source === "robotoff-ingredients") await validateRobotoffIngredientArtifact(outputDirectory);
  else await validateRobotoffNutritionArtifact(outputDirectory);
  const importSqlPath = mode === "production" ? null : join(outputDirectory, "import.sql");
  if (importSqlPath) {
    await emitImportSql({ stagedPath: result.stagedPath, manifestPath: result.manifestPath, outputPath: importSqlPath });
  }
  process.stdout.write(`${JSON.stringify({ ...result, importSqlPath }, null, 2)}\n`);
}

async function coverageCommand(): Promise<void> {
  const directory = option("input") ?? ".data/sync";
  const [manifest, report] = await Promise.all([
    readFile(join(directory, "manifest.json"), "utf8"),
    readFile(join(directory, "report.json"), "utf8"),
  ]);
  process.stdout.write(`${JSON.stringify({ manifest: JSON.parse(manifest), report: JSON.parse(report) }, null, 2)}\n`);
}

async function publishCommand(): Promise<void> {
  const directory = option("input");
  if (!directory) throw new Error("--input is required for publish.");
  const remote = hasFlag("remote");
  const persistTo = option("persist-to");
  const automatic = hasFlag("automatic");
  const skipMigrations = hasFlag("skip-migrations");
  if (remote && !hasFlag("confirm-remote")) {
    throw new Error("Remote publication requires both --remote and --confirm-remote.");
  }
  if (persistTo && remote) {
    throw new Error("--persist-to is supported only for local publication.");
  }
  if (automatic && (!remote || !skipMigrations)) {
    throw new Error("Automatic publication requires --remote, --confirm-remote, and --skip-migrations.");
  }
  if (skipMigrations && !automatic) {
    throw new Error("--skip-migrations is restricted to the validated automatic publication mode.");
  }
  const snapshot = automatic
    ? await validateAutomaticPublicationSnapshot(directory, {
      workflowName: option("workflow-name") ?? "",
      runId: Number(option("upstream-run-id")),
      headSha: option("upstream-head-sha") ?? "",
      headBranch: option("upstream-head-branch") ?? "",
      repository: option("upstream-repository") ?? "",
      artifactName: option("artifact-name") ?? "",
      artifactDigest: option("artifact-digest") ?? "",
      artifactBytes: Number(option("artifact-bytes")),
    })
    : await validatePublicationSnapshot(directory);
  const automaticSnapshot = automatic ? snapshot as AutomaticPublicationSnapshot : null;
  const automaticContract: AutomaticPublicationContract | null = automaticSnapshot?.contract ?? null;
  const importSqlPath = join(directory, "import.sql");
  const generated = await emitImportSql({
    stagedPath: snapshot.stagedPath,
    manifestPath: snapshot.manifestPath,
    outputPath: importSqlPath,
    includeTransaction: !remote,
    applyEvidenceDecisions: !automatic,
    extraction: automaticSnapshot?.extractionImport ?? undefined,
  });
  const target = remote ? "--remote" : "--local";
  let before: PublicationState | null = null;
  if (automatic) {
    const migrationState = await runCapture("pnpm", ["exec", "wrangler", "d1", "migrations", "list", "protein-index", "--remote"]);
    assertNoPendingD1Migrations(migrationState);
    before = parsePublicationState(await runCapture("pnpm", [
      "exec", "wrangler", "d1", "execute", "protein-index", "--remote", "--json", "--command", publicationStateQuery(snapshot.manifest, snapshot.exactExtraction),
    ]));
  } else {
    await run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "protein-index", target]);
  }
  if (remote) {
    await run("pnpm", ["exec", "wrangler", "d1", "execute", "protein-index", "--remote", "--yes", "--file", importSqlPath]);
  } else {
    const chunks = await splitSqlFile(importSqlPath);
    for (const chunk of chunks) await run("pnpm", ["exec", "wrangler", "d1", "execute", "protein-index", "--local", ...(persistTo ? ["--persist-to", persistTo] : []), "--file", chunk]);
  }
  let automaticEvidence: Record<string, unknown> | null = null;
  let products: number;
  let sourceRecords: number;
  let completedRuns: number | null = null;
  if (automatic && before) {
    const after = parsePublicationState(await runCapture("pnpm", [
      "exec", "wrangler", "d1", "execute", "protein-index", "--remote", "--json", "--command", publicationStateQuery(snapshot.manifest, snapshot.exactExtraction),
    ]));
    const postconditions = assertAutomaticPublicationPostconditions(
      before,
      after,
      snapshot.manifest,
      snapshot.exactExtraction,
      automaticContract,
    );
    products = after.products;
    sourceRecords = after.sourceRecords;
    if (!automaticContract) throw new Error("Automatic publication contract was not retained after validation");
    automaticEvidence = { contract: automaticContract, before, after, postconditions };
  } else {
    const rawVerification = await runCapture("pnpm", [
      "exec", "wrangler", "d1", "execute", "protein-index", target, "--json", "--command",
      "SELECT COUNT(*) AS products FROM products WHERE is_active = 1; SELECT COUNT(*) AS completed_runs FROM ingestion_runs WHERE status = 'completed'; SELECT COUNT(*) AS source_records FROM source_records;",
    ]);
    const verification = JSON.parse(rawVerification) as Array<{ success?: boolean; results?: Array<Record<string, number>> }>;
    products = verification[0]?.results?.[0]?.products ?? 0;
    completedRuns = verification[1]?.results?.[0]?.completed_runs ?? 0;
    sourceRecords = verification[2]?.results?.[0]?.source_records ?? 0;
    if (products <= 0 || completedRuns <= 0 || sourceRecords <= 0) throw new Error("Post-publication D1 verification returned an empty catalog or evidence ledger.");
  }
  process.stdout.write(`${JSON.stringify({
    target: remote ? "remote" : "local",
    mode: automatic ? "automatic_evidence" : "manual",
    snapshot: snapshot.manifest.inputHash,
    runId: generated.runId,
    stagedRecords: snapshot.manifest.stagedRecords,
    generatedProducts: generated.products,
    products,
    completedRuns,
    sourceRecords,
    automaticEvidence,
  }, null, 2)}\n`);
}

async function reviewExportCommand(): Promise<void> {
  const raw = await runCapture("pnpm", [
    "exec", "wrangler", "d1", "execute", "protein-index", "--local", "--json", "--command",
    `SELECT id, source_id, source_record_key, source_record_id, source_content_hash, product_id,
      candidate_hash, field_family, decision, payload_json, evidence_url, rationale, decided_by, decided_at,
      extraction_attempt_id, label_asset_id
      FROM evidence_decisions WHERE active = 1 ORDER BY id;`,
  ]);
  const response = JSON.parse(raw) as Array<{ success?: boolean; results?: Array<Record<string, unknown>> }>;
  if (response[0]?.success !== true || !Array.isArray(response[0].results)) {
    throw new Error("Local evidence decision query did not return a valid result");
  }
  const decisions = response[0].results.map(evidenceDecisionFromDatabaseRow);
  const bundle = await writeReviewDecisionBundle({
    decisions,
    outputRoot: option("output") ?? "review-decisions",
  });
  process.stdout.write(`${JSON.stringify({
    directory: bundle.directory,
    bundleId: bundle.manifest.bundleId,
    decisionCount: bundle.manifest.decisionCount,
    ledgerSha256: bundle.manifest.ledgerSha256,
  }, null, 2)}\n`);
}

async function reviewReattestCommand(): Promise<void> {
  const artifactDirectory = option("artifact");
  const bundlesDirectory = option("bundles");
  const activeSetFile = option("active-set");
  const family = option("family");
  const expectedDecisionCount = Number(option("expected-count"));
  const outputRoot = option("output");
  const decidedBy = option("decided-by");
  const decidedAt = option("decided-at");
  const confirmation = option("confirmation");
  if (!artifactDirectory || !bundlesDirectory || !activeSetFile || !family || !outputRoot
    || !decidedBy || !decidedAt || !confirmation || !Number.isSafeInteger(expectedDecisionCount) || expectedDecisionCount <= 0) {
    throw new Error("review-reattest requires --artifact, --bundles, --active-set, --family, --expected-count, --output, --decided-by, --decided-at, and --confirmation");
  }
  if (family !== "nutrition" && family !== "ingredients") throw new Error("--family must be nutrition or ingredients");
  const report = await generateExactLabelReattestation({
    artifactDirectory,
    bundlesDirectory,
    activeSetFile,
    fieldFamily: family,
    expectedDecisionCount,
    outputRoot,
    decidedBy,
    decidedAt,
    confirmation,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function liveNutritionSelectionCommand(command: "review-live-selection-query" | "review-live-selection-prepare"): Promise<void> {
  const output = option("output");
  if (!output) throw new Error(`${command} requires --output`);
  if (command === "review-live-selection-query") {
    await writeFile(output, `${liveNutritionSelectionQuery()}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ command, output }, null, 2)}\n`);
    return;
  }
  const publishedBundleIds = (option("published-bundles") ?? "").split(",").map((value) => value.trim()).filter(Boolean).sort();
  const artifactDirectory = option("artifact");
  const bundlesDirectory = option("bundles");
  const activeSetFile = option("active-set");
  const stateFile = option("state");
  const scratchRoot = option("scratch");
  const expectedSelected = Number(option("expected-selected"));
  const expectedEligible = Number(option("expected-eligible"));
  const expectedPending = Number(option("expected-pending"));
  const expectedCandidateDriftId = option("expected-candidate-drift-id");
  const expectedMissingId = option("expected-missing-id");
  if (!artifactDirectory || !bundlesDirectory || !activeSetFile || !stateFile || !scratchRoot
    || !expectedCandidateDriftId || !expectedMissingId || publishedBundleIds.length === 0
    || !Number.isSafeInteger(expectedSelected) || expectedSelected <= 0
    || !Number.isSafeInteger(expectedEligible) || expectedEligible <= 0
    || !Number.isSafeInteger(expectedPending) || expectedPending <= 0) {
    throw new Error("review-live-selection-prepare requires exact artifact, bundle, active-set, state, scratch, output, published-bundle, count, and exception inputs");
  }
  const report = await prepareLiveNutritionSelection({
    artifactDirectory,
    bundlesDirectory,
    activeSetFile,
    publishedBundleIds,
    stateFile,
    outputRoot: output,
    scratchRoot,
    expectedSelected,
    expectedEligible,
    expectedPending,
    expectedCandidateDriftId,
    expectedMissingId,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function guardedReleasePrepareCommand(): Promise<void> {
  const artifactDirectory = option("artifact");
  const bundleDirectory = option("bundle");
  const fieldFamily = option("family");
  const output = option("output");
  const scratch = option("scratch");
  const beforeNutrition = option("before-nutrition");
  const beforeIngredients = option("before-ingredients");
  const afterNutrition = option("after-nutrition");
  const afterIngredients = option("after-ingredients");
  const expectedDecisionCount = Number(option("expected-count"));
  const expectedVerifyCount = Number(option("expected-verify-count"));
  if (!artifactDirectory || !bundleDirectory || !output || !scratch || !beforeNutrition || !beforeIngredients
    || !afterNutrition || !afterIngredients || (fieldFamily !== "nutrition" && fieldFamily !== "ingredients")
    || !Number.isSafeInteger(expectedDecisionCount) || expectedDecisionCount <= 0
    || !Number.isSafeInteger(expectedVerifyCount) || expectedVerifyCount <= 0) {
    throw new Error("guarded-release-prepare requires exact artifact, bundle, family, state, count, scratch, and output inputs");
  }
  const snapshot = await validateAutomaticPublicationSnapshot(artifactDirectory, {
    workflowName: option("workflow-name") ?? "",
    runId: Number(option("upstream-run-id")),
    headSha: option("upstream-head-sha") ?? "",
    headBranch: option("upstream-head-branch") ?? "",
    repository: option("upstream-repository") ?? "",
    artifactName: option("artifact-name") ?? "",
    artifactDigest: option("artifact-digest") ?? "",
    artifactBytes: Number(option("artifact-bytes")),
  });
  if (!snapshot.extractionImport) throw new Error("Guarded successor publication requires exact extraction evidence");
  const bundle = await readReviewDecisionBundle(bundleDirectory);
  await mkdir(scratch, { recursive: true });
  const artifactSqlPath = join(scratch, "artifact-mutations.sql");
  const successorSqlPath = join(scratch, "successor-mutations.sql");
  await emitImportSql({
    stagedPath: snapshot.stagedPath,
    manifestPath: snapshot.manifestPath,
    outputPath: artifactSqlPath,
    includeTransaction: false,
    includePragma: false,
    applyEvidenceDecisions: false,
    extraction: snapshot.extractionImport,
  });
  await emitReviewDecisionSql(bundle, successorSqlPath, { composed: true });
  await emitGuardedSuccessorPublication({
    fieldFamily,
    artifactSqlPath,
    successorSqlPath,
    outputPath: output,
    successor: bundle,
    before: {
      nutrition: parseVerifiedProductState("nutrition", JSON.parse(await readFile(beforeNutrition, "utf8")) as unknown),
      ingredients: parseVerifiedProductState("ingredients", JSON.parse(await readFile(beforeIngredients, "utf8")) as unknown),
    },
    expectedAfter: {
      nutrition: parseVerifiedProductState("nutrition", JSON.parse(await readFile(afterNutrition, "utf8")) as unknown),
      ingredients: parseVerifiedProductState("ingredients", JSON.parse(await readFile(afterIngredients, "utf8")) as unknown),
    },
    expectedDecisionCount,
    expectedVerifyCount,
  });
  process.stdout.write(`${JSON.stringify({
    output,
    fieldFamily,
    bundleId: bundle.manifest.bundleId,
    decisionCount: bundle.manifest.decisionCount,
    verifyCount: bundle.manifest.verifyCount,
    artifact: snapshot.manifest.inputHash,
    extractionRunId: snapshot.exactExtraction?.extractionRunId ?? null,
  }, null, 2)}\n`);
}

async function guardedReleaseStateQueryCommand(): Promise<void> {
  const fieldFamily = option("family");
  const output = option("output");
  if (!output || (fieldFamily !== "nutrition" && fieldFamily !== "ingredients")) {
    throw new Error("guarded-release-state-query requires --family nutrition|ingredients and --output");
  }
  await writeFile(output, `${verifiedProductStateQuery(fieldFamily)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, fieldFamily }, null, 2)}\n`);
}

async function guardedReleaseFinalStateCommand(): Promise<void> {
  const bundleDirectory = option("bundle");
  const fieldFamily = option("family");
  const output = option("output");
  if (!bundleDirectory || !output || (fieldFamily !== "nutrition" && fieldFamily !== "ingredients")) {
    throw new Error("guarded-release-final-state requires --bundle, --family nutrition|ingredients, and --output");
  }
  const state = await writeExpectedVerifiedProductState(await readReviewDecisionBundle(bundleDirectory), fieldFamily, output);
  process.stdout.write(`${JSON.stringify({ output, fieldFamily, verifiedProducts: state.productIds.length }, null, 2)}\n`);
}

async function reviewBundleCommand(command: "review-query" | "review-source-check" | "review-prepare" | "review-postquery" | "review-postcheck"): Promise<void> {
  const directory = option("input");
  const output = option("output");
  if (!directory || !output) throw new Error("--input and --output are required for review publication commands.");
  const bundle = await readReviewDecisionBundle(directory);
  const expectedLedgerHash = option("expected-ledger-hash");
  if (expectedLedgerHash !== null && bundle.manifest.ledgerSha256 !== expectedLedgerHash) {
    throw new Error("Review bundle ledger hash differs from the explicitly requested hash");
  }
  if (command === "review-query") {
    const kind = option("kind") ?? "combined";
    if (kind === "source") await emitReviewSourceStateQuery(bundle, output);
    else if (kind === "decisions") await emitReviewExistingDecisionQuery(bundle, output);
    else if (kind === "combined") await emitReviewPublicationStateQuery(bundle, output);
    else throw new Error("--kind must be source, decisions, or combined");
  } else if (command === "review-source-check") {
    const statePath = option("state");
    if (!statePath) throw new Error("--state is required for review-source-check.");
    validateReviewSourceState(bundle, JSON.parse(await readFile(statePath, "utf8")) as unknown);
    await writeFile(output, `${JSON.stringify({ ledgerSha256: bundle.manifest.ledgerSha256, sourceRecords: bundle.manifest.sourceRecordCount }, null, 2)}\n`, "utf8");
  } else if (command === "review-prepare") {
    const statePath = option("state");
    const sourceStatePath = option("source-state");
    const decisionStatePath = option("decision-state");
    if (statePath) {
      validateReviewPublicationState(bundle, JSON.parse(await readFile(statePath, "utf8")) as unknown);
    } else if (sourceStatePath && decisionStatePath) {
      validateReviewSourceState(bundle, JSON.parse(await readFile(sourceStatePath, "utf8")) as unknown);
      validateReviewExistingDecisionState(bundle, JSON.parse(await readFile(decisionStatePath, "utf8")) as unknown);
    } else {
      throw new Error("review-prepare requires --state or both --source-state and --decision-state.");
    }
    const plan = await emitReviewDecisionSql(bundle, output, false);
    const planPath = option("plan");
    if (planPath) await writeFile(planPath, `${JSON.stringify({ ...plan, ledgerSha256: bundle.manifest.ledgerSha256 }, null, 2)}\n`, "utf8");
  } else if (command === "review-postquery") {
    await emitReviewPostconditionQuery(bundle, output);
  } else {
    const statePath = option("state");
    if (!statePath) throw new Error("--state is required for review-postcheck.");
    const report = validateReviewPostconditions(bundle, JSON.parse(await readFile(statePath, "utf8")) as unknown);
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify({ command, bundleId: bundle.manifest.bundleId, ledgerSha256: bundle.manifest.ledgerSha256, output }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "stage") return stageCommand();
  if (command === "enrich") return enrichCommand();
  if (command === "extract") return extractCommand();
  if (command === "local-import") return localImportCommand();
  if (command === "seed") return seedCommand();
  if (command === "coverage") return coverageCommand();
  if (command === "publish") return publishCommand();
  if (command === "review-export") return reviewExportCommand();
  if (command === "review-reattest") return reviewReattestCommand();
  if (command === "review-live-selection-query" || command === "review-live-selection-prepare") {
    return liveNutritionSelectionCommand(command);
  }
  if (command === "guarded-release-prepare") return guardedReleasePrepareCommand();
  if (command === "guarded-release-state-query") return guardedReleaseStateQueryCommand();
  if (command === "guarded-release-final-state") return guardedReleaseFinalStateCommand();
  if (command === "review-query" || command === "review-source-check" || command === "review-prepare" || command === "review-postquery" || command === "review-postcheck") {
    return reviewBundleCommand(command);
  }
  if (command === "datakart-status") {
    process.stdout.write(`${JSON.stringify(DATAKART_ADAPTER_STATUS, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: sync.ts <stage|enrich|extract|local-import|seed|coverage|publish|review-export|review-reattest|review-live-selection-query|review-live-selection-prepare|guarded-release-prepare|guarded-release-state-query|guarded-release-final-state|review-query|review-source-check|review-prepare|review-postquery|review-postcheck|datakart-status> [options]");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : null;
  process.stderr.write(`${JSON.stringify({ error: message, stack })}\n`);
  process.exitCode = 1;
});
