import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { emptyNutrition, hasNutritionErrors, validateNutrition } from "../shared/nutrition";
import type { NutritionPer100g } from "../shared/types";

export const MACHINE_LABEL_ADAPTER_VERSION = "machine-label-v10";
export const MACHINE_LABEL_MODEL = "qwen3-vl:32b-instruct";
export const MACHINE_LABEL_MODEL_TIMEOUT_MS = 120_000;

type Basis = "per_100g" | "per_100ml" | "unknown";
type DeclaredBasis = Basis | "per_serving";
type NutritionKey = keyof NutritionPer100g;

export interface VisionLine {
  text: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface VisionResult {
  engine: "macos_vision";
  version: string;
  lines: VisionLine[];
}

export interface ModelResult {
  model: string;
  digest: string;
  promptHash: string;
  raw: string;
  basis: DeclaredBasis;
  servingSizeGrams: number | null;
  nutrition: NutritionPer100g;
  ingredientsRaw: string | null;
  unreadableFields: string[];
}

export interface MachineVerificationOutcome {
  accepted: boolean;
  reasons: string[];
  basis: Basis;
  nutrition: NutritionPer100g | null;
  ingredientsRaw: string | null;
}

export interface MachineLabelArtifact {
  schemaVersion: 1;
  adapterVersion: typeof MACHINE_LABEL_ADAPTER_VERSION;
  image: { path: string; contentSha256: string; byteLength: number };
  generatedAt: string;
  vision: VisionResult;
  model: ModelResult;
  nutrition: MachineVerificationOutcome;
  ingredients: MachineVerificationOutcome;
}

const NUTRITION_FIELDS: NutritionKey[] = [
  "calories", "proteinGrams", "carbohydrateGrams", "sugarGrams",
  "fatGrams", "saturatedFatGrams", "fibreGrams", "sodiumMg",
];

const MODEL_PROMPT = `Read this food package label. Return only JSON with exactly these keys:
{
  "basis":"per_100g"|"per_100ml"|"per_serving"|"unknown",
  "serving_size_g":number|null,
  "calories_kcal":number|null,
  "protein_g":number|null,
  "carbohydrate_g":number|null,
  "sugars_g":number|null,
  "fat_g":number|null,
  "saturated_fat_g":number|null,
  "fibre_g":number|null,
  "sodium_mg":number|null,
  "ingredients_raw":string|null,
  "unreadable_fields":string[]
}
Use only visibly declared text. Do not repair, infer, or use outside knowledge. kJ is not kcal. Return null for unreadable values. Copy ingredients only when the entire INGREDIENTS declaration is visible.`;

const MODEL_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "basis", "calories_kcal", "protein_g", "carbohydrate_g", "sugars_g", "fat_g",
    "saturated_fat_g", "fibre_g", "sodium_mg", "ingredients_raw", "unreadable_fields", "serving_size_g",
  ],
  properties: {
    basis: { type: "string", enum: ["per_100g", "per_100ml", "per_serving", "unknown"] },
    serving_size_g: { type: ["number", "null"], exclusiveMinimum: 0 },
    calories_kcal: { type: ["number", "null"], minimum: 0 },
    protein_g: { type: ["number", "null"], minimum: 0 },
    carbohydrate_g: { type: ["number", "null"], minimum: 0 },
    sugars_g: { type: ["number", "null"], minimum: 0 },
    fat_g: { type: ["number", "null"], minimum: 0 },
    saturated_fat_g: { type: ["number", "null"], minimum: 0 },
    fibre_g: { type: ["number", "null"], minimum: 0 },
    sodium_mg: { type: ["number", "null"], minimum: 0 },
    ingredients_raw: { type: ["string", "null"] },
    unreadable_fields: { type: "array", items: { type: "string" } },
  },
} as const;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function basis(value: unknown): DeclaredBasis {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "per_100g" || normalized === "per_100ml" || normalized === "per_serving" ? normalized : "unknown";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function textFor(lines: VisionLine[]): string {
  return lines.map((line) => line.text).join("\n");
}

function numericLine(line: VisionLine): number | null {
  const candidate = /^\s*(?:<\s*)?(\d+(?:\.\d+)?)(?:\s*(?:kcal|g|mg))?\s*$/i.exec(line.text);
  return candidate ? Number(candidate[1]) : null;
}

function visionNumber(lines: VisionLine[], expression: RegExp, label: RegExp): number | null {
  // Keep a row's values together. Vision does not guarantee reading order for
  // multi-column tables, so a bare next-line number can belong to another row.
  for (const line of lines) {
    const match = expression.exec(line.text);
    if (match) {
      const value = match.slice(1).find((entry) => entry !== undefined);
      if (value !== undefined) return Number(value);
    }
  }
  const labelRows = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => label.test(line.text));
  const candidates = lines
    .map((line, index) => ({ line, index, value: numericLine(line) }))
    .filter((value): value is { line: VisionLine; index: number; value: number } => value.value !== null);
  for (const row of labelRows) {
    const sameRow = candidates
      .filter((candidate) => candidate.line.boundingBox.x > row.line.boundingBox.x + 0.01
        && Math.abs(candidate.line.boundingBox.y - row.line.boundingBox.y) < 0.04)
      .sort((left, right) =>
        left.line.boundingBox.x - right.line.boundingBox.x
        || Math.abs(left.line.boundingBox.y - row.line.boundingBox.y) - Math.abs(right.line.boundingBox.y - row.line.boundingBox.y)
        || Math.abs(left.index - row.index) - Math.abs(right.index - row.index));
    if (sameRow[0]) return sameRow[0].value;
    const vertical = candidates
      .filter((candidate) => candidate.index > row.index && Math.abs(candidate.line.boundingBox.y - row.line.boundingBox.y) < 0.12)
      .sort((left, right) => left.index - right.index);
    if (vertical[0]) return vertical[0].value;
  }
  return null;
}

