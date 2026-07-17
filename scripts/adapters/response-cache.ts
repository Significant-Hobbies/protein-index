import { readFile } from "node:fs/promises";

const COMPLETE_OUTCOMES = new Set(["candidate", "no_prediction", "rejected"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readCompletedResponseCodes(path: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
    throw error;
  }

  const completed = new Set<string>();
  const incomplete = new Set<string>();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let outcome: unknown;
    try {
      outcome = JSON.parse(line);
    } catch {
      throw new Error(`Response outcome cache contains invalid JSON on line ${index + 1}.`);
    }
    if (!isRecord(outcome) || typeof outcome.requestedCode !== "string" || typeof outcome.status !== "string") {
      throw new Error(`Response outcome cache contains an invalid row on line ${index + 1}.`);
    }
    if (COMPLETE_OUTCOMES.has(outcome.status)) completed.add(outcome.requestedCode);
    else incomplete.add(outcome.requestedCode);
  }
  for (const code of incomplete) completed.delete(code);
  return completed;
}
