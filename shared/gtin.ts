export interface NormalizedQuantity {
  value: number;
  unit: "g" | "kg" | "ml" | "l";
  grams: number | null;
  millilitres: number | null;
}

export function normalizeGtin(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.trim().replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) {
    return null;
  }
  if (!hasValidGtinCheckDigit(digits)) return null;
  return digits.padStart(14, "0");
}

export function hasValidGtinCheckDigit(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 2) return false;
  const body = digits.slice(0, -1);
  const supplied = Number(digits.at(-1));
  let sum = 0;
  for (let index = body.length - 1, offset = 0; index >= 0; index -= 1, offset += 1) {
    const value = Number(body[index]);
    sum += value * (offset % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === supplied;
}

export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/[™®©]/g, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function parseQuantity(value: string | null | undefined): NormalizedQuantity | null {
  if (!value) return null;
  const match = value.trim().toLowerCase().match(/(?:^|\s)(\d+(?:\.\d+)?)\s*(kg|g|ml|l)\b/);
  if (!match?.[1] || !match[2]) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2] as NormalizedQuantity["unit"];
  return {
    value: amount,
    unit,
    grams: unit === "g" ? amount : unit === "kg" ? amount * 1000 : null,
    millilitres: unit === "ml" ? amount : unit === "l" ? amount * 1000 : null,
  };
}

export function compositeIdentityKey(input: {
  brand: string;
  name: string;
  flavour: string | null;
  netQuantityGrams: number | null;
}): string | null {
  const brand = normalizeText(input.brand);
  const name = normalizeText(input.name);
  const flavour = normalizeText(input.flavour);
  if (!brand || !name || !flavour || !input.netQuantityGrams) return null;
  return `${brand}|${name}|${flavour}|${input.netQuantityGrams}`;
}