function spatialPer100Basis(lines: VisionLine[]): Basis {
  const perHeaders = lines.filter((line) => /^(?:amount\s+)?per$/i.test(line.text.trim()));
  const unitHeaders = lines.filter((line) => /^100\s*(g|ml)$/i.exec(line.text.trim()));
  for (const per of perHeaders) for (const unit of unitHeaders) {
    if (Math.abs(per.boundingBox.x - unit.boundingBox.x) > 0.12 || Math.abs(per.boundingBox.y - unit.boundingBox.y) > 0.12) continue;
    return /ml$/i.test(unit.text.trim()) ? "per_100ml" : "per_100g";
  }
  return "unknown";
}

/** Deterministic parser; it intentionally returns null rather than guessing a layout it cannot prove. */
export function parseVisionNutrition(lines: VisionLine[]): { basis: DeclaredBasis; servingSizeGrams: number | null; nutrition: NutritionPer100g } {
  const text = textFor(lines);
  const output = emptyNutrition();
  const per100 = /\b(?:per|\/)[\s-]*100\s*(g|ml)\b/i.exec(text);
  const spatialBasis = spatialPer100Basis(lines);
  const servingSize = /\bserving\s*size\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*g\b/i.exec(text);
  const parsedBasis: DeclaredBasis = per100?.[1]?.toLowerCase() === "ml" ? "per_100ml" : per100 ? "per_100g" : spatialBasis !== "unknown" ? spatialBasis : /\bper\s*(?:serve|serving)\b/i.test(text) ? "per_serving" : "unknown";
  output.calories = visionNumber(lines, /(?:energy|energy value)(?:[^\n]{0,100}?(\d+(?:\.\d+)?)\s*kcal\b|\s*\(\s*kcal\s*\)\s*(\d+(?:\.\d+)?))/i, /(?:energy|energy value)/i);
  output.proteinGrams = visionNumber(lines, /\bprotein(?:\s*\([^\n)]*\))?(?:[^\n]{0,36}?(\d+(?:\.\d+)?)\s*g\b|\s*\(\s*g\s*\)\s*(\d+(?:\.\d+)?))/i, /\bprotein\b/i);
  output.carbohydrateGrams = visionNumber(lines, /\b(?:total )?carbohydrate[^\n]{0,36}?(\d+(?:\.\d+)?)\s*g\b/i, /\b(?:total )?carbohydrate/i);
  output.sugarGrams = visionNumber(lines, /\b(?:total )?sugars?[^\n]{0,36}?(\d+(?:\.\d+)?)\s*g\b/i, /\b(?:total )?sugars?\b/i);
  output.fatGrams = visionNumber(lines, /(?:^|[•\n])\s*(?:total )?fat\b[^\n]{0,36}?(\d+(?:\.\d+)?)\s*g\b/im, /\b(?:total )?fat\b/i);
  output.saturatedFatGrams = visionNumber(lines, /\bsaturat(?:ed|es)[^\n]{0,36}?(\d+(?:\.\d+)?)\s*g\b/i, /\bsaturat(?:ed|es)/i);
  output.fibreGrams = visionNumber(lines, /\bfib(?:er|re)[^\n]{0,36}?(\d+(?:\.\d+)?)\s*g\b/i, /\bfib(?:er|re)/i);
  output.sodiumMg = visionNumber(lines, /\bsodium[^\n]{0,36}?(\d+(?:\.\d+)?)\s*mg\b/i, /\bsodium/i);
  return { basis: parsedBasis, servingSizeGrams: servingSize ? Number(servingSize[1]) : null, nutrition: output };
}

