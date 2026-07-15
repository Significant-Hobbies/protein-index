import { compositeIdentityKey } from "./gtin";

export interface IdentityRecord {
  id: string;
  gtin: string | null;
  brand: string;
  name: string;
  flavour: string | null;
  netQuantityGrams: number | null;
}

export type Resolution =
  | { kind: "match"; productId: string; rule: "exact_gtin" | "exact_composite" }
  | { kind: "review"; candidateIds: string[]; reason: string }
  | { kind: "new"; reason: string };

export function resolveIdentity(incoming: IdentityRecord, candidates: IdentityRecord[]): Resolution {
  if (incoming.gtin) {
    const gtinMatches = candidates.filter((candidate) => candidate.gtin === incoming.gtin);
    if (gtinMatches.length === 1 && gtinMatches[0]) {
      return { kind: "match", productId: gtinMatches[0].id, rule: "exact_gtin" };
    }
    if (gtinMatches.length > 1) {
      return { kind: "review", candidateIds: gtinMatches.map(({ id }) => id), reason: "duplicate_canonical_gtin" };
    }
  }

  const key = compositeIdentityKey(incoming);
  if (!key) return { kind: "new", reason: "insufficient_exact_identity" };
  const compositeMatches = candidates.filter((candidate) => compositeIdentityKey(candidate) === key);
  if (compositeMatches.length === 1 && compositeMatches[0]) {
    return { kind: "match", productId: compositeMatches[0].id, rule: "exact_composite" };
  }
  if (compositeMatches.length > 1) {
    return { kind: "review", candidateIds: compositeMatches.map(({ id }) => id), reason: "ambiguous_exact_composite" };
  }
  return { kind: "new", reason: "no_exact_match" };
}
