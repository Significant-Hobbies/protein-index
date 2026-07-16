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
    .replace(/[βΒ]/g, " beta ")
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
  const match = value.trim().toLowerCase().match(
    /(?:^|[^0-9.])(\d+(?:\.\d+)?)\s*(kilograms?|kgs?|grams?|g|millilit(?:er|re)s?|ml|centilit(?:er|re)s?|cl|decilit(?:er|re)s?|dl|lit(?:er|re)s?|l)\b/,
  );
  if (!match?.[1] || !match[2]) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const rawUnit = match[2];
  const unit: NormalizedQuantity["unit"] =
    /^(?:kilograms?|kgs?)$/.test(rawUnit) ? "kg"
      : /^(?:grams?|g)$/.test(rawUnit) ? "g"
        : /^(?:lit(?:er|re)s?|l)$/.test(rawUnit) ? "l"
          : "ml";
  const millilitres = /^(?:centilit(?:er|re)s?|cl)$/.test(rawUnit) ? amount * 10
    : /^(?:decilit(?:er|re)s?|dl)$/.test(rawUnit) ? amount * 100
      : unit === "ml" ? amount : unit === "l" ? amount * 1000 : null;
  return {
    value: amount,
    unit,
    grams: unit === "g" ? amount : unit === "kg" ? amount * 1000 : null,
    millilitres,
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