function modelNutrition(input: Record<string, unknown>): NutritionPer100g {
  return {
    calories: finite(input.calories_kcal),
    proteinGrams: finite(input.protein_g),
    carbohydrateGrams: finite(input.carbohydrate_g),
    sugarGrams: finite(input.sugars_g),
    fatGrams: finite(input.fat_g),
    saturatedFatGrams: finite(input.saturated_fat_g),
    fibreGrams: finite(input.fibre_g),
    sodiumMg: finite(input.sodium_mg),
  };
}

function sameNumber(left: number | null, right: number | null): boolean {
  return left !== null && right !== null && Math.abs(left - right) < 0.000_001;
}

function normalizeComparableNutrition(input: { basis: DeclaredBasis; servingSizeGrams: number | null; nutrition: NutritionPer100g }): { basis: Basis; nutrition: NutritionPer100g } | null {
  if (input.basis === "per_100g" || input.basis === "per_100ml") return { basis: input.basis, nutrition: input.nutrition };
  if (input.basis !== "per_serving" || input.servingSizeGrams === null || !Number.isFinite(input.servingSizeGrams) || input.servingSizeGrams <= 0) return null;
  const factor = 100 / input.servingSizeGrams;
  return {
    basis: "per_100g",
    nutrition: Object.fromEntries(Object.entries(input.nutrition).map(([field, value]) => [field, value === null ? null : value * factor])) as unknown as NutritionPer100g,
  };
}

const FIELD_LABELS: Record<NutritionKey, RegExp> = {
  calories: /(?:energy|energy value)/i,
  proteinGrams: /\bprotein\b/i,
  carbohydrateGrams: /\b(?:total )?carbohydrate/i,
  sugarGrams: /\b(?:total )?sugars?\b/i,
  fatGrams: /\b(?:total )?fat\b/i,
  saturatedFatGrams: /\bsaturat(?:ed|es)/i,
  fibreGrams: /\bfib(?:er|re)/i,
  sodiumMg: /\bsodium\b/i,
};

function visionFieldIsQualified(lines: VisionLine[], field: NutritionKey): boolean {
  return lines.some((line) => {
    const match = FIELD_LABELS[field].exec(line.text);
    return Boolean(match && /(?:<|less than)\s*\d/i.test(line.text.slice(match.index + match[0].length, match.index + match[0].length + 24)));
  });
}

