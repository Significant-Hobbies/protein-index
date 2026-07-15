import { normalizeText } from "./gtin";
import type { AllergenDeclaration, NormalizedIngredient } from "./types";

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    if ((char === "," || char === ";") && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function parseOne(raw: string, position: number): NormalizedIngredient {
  const percentageMatch = raw.match(/(\d+(?:\.\d+)?)\s*%/);
  const nestedMatch = raw.match(/^([^([]+)[([](.+)[)\]]$/);
  const nameRaw = (nestedMatch?.[1] ?? raw).replace(/\d+(?:\.\d+)?\s*%/g, "").trim();
  const normalizedName = normalizeText(nameRaw) || null;
  return {
    raw,
    normalizedName,
    percentage: percentageMatch?.[1] ? Number(percentageMatch[1]) : null,
    position,
    children: nestedMatch?.[2]
      ? splitTopLevel(nestedMatch[2]).map((child, childIndex) => parseOne(child, childIndex))
      : [],
  };
}

export function parseIngredients(raw: string | null | undefined): NormalizedIngredient[] {
  if (!raw?.trim()) return [];
  return splitTopLevel(raw).map((ingredient, index) => parseOne(ingredient, index));
}

function cleanTag(tag: string): string {
  return normalizeText(tag.replace(/^[a-z]{2}:/i, "").replace(/-/g, " "));
}

export function parseAllergens(input: {
  contains?: string | null;
  traces?: string | null;
  tags?: string[];
}): AllergenDeclaration[] {
  const declarations: AllergenDeclaration[] = [];
  for (const value of splitTopLevel(input.contains ?? "")) {
    const name = cleanTag(value);
    if (name) declarations.push({ name, declaration: "contains" });
  }
  for (const value of splitTopLevel(input.traces ?? "")) {
    const name = cleanTag(value);
    if (name) declarations.push({ name, declaration: "may_contain" });
  }
  for (const value of input.tags ?? []) {
    const name = cleanTag(value);
    if (name && !declarations.some((item) => item.name === name)) {
      declarations.push({ name, declaration: "source_tag" });
    }
  }
  return declarations;
}

export function parseAdditives(raw: string | null | undefined, tags: string[] = []): string[] {
  const matches = [...(raw ?? "").matchAll(/\b(?:ins\s*)?([1-9]\d{2,3}[a-z]?)\b/gi)].map(
    (match) => `INS ${match[1]?.toUpperCase()}`,
  );
  const normalizedTags = tags
    .map((tag) => tag.match(/(?:^|:)e(\d{3,4}[a-z]?)/i)?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => `INS ${value.toUpperCase()}`);
  return [...new Set([...matches, ...normalizedTags])];
}