function visibleBounds(lines: VisionLine[], expression: RegExp): boolean {
  const matched = lines.filter((line) => expression.test(line.text));
  return matched.length > 0 && matched.every(({ boundingBox }) =>
    boundingBox.x > 0.01
    && boundingBox.y > 0.01
    && boundingBox.x + boundingBox.width < 0.99
    && boundingBox.y + boundingBox.height < 0.99,
  );
}

function parseVisionIngredients(lines: VisionLine[]): string | null {
  const text = textFor(lines);
  const terminator = /\n\s*(?:contains|allergen|nutritional?|approximate composition|storage|directions|warning|disclaimer)\b/i;
  const match = /\bingredients\s*:\s*([\s\S]*?)(?=\n\s*(?:contains|allergen|nutritional?|approximate composition|storage|directions|warning|disclaimer)\b|$)/i.exec(text);
  if (!match) return null;
  const declaration = normalizeText(match[1] ?? "");
  const after = text.slice((match.index ?? 0) + match[0].length);
  return declaration && (/[.!]$/.test(declaration) || terminator.test(after)) ? declaration : null;
}

export function decideMachineLabelEvidence(input: { vision: VisionResult; model: ModelResult }): {
  nutrition: MachineVerificationOutcome;
  ingredients: MachineVerificationOutcome;
} {
  const vision = parseVisionNutrition(input.vision.lines);
  const visionComparable = normalizeComparableNutrition(vision);
  const modelComparable = normalizeComparableNutrition({ basis: input.model.basis, servingSizeGrams: input.model.servingSizeGrams, nutrition: input.model.nutrition });
  const nutritionReasons: string[] = [];
  if (vision.basis === "unknown" || input.model.basis !== vision.basis) nutritionReasons.push("basis_disagreement");
  if (vision.basis === "per_serving" && !sameNumber(vision.servingSizeGrams, input.model.servingSizeGrams)) nutritionReasons.push("serving_size_disagreement");
  if (!visionComparable || !modelComparable || visionComparable.basis !== modelComparable.basis) nutritionReasons.push("basis_normalization_failed");
  for (const field of ["calories", "proteinGrams"] as const) {
    if (!visionComparable || !modelComparable || !sameNumber(visionComparable.nutrition[field], modelComparable.nutrition[field])) nutritionReasons.push(`core_${field}_disagreement`);
    if (visionFieldIsQualified(input.vision.lines, field)) nutritionReasons.push(`core_${field}_qualified`);
  }
  if (!visibleBounds(input.vision.lines, /(?:energy|protein)/i)) nutritionReasons.push("nutrition_text_edge_clipped");
  if (!modelComparable || hasNutritionErrors(validateNutrition(modelComparable.nutrition, modelComparable.basis === "per_100ml" ? "per_100ml" : "per_100g"))) {
    nutritionReasons.push("nutrition_validation_failed");
  }
  const nutritionAccepted = nutritionReasons.length === 0;
  const agreedNutrition = emptyNutrition();
  for (const field of NUTRITION_FIELDS) {
    if (visionComparable && modelComparable && sameNumber(visionComparable.nutrition[field], modelComparable.nutrition[field]) && !visionFieldIsQualified(input.vision.lines, field)) {
      agreedNutrition[field] = modelComparable.nutrition[field];
    }
  }

  const visionIngredients = parseVisionIngredients(input.vision.lines);
  const modelIngredients = input.model.ingredientsRaw === null ? null : normalizeText(input.model.ingredientsRaw);
  const ingredientReasons: string[] = [];
  if (!visionIngredients || !modelIngredients) ingredientReasons.push("ingredient_declaration_incomplete");
  if (visionIngredients && modelIngredients && visionIngredients.toLocaleLowerCase() !== modelIngredients.toLocaleLowerCase()) {
    ingredientReasons.push("ingredient_extractor_disagreement");
  }
  if (!visibleBounds(input.vision.lines, /\bingredients\b/i)) ingredientReasons.push("ingredient_text_edge_clipped");
  const ingredientsAccepted = ingredientReasons.length === 0;

  return {
    nutrition: {
      accepted: nutritionAccepted,
      reasons: nutritionReasons,
      basis: modelComparable?.basis ?? "unknown",
      // Do not turn a label qualifier such as "<0.1 g" into an exact value.
      // Optional fields are published only when the independent extractors
      // literally agree; acceptance itself only depends on the required core.
      nutrition: nutritionAccepted ? agreedNutrition : null,
      ingredientsRaw: null,
    },
    ingredients: {
      accepted: ingredientsAccepted,
      reasons: ingredientReasons,
      basis: "unknown",
      nutrition: null,
      ingredientsRaw: ingredientsAccepted ? modelIngredients : null,
    },
  };
}

export async function runMacOsVision(imagePath: string): Promise<VisionResult> {
  if (process.platform !== "darwin") throw new Error("macOS Vision OCR requires a macOS runner.");
  const source = `import Foundation\nimport Vision\nimport AppKit\nlet path = ProcessInfo.processInfo.environment[\"MACHINE_LABEL_IMAGE\"]!\nguard let image = NSImage(contentsOfFile: path), let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { fatalError(\"Unable to load image\") }\nlet request = VNRecognizeTextRequest { request, error in\n  if let error { fputs(\"\\(error)\", stderr); exit(1) }\n  let lines = (request.results as? [VNRecognizedTextObservation] ?? []).compactMap { observation -> [String: Any]? in\n    guard let candidate = observation.topCandidates(1).first else { return nil }\n    let box = observation.boundingBox\n    return [\"text\": candidate.string, \"confidence\": candidate.confidence, \"boundingBox\": [\"x\": box.origin.x, \"y\": box.origin.y, \"width\": box.width, \"height\": box.height]]\n  }\n  let output: [String: Any] = [\"engine\": \"macos_vision\", \"version\": \"VNRecognizeTextRequest.accurate\", \"lines\": lines]\n  let data = try! JSONSerialization.data(withJSONObject: output, options: [.sortedKeys])\n  FileHandle.standardOutput.write(data)\n}\nrequest.recognitionLevel = .accurate\nrequest.usesLanguageCorrection = false\nrequest.recognitionLanguages = [\"en-US\"]\ntry VNImageRequestHandler(cgImage: cg).perform([request])\n`;
  const raw = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn("swift", ["-"], { env: { ...process.env, MACHINE_LABEL_IMAGE: resolve(imagePath) }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveOutput(stdout) : reject(new Error(`macOS Vision exited with ${code ?? "unknown"}: ${stderr.trim()}`)));
    child.stdin.end(source);
  });
  const parsed = record(JSON.parse(raw));
  const lines = Array.isArray(parsed?.lines) ? parsed.lines.map((value): VisionLine => {
    const line = record(value);
    const box = record(line?.boundingBox);
    if (!box || typeof line?.text !== "string" || !Number.isFinite(line.confidence)
      || !Number.isFinite(box.x) || !Number.isFinite(box.y) || !Number.isFinite(box.width) || !Number.isFinite(box.height)) {
      throw new Error("macOS Vision returned an invalid OCR line.");
    }
    return { text: line.text, confidence: Number(line.confidence), boundingBox: { x: Number(box.x), y: Number(box.y), width: Number(box.width), height: Number(box.height) } };
  }) : null;
  if (!lines) throw new Error("macOS Vision returned no OCR lines.");
  return { engine: "macos_vision", version: typeof parsed?.version === "string" ? parsed.version : "unknown", lines };
}

export async function runQwenLabel(imageBytes: Uint8Array, endpoint = "http://127.0.0.1:11434", timeoutMilliseconds = MACHINE_LABEL_MODEL_TIMEOUT_MS): Promise<ModelResult> {
  if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1 || timeoutMilliseconds > 300_000) {
    throw new RangeError("Local model timeout must be between 1 and 300000 milliseconds.");
  }
  const tagResponse = await fetch(`${endpoint}/api/tags`);
  if (!tagResponse.ok) throw new Error(`Ollama model listing failed with ${tagResponse.status}.`);
  const tags = record(await tagResponse.json());
  const model = Array.isArray(tags?.models) ? tags.models.map(record).find((entry) => entry?.name === MACHINE_LABEL_MODEL) : null;
  if (!model || typeof model.digest !== "string") throw new Error(`${MACHINE_LABEL_MODEL} is not installed locally.`);
  const response = await fetch(`${endpoint}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMilliseconds),
    body: JSON.stringify({ model: MACHINE_LABEL_MODEL, stream: false, format: MODEL_RESULT_SCHEMA, think: false, options: { temperature: 0, num_ctx: 8192 }, messages: [{ role: "user", content: MODEL_PROMPT, images: [Buffer.from(imageBytes).toString("base64")] }] }),
  });
  if (!response.ok) throw new Error(`Ollama label extraction failed with ${response.status}.`);
  const body = record(await response.json());
  const message = record(body?.message);
  if (typeof message?.content !== "string") throw new Error("Ollama label extraction returned no message content.");
  const parsed = record(JSON.parse(message.content));
  if (!parsed) throw new Error("Ollama label extraction did not return an object.");
  const unreadable = Array.isArray(parsed.unreadable_fields) && parsed.unreadable_fields.every((value) => typeof value === "string")
    ? parsed.unreadable_fields as string[]
    : (() => { throw new Error("Ollama unreadable_fields is invalid."); })();
  return {
    model: MACHINE_LABEL_MODEL,
    digest: model.digest,
    promptHash: createHash("sha256").update(MODEL_PROMPT).digest("hex"),
    raw: message.content,
    basis: basis(parsed.basis),
    servingSizeGrams: finite(parsed.serving_size_g),
    nutrition: modelNutrition(parsed),
    ingredientsRaw: typeof parsed.ingredients_raw === "string" && parsed.ingredients_raw.trim() ? normalizeText(parsed.ingredients_raw) : null,
    unreadableFields: unreadable,
  };
}

export async function extractMachineLabel(imagePath: string, options: {
  vision?: (path: string) => Promise<VisionResult>;
  model?: (bytes: Uint8Array) => Promise<ModelResult>;
  now?: () => Date;
} = {}): Promise<MachineLabelArtifact> {
  const bytes = await readFile(imagePath);
  const [vision, model] = await Promise.all([
    (options.vision ?? runMacOsVision)(imagePath),
    (options.model ?? runQwenLabel)(bytes),
  ]);
  const decisions = decideMachineLabelEvidence({ vision, model });
  return {
    schemaVersion: 1,
    adapterVersion: MACHINE_LABEL_ADAPTER_VERSION,
    image: { path: basename(imagePath), contentSha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength },
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    vision,
    model,
    nutrition: decisions.nutrition,
    ingredients: decisions.ingredients,
  };
}

async function main(): Promise<void> {
  const image = process.argv[2];
  const output = process.argv[3];
  if (!image || !output) throw new Error("Usage: pnpm data:machine-label <label-image> <artifact.json>");
  const bytes = await readFile(image);
  const contentSha256 = createHash("sha256").update(bytes).digest("hex");
  try {
    const existing = JSON.parse(await readFile(output, "utf8")) as Partial<MachineLabelArtifact>;
    if (existing.adapterVersion === MACHINE_LABEL_ADAPTER_VERSION && existing.image?.contentSha256 === contentSha256) {
      process.stdout.write(`${JSON.stringify({ output, cached: true, nutritionAccepted: existing.nutrition?.accepted ?? false, ingredientAccepted: existing.ingredients?.accepted ?? false })}\n`);
      return;
    }
  } catch {
    // No compatible artifact exists; run both local extractors below.
  }
  const artifact = await extractMachineLabel(image);
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ output, nutritionAccepted: artifact.nutrition.accepted, ingredientAccepted: artifact.ingredients.accepted, reasons: { nutrition: artifact.nutrition.reasons, ingredients: artifact.ingredients.reasons } })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
