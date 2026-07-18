import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { classifyProtein } from "../../shared/classification";
import { normalizeGtin, normalizeText, parseQuantity } from "../../shared/gtin";
import { emptyNutrition, hasNutritionErrors, validateNutrition } from "../../shared/nutrition";
import type { SourceManifest, StagedOffer, StagedProduct } from "../../shared/types";

export const OFFICIAL_BRAND_SITEMAP_ADAPTER_VERSION = "official-brand-sitemap-v16";
export const OFFICIAL_BRAND_USER_AGENT = "ProteinIndexCatalogBot/1.0";
export const DEFAULT_MAX_PRODUCT_PAGES = 2_000;
export const DEFAULT_MAX_SITEMAP_DEPTH = 3;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface OfficialBrandSource { id: string; name: string; allowedHosts: string[]; sitemapUrls: string[]; brandAliases?: string[]; productPathPrefixes?: string[]; candidateUrlTerms?: string[]; requiredNameTerms?: string[]; nutritionImageFilenamePrefixes?: string[]; maxProductPages?: number; maxSitemapDepth?: number; maximumResponseBytes?: number; minimumRequestIntervalMs?: number; maxRetries?: number; maxNotFoundRetries?: number }
export interface OfficialBrandDiscoveryConfig { schemaVersion: 1; sources: OfficialBrandSource[] }
export interface OfficialBrandDiscoveryResult { manifest: SourceManifest; stagedPath: string; exclusionsPath: string; manifestPath: string }

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
class HttpError extends Error { constructor(readonly status: number) { super(`HTTP ${status}`); } }
const record = (value: unknown): Json | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Json : null;
const string = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const stable = (value: string) => createHash("sha256").update(value).digest("hex");

function httpsUrl(value: string, name: string): URL { let url: URL; try { url = new URL(value); } catch { throw new Error(`${name} must be an HTTPS URL.`); } if (url.protocol !== "https:") throw new Error(`${name} must be an HTTPS URL.`); return url; }

export function validateOfficialBrandSource(source: OfficialBrandSource): void {
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(source.id)) throw new Error("Official brand source id is invalid.");
  if (!source.name.trim()) throw new Error("Official brand source name is required.");
  if (!Array.isArray(source.allowedHosts) || source.allowedHosts.length === 0 || source.allowedHosts.some((host) => !/^[a-z0-9.-]+$/i.test(host))) throw new Error("Official brand source requires allowed HTTPS hosts.");
  if (!Array.isArray(source.sitemapUrls) || source.sitemapUrls.length === 0) throw new Error("Official brand source requires sitemap URLs.");
  if (source.brandAliases && (!Array.isArray(source.brandAliases) || source.brandAliases.length === 0 || source.brandAliases.some((alias) => !normalizeText(alias)))) throw new Error("brandAliases must be non-empty declared-brand aliases.");
  if (source.productPathPrefixes && (!Array.isArray(source.productPathPrefixes) || source.productPathPrefixes.some((prefix) => !prefix.startsWith("/")))) throw new Error("Product path prefixes must begin with /.");
  if (source.candidateUrlTerms && (!Array.isArray(source.candidateUrlTerms) || source.candidateUrlTerms.length === 0 || source.candidateUrlTerms.some((term) => !normalizeText(term)))) throw new Error("candidateUrlTerms must be non-empty product URL terms.");
  if (source.requiredNameTerms && (!Array.isArray(source.requiredNameTerms) || source.requiredNameTerms.length === 0 || source.requiredNameTerms.some((term) => !normalizeText(term)))) throw new Error("requiredNameTerms must be non-empty product-name terms.");
  if (source.nutritionImageFilenamePrefixes && (!Array.isArray(source.nutritionImageFilenamePrefixes) || source.nutritionImageFilenamePrefixes.length === 0 || source.nutritionImageFilenamePrefixes.some((prefix) => !/^[a-z0-9_-]+$/i.test(prefix)))) throw new Error("nutritionImageFilenamePrefixes must be non-empty literal filename prefixes.");
  const hosts = new Set(source.allowedHosts.map((host) => host.toLowerCase()));
  for (const sitemapUrl of source.sitemapUrls) if (!hosts.has(httpsUrl(sitemapUrl, "Sitemap URL").host.toLowerCase())) throw new Error("Sitemap URL host is outside the configured boundary.");
  for (const [name, value, fallback] of [["maxProductPages", source.maxProductPages, DEFAULT_MAX_PRODUCT_PAGES], ["maxSitemapDepth", source.maxSitemapDepth, DEFAULT_MAX_SITEMAP_DEPTH]] as const) if (!Number.isSafeInteger(value ?? fallback) || (value ?? fallback) < 1) throw new Error(`${name} must be a positive integer.`);
  if (!Number.isSafeInteger(source.maximumResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) || (source.maximumResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) < 1 || (source.maximumResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) > 8 * 1024 * 1024) throw new Error("maximumResponseBytes must be between 1 byte and 8 MiB.");
  if (!Number.isSafeInteger(source.minimumRequestIntervalMs ?? 0) || (source.minimumRequestIntervalMs ?? 0) < 0 || (source.minimumRequestIntervalMs ?? 0) > 60_000) throw new Error("minimumRequestIntervalMs must be between 0 and 60000.");
  if (!Number.isSafeInteger(source.maxRetries ?? 0) || (source.maxRetries ?? 0) < 0 || (source.maxRetries ?? 0) > 5) throw new Error("maxRetries must be between 0 and 5.");
  if (!Number.isSafeInteger(source.maxNotFoundRetries ?? 0) || (source.maxNotFoundRetries ?? 0) < 0 || (source.maxNotFoundRetries ?? 0) > 2) throw new Error("maxNotFoundRetries must be between 0 and 2.");
}

export function validateOfficialBrandConfig(config: OfficialBrandDiscoveryConfig): void { if (config.schemaVersion !== 1 || !Array.isArray(config.sources) || config.sources.length === 0) throw new Error("Official brand configuration must contain schemaVersion 1 sources."); const seen = new Set<string>(); for (const source of config.sources) { validateOfficialBrandSource(source); if (seen.has(source.id)) throw new Error(`Official brand source ${source.id} is duplicated.`); seen.add(source.id); } }

export function robotsAllows(robots: string, userAgent = OFFICIAL_BRAND_USER_AGENT, path = "/"): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; path: string }> }> = []; let current: { agents: string[]; rules: Array<{ allow: boolean; path: string }> } | null = null;
  for (const rawLine of robots.replace(/\r/g, "").split("\n")) { const line = rawLine.replace(/#.*/, "").trim(); const match = /^(user-agent|allow|disallow)\s*:\s*(.*)$/i.exec(line); if (!match) continue; const directive = match[1]!.toLowerCase(); const value = match[2]!.trim(); if (directive === "user-agent") { if (!current || current.rules.length > 0) { current = { agents: [], rules: [] }; groups.push(current); } current.agents.push(value.toLowerCase()); } else if (current && value) current.rules.push({ allow: directive === "allow", path: value }); }
  const agent = userAgent.toLowerCase(); const applicable = groups.filter((group) => group.agents.includes(agent) || group.agents.includes("*")); const exact = applicable.filter((group) => group.agents.includes(agent)); const rules = (exact.length > 0 ? exact : applicable).flatMap((group) => group.rules).filter((rule) => path.startsWith(rule.path)); if (rules.length === 0) return true; rules.sort((left, right) => right.path.length - left.path.length || Number(right.allow) - Number(left.allow)); return rules[0]!.allow;
}

function withinBoundary(url: string, hosts: Set<string>): boolean { try { return hosts.has(httpsUrl(url, "Discovered URL").host.toLowerCase()); } catch { return false; } }
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function boundedText(fetcher: Fetcher, url: string, maximumBytes: number): Promise<{ text: string; effectiveUrl: string }> { const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 20_000); try { const response = await fetcher(url, { headers: { "User-Agent": OFFICIAL_BRAND_USER_AGENT, Accept: "text/html,application/xml,text/xml;q=0.9" }, redirect: "follow", signal: controller.signal }); if (!response.ok) throw new HttpError(response.status); if (!response.body) throw new Error("Response body is missing."); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0; try { for (;;) { const item = await reader.read(); if (item.done) break; if (!item.value) continue; size += item.value.byteLength; if (size > maximumBytes) throw new Error("Response exceeds byte limit."); chunks.push(item.value); } } finally { reader.releaseLock(); } return { text: new TextDecoder().decode(Buffer.concat(chunks)), effectiveUrl: response.url || url }; } finally { clearTimeout(timeout); } }
export function sitemapLocations(xml: string): string[] { return [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) => match[1]!.trim()); }

interface ParsedProduct { product: Json; evidenceKey: "productJsonLd" | "productMicrodata" | "productShopifyMeta"; productGroup: Json | null }

function microdataAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([a-z][a-z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    attributes[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
}

function microdataValues(html: string, property: string): string[] {
  const values: string[] = [];
  for (const match of html.matchAll(/<(?:meta|link|img)\b[^>]*>/gi)) {
    const attributes = microdataAttributes(match[0]);
    if (!attributes.itemprop?.split(/\s+/).includes(property)) continue;
    const value = attributes.content ?? attributes.href ?? attributes.src;
    if (value?.trim()) values.push(value.trim());
  }
  return values;
}

function microdataProduct(html: string): ParsedProduct | null {
  const name = microdataValues(html, "name")[0];
  if (!name) return null;
  const images = microdataValues(html, "image");
  const image = images.find((value) => /^https:\/\//.test(value) && !/logo/i.test(value)) ?? images.find((value) => /^https:\/\//.test(value));
  const price = microdataValues(html, "price")[0];
  const priceCurrency = microdataValues(html, "priceCurrency")[0];
  const offer = price && priceCurrency ? { price, priceCurrency, availability: microdataValues(html, "availability")[0] } : null;
  return { evidenceKey: "productMicrodata", product: { "@type": "Product", name, brand: microdataValues(html, "brand")[0], sku: microdataValues(html, "sku")[0], image, offers: offer }, productGroup: null };
}

function embeddedJsonObject(html: string, marker: RegExp): Json | null {
  const match = marker.exec(html);
  if (!match || match.index === undefined) return null;
  const start = html.indexOf("{", match.index + match[0].length);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) {
      try { return record(JSON.parse(html.slice(start, index + 1))); } catch { return null; }
    }
  }
  return null;
}

function productTitleFromPage(html: string): string | null {
  const heading = /<h1\b[^>]*class=["'][^"']*\bproduct-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  if (heading) {
    const value = heading.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").trim().replace(/\s+/g, " ");
    if (value) return value;
  }
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = microdataAttributes(tag[0]);
    if (attributes.property === "og:title" || attributes.name === "twitter:title") {
      const value = string(attributes.content);
      if (value) return value;
    }
  }
  return null;
}

function shopifyMetaProducts(html: string, pageUrl: string): ParsedProduct[] {
  const meta = embeddedJsonObject(html, /var\s+meta\s*=\s*/i);
  if (!meta) return [];
  const product = record(meta.product);
  const baseName = string(product?.title) ?? productTitleFromPage(html);
  if (!product || !baseName) return [];
  const variants = Array.isArray(product.variants)
    ? product.variants.map(record).filter((variant): variant is Json => variant !== null)
    : [null];
  return variants.map((variant) => {
    const variantId = typeof variant?.id === "number" || typeof variant?.id === "string" ? String(variant.id) : null;
    const productUrl = new URL(string(product.url) ?? pageUrl, pageUrl);
    if (variantId) productUrl.searchParams.set("variant", variantId);
    const name = string(variant?.name) ?? baseName;
    const priceCents = typeof variant?.price === "number" && Number.isFinite(variant.price) && variant.price > 0 ? variant.price : null;
    return {
      evidenceKey: "productShopifyMeta" as const,
      product: {
        "@type": "Product",
        name,
        brand: string(product.vendor),
        sku: string(variant?.sku),
        image: productImageWithAlt(html, pageUrl, baseName),
        url: productUrl.toString(),
        offers: priceCents === null ? null : { price: priceCents / 100, priceCurrency: "INR", availability: variant?.available === false ? "https://schema.org/OutOfStock" : "https://schema.org/InStock" },
      },
      productGroup: null,
    };
  });
}

function visibleVariant(html: string): string | null {
  const match = /<[^>]*class=["'][^"']*flavour-and-tag-container[^"']*["'][^>]*>[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (!match?.[1]) return null;
  const value = match[1].replace(/<!--[^]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").trim().replace(/\s+/g, " ");
  return value || null;
}

function absoluteHttpsImage(value: string | undefined, pageUrl: string): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim(), pageUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function fullResolutionLabelImage(value: string | undefined, pageUrl: string): string | null {
  const image = absoluteHttpsImage(value, pageUrl);
  if (!image) return null;
  const url = new URL(image);
  url.searchParams.delete("width");
  return url.toString();
}

function labelledPageImage(html: string, pageUrl: string, pattern: RegExp): string | null {
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const attributes = microdataAttributes(match[0]);
    const description = [attributes.alt, attributes.title, attributes["data-alt"], attributes["aria-label"], attributes["data-media-alt"]].filter(Boolean).join(" ");
    if (!pattern.test(description)) continue;
    const image = fullResolutionLabelImage(attributes.src ?? attributes["data-src"] ?? attributes["data-zoom-image"], pageUrl);
    if (image) return image;
  }
  return null;
}

function configuredNutritionImage(html: string, pageUrl: string, prefixes: string[] | undefined): string | null {
  if (!prefixes?.length) return null;
  const normalizedPrefixes = prefixes.map((prefix) => prefix.toLowerCase());
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const attributes = microdataAttributes(match[0]);
    const image = fullResolutionLabelImage(attributes.src ?? attributes["data-src"] ?? attributes["data-zoom-image"], pageUrl);
    if (!image) continue;
    const filename = new URL(image).pathname.split("/").at(-1)?.toLowerCase() ?? "";
    if (normalizedPrefixes.some((prefix) => filename.startsWith(prefix))) return image;
  }
  return null;
}

function productImageWithAlt(html: string, pageUrl: string, name: string): string | null {
  const normalizedName = normalizeText(name);
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const attributes = microdataAttributes(match[0]);
    if (normalizeText(attributes.alt ?? "") !== normalizedName) continue;
    const image = absoluteHttpsImage(attributes.src ?? attributes["data-src"] ?? attributes["data-zoom-image"], pageUrl);
    if (image) return image;
  }
  return null;
}

function sectionLabelledPageImage(html: string, pageUrl: string, pattern: RegExp): string | null {
  for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*>/gi)) {
    const tag = match[1];
    if (tag?.toLowerCase() !== "section") continue;
    const attributes = microdataAttributes(match[0]);
    const description = [attributes.id, attributes["data-id"], attributes["data-tab"], attributes["aria-label"]].filter(Boolean).join(" ");
    if (!pattern.test(description)) continue;
    const start = (match.index ?? 0) + match[0].length;
    const end = html.indexOf(`</${tag}>`, start);
    if (end < start) continue;
    const section = html.slice(start, end);
    const imageMatch = /<img\b[^>]*>/i.exec(section);
    if (!imageMatch) continue;
    const image = microdataAttributes(imageMatch[0]);
    const url = fullResolutionLabelImage(image.src ?? image["data-src"] ?? image["data-zoom-image"], pageUrl);
    if (url) return url;
  }
  return null;
}

function explicitLabelImages(source: OfficialBrandSource, html: string, pageUrl: string): { nutritionImageUrl: string | null; ingredientImageUrl: string | null } {
  return {
    nutritionImageUrl: labelledPageImage(html, pageUrl, /\b(?:nutrition|nutritional|supplement)\s*(?:facts|information|label)?\b/i)
      ?? sectionLabelledPageImage(html, pageUrl, /\b(?:nutrition|nutritional|supplement)\b/i)
      ?? configuredNutritionImage(html, pageUrl, source.nutritionImageFilenamePrefixes),
    ingredientImageUrl: labelledPageImage(html, pageUrl, /\bingredients?(?:\s+(?:list|label|panel))?\b/i)
      ?? sectionLabelledPageImage(html, pageUrl, /\bingredients?\b/i),
  };
}

/** Accepts only an explicit total pack declaration, never a serving or protein claim. */
export function declaredPackQuantity(name: string, description?: string | null): number | null {
  const kilogram = /\b(\d+(?:\.\d+)?)\s*(?:kg|kilograms?)\b/i.exec(name)?.[0];
  if (kilogram) return parseQuantity(kilogram)?.grams ?? null;
  const contextualGrams = /\b(?:pack(?:\s+of)?|box|jar|pouch|tub|net\s*(?:wt|weight)?|weight)\s*\(?\s*(\d+(?:\.\d+)?)\s*(?:g|grams?)\b/i.exec(name)?.[0];
  if (contextualGrams) return parseQuantity(contextualGrams)?.grams ?? null;
  const terminalGrams = /\b(\d+(?:\.\d+)?)\s*(?:g|grams?)\s*(?:$|[|,/(])/i.exec(name)?.[0];
  if (terminalGrams) return parseQuantity(terminalGrams)?.grams ?? null;
  const declaredNetWeight = /\b(?:net\s*(?:wt|weight)?|net\s*qty|pack\s*weight)\s*:?\s*(\d+(?:\.\d+)?)\s*(?:g|grams?|kg|kilograms?)\b/i.exec(description ?? "")?.[0];
  return declaredNetWeight ? parseQuantity(declaredNetWeight)?.grams ?? null : null;
}

function schemaType(value: Json): string[] { const type = value["@type"]; return Array.isArray(type) ? type.filter((item): item is string => typeof item === "string") : typeof type === "string" ? [type] : []; }

function jsonLdProducts(value: Json): ParsedProduct[] {
  if (schemaType(value).includes("Product")) return [{ product: value, evidenceKey: "productJsonLd", productGroup: null }];
  if (!schemaType(value).includes("ProductGroup")) return [];
  const variants = Array.isArray(value.hasVariant) ? value.hasVariant : [value.hasVariant];
  return variants.flatMap((variant) => {
    const product = record(variant);
    return product && schemaType(product).includes("Product") ? [{ product, evidenceKey: "productJsonLd" as const, productGroup: value }] : [];
  });
}

function firstProducts(html: string, pageUrl: string): ParsedProduct[] { for (const script of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) { try { const value = JSON.parse(script[1]!); const values = Array.isArray(value) ? value : [value]; for (const entry of values) { const item = record(entry); if (!item) continue; const graph = Array.isArray(item["@graph"]) ? item["@graph"] : [item]; for (const nested of graph) { const product = record(nested); if (!product) continue; const parsed = jsonLdProducts(product); if (parsed.length > 0) return parsed; } } } catch { /* malformed JSON-LD is excluded below */ } } const microdata = microdataProduct(html); if (microdata) return [microdata]; return shopifyMetaProducts(html, pageUrl); }
function offerFrom(product: Json, source: OfficialBrandSource, pageUrl: string, observedAt: string): StagedOffer[] { const offers = Array.isArray(product.offers) ? product.offers : [product.offers]; for (const rawOffer of offers) { const offer = record(rawOffer); if (!offer) continue; const rawPrice = offer.price; const price = typeof rawPrice === "number" ? rawPrice : typeof rawPrice === "string" ? Number(rawPrice) : NaN; const currency = string(offer.priceCurrency)?.toUpperCase(); if (!Number.isFinite(price) || price < 0 || currency !== "INR") continue; const availability = string(offer.availability)?.toLowerCase() ?? ""; return [{ retailer: source.id, retailerListingId: stable(pageUrl).slice(0, 40), pincode: null, seller: source.name, mrp: null, sellingPrice: price, available: !availability.includes("outofstock") && !availability.includes("soldout"), url: pageUrl, observedAt }]; } return []; }

function declaredNutritionNumber(value: unknown, unit: "kcal" | "g" | "mg"): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  const raw = string(value);
  if (!raw) return null;
  const units = unit === "kcal" ? "kcal|kilocalories?" : unit === "mg" ? "mg|milligrams?" : "g|grams?";
  const match = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(?:${units})$`, "i").exec(raw);
  return match ? Number(match[1]) : null;
}

function structuredNutrition(product: Json, source: OfficialBrandSource, observedAt: string) {
  const declared = record(product.nutrition);
  if (!declared || !schemaType(declared).includes("NutritionInformation")) return null;
  const per100g = {
    calories: declaredNutritionNumber(declared.calories, "kcal"),
    proteinGrams: declaredNutritionNumber(declared.proteinContent, "g"),
    carbohydrateGrams: declaredNutritionNumber(declared.carbohydrateContent, "g"),
    sugarGrams: declaredNutritionNumber(declared.sugarContent, "g"),
    fatGrams: declaredNutritionNumber(declared.fatContent, "g"),
    saturatedFatGrams: declaredNutritionNumber(declared.saturatedFatContent, "g"),
    fibreGrams: declaredNutritionNumber(declared.fiberContent ?? declared.fibreContent, "g"),
    sodiumMg: declaredNutritionNumber(declared.sodiumContent, "mg"),
  };
  if (per100g.calories === null || per100g.proteinGrams === null || hasNutritionErrors(validateNutrition(per100g, "unknown"))) return null;
  return { per100g, servingSizeGrams: null, basis: "unknown" as const, preparationState: "as_sold" as const, status: "unverified" as const, confidence: "medium" as const, source: source.id, observedAt, labelVerifiedAt: null };
}

function htmlTableText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#(?:0*39|x27);/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\r/g, "");
}

function pipeCells(line: string): string[] {
  const cells = line.trim().split("|").map((cell) => cell.trim());
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells.length >= 2 ? cells : [];
}

function nutritionTableCandidates(html: string): Array<{ nutrition: ReturnType<typeof emptyNutrition>; raw: string }> {
  const text = htmlTableText(html);
  const lines = text.split("\n");
  const candidates: Array<{ nutrition: ReturnType<typeof emptyNutrition>; raw: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const first = pipeCells(lines[index]!);
    if (first.length < 2 || !["nutrient", "nutrition label"].includes(normalizeText(first[0]!))) continue;
    const rows = [first];
    const start = index;
    let end = index + 1;
    for (; end < lines.length && rows.length < 17; end += 1) {
      const cells = pipeCells(lines[end]!);
      if (cells.length < 2 && !lines[end]!.trim()) continue;
      if (cells.length < 2 || ["nutrient", "nutrition label"].includes(normalizeText(cells[0]!))) break;
      rows.push(cells);
    }
    index = end - 1;
    const header = rows[0];
    if (!header) continue;
    const per100Index = header.findIndex((cell) => /^per\s*100\s*g(?:rams?)?$/i.test(cell));
    if (per100Index < 1) continue;
    const values = new Map<string, string>();
    for (const row of rows.slice(1)) {
      if (/^-+$/.test(row[0]!.replace(/\s/g, "")) || !row[per100Index]) continue;
      values.set(normalizeText(row[0]!), row[per100Index]!);
    }
    const from = (keys: string[], unit: "kcal" | "g" | "mg") => {
      const value = keys.map((key) => values.get(normalizeText(key))).find((item) => item !== undefined);
      return value === undefined ? null : declaredNutritionNumber(value, unit);
    };
    const nutrition = {
      calories: from(["energy", "calories", "calorie"], "kcal"),
      proteinGrams: from(["protein"], "g"),
      carbohydrateGrams: from(["carbohydrate", "carbohydrates", "total carbohydrate", "total carbohydrates", "carbs"], "g"),
      sugarGrams: from(["sugar", "total sugars", "added sugar", "added sugars", "natural + added sugar"], "g"),
      fatGrams: from(["fat", "total fat"], "g"),
      saturatedFatGrams: from(["saturated fat", "saturated fats"], "g"),
      fibreGrams: from(["fibre", "fiber", "dietary fibre", "dietary fiber"], "g"),
      sodiumMg: from(["sodium"], "mg"),
    };
    if (nutrition.calories === null || nutrition.proteinGrams === null || hasNutritionErrors(validateNutrition(nutrition, "per_100g"))) continue;
    candidates.push({ nutrition, raw: lines.slice(start, end).join("\n").trim() });
  }
  return candidates;
}

function htmlTableNutrition(html: string, source: OfficialBrandSource, observedAt: string) {
  const candidates = nutritionTableCandidates(html);
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  return {
    nutrition: { per100g: candidate.nutrition, servingSizeGrams: null, basis: "per_100g" as const, preparationState: "as_sold" as const, status: "unverified" as const, confidence: "medium" as const, source: source.id, observedAt, labelVerifiedAt: null },
    raw: candidate.raw,
  };
}

function productUrl(product: Json, pageUrl: string): string {
  const candidate = string(product.url) ?? string(product["@id"]);
  if (!candidate) return pageUrl;
  try {
    const parsed = new URL(candidate, pageUrl);
    return parsed.protocol === "https:" && parsed.origin === new URL(pageUrl).origin ? parsed.toString() : pageUrl;
  } catch {
    return pageUrl;
  }
}

function canonicalBrand(source: OfficialBrandSource, declared: string | null): string {
  if (!declared) return source.name;
  return source.brandAliases?.some((alias) => normalizeText(alias) === normalizeText(declared)) ? source.name : declared;
}

function stagedOfficialBrandProductFromParsed(input: { source: OfficialBrandSource; pageUrl: string; html: string; observedAt: string; parsed: ParsedProduct }): StagedProduct | null {
  const product = input.parsed.product; const name = string(product.name); if (!name) return null; const group = input.parsed.productGroup; const brandValue = record(product.brand) ?? record(group?.brand); const brand = canonicalBrand(input.source, string(product.brand) ?? string(group?.brand) ?? string(brandValue?.name)); const rawGtin = string(product.gtin13) ?? string(product.gtin12) ?? string(product.gtin14) ?? string(product.gtin) ?? string(product.sku); const gtin = normalizeGtin(rawGtin); const images = Array.isArray(product.image) ? product.image : [product.image]; const imageUrl = images.map(string).find((value) => value?.startsWith("https://")) ?? null; const flavour = visibleVariant(input.html); const netQuantityGrams = parseQuantity(flavour)?.grams ?? declaredPackQuantity(name, string(product.description) ?? string(group?.description)); const sourceUrl = productUrl(product, input.pageUrl); const labels = group ? { nutritionImageUrl: null, ingredientImageUrl: null } : explicitLabelImages(input.source, input.html, input.pageUrl); const declaredNutrition = structuredNutrition(product, input.source, input.observedAt); const tableNutrition = declaredNutrition ? null : htmlTableNutrition(input.html, input.source, input.observedAt); const evidence = { pageUrl: input.pageUrl, [input.parsed.evidenceKey]: product, productGroup: group, flavour, labels, nutritionTable: tableNutrition?.raw ?? null }; const nutrition = declaredNutrition ?? tableNutrition?.nutrition ?? { per100g: emptyNutrition(), servingSizeGrams: null, basis: "unknown" as const, preparationState: "as_sold" as const, status: "missing" as const, confidence: "medium" as const, source: input.source.id, observedAt: input.observedAt, labelVerifiedAt: null }; const classification = classifyProtein({ brand, name, categories: string(product.category) ?? string(group?.category) ?? "", labels: "", nutrition });
  return { source: input.source.id, sourceKind: "brand", sourceAuthority: { identity: 70, nutrition: 40, ingredients: 40 }, sourceLicenseUrl: null, sourceRetentionNotes: "Configured official brand page; retain provenance and respect source policy.", sourceRecordId: sourceUrl, sourceUrl, observedAt: input.observedAt, contentHash: stable(JSON.stringify(evidence)), gtinRaw: rawGtin, gtin, brand, name, flavour, category: "other", categoryRaw: string(product.category) ?? string(group?.category), productKind: "retail_packaged", netQuantityGrams, servingSizeGrams: null, imageUrl, nutritionImageUrl: labels.nutritionImageUrl, ingredientImageUrl: labels.ingredientImageUrl, offers: offerFrom(product, input.source, sourceUrl, input.observedAt), ratings: [], nutrition, nutrients: [], ingredients: { raw: null, language: null, normalized: [], allergens: [], additives: [], status: "missing", confidence: "medium", source: input.source.id, observedAt: input.observedAt }, classification, completeness: 0, completenessMissing: ["nutrition", "ingredients"], rawEvidence: evidence, validationIssues: [] };
}

export function stagedOfficialBrandProduct(input: { source: OfficialBrandSource; pageUrl: string; html: string; observedAt: string }): StagedProduct | null {
  const parsed = firstProducts(input.html, input.pageUrl)[0];
  return parsed ? stagedOfficialBrandProductFromParsed({ ...input, parsed }) : null;
}

export function stagedOfficialBrandProducts(input: { source: OfficialBrandSource; pageUrl: string; html: string; observedAt: string }): StagedProduct[] {
  return firstProducts(input.html, input.pageUrl).flatMap((parsed) => {
    const product = stagedOfficialBrandProductFromParsed({ ...input, parsed });
    return product ? [product] : [];
  });
}
async function write(stream: NodeJS.WritableStream, value: unknown): Promise<void> { if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain"); }
export function officialBrandVariantKey(product: StagedProduct): string {
  if (product.gtin) return product.gtin;
  if (!product.flavour && product.netQuantityGrams === null) return `source:${product.sourceRecordId}`;
  return [product.brand, product.name, product.flavour ?? "", product.netQuantityGrams ?? ""].map((value) => normalizeText(String(value))).join("|");
}

export async function discoverOfficialBrandCatalog(input: { source: OfficialBrandSource; outputDirectory: string; fetcher?: Fetcher; now?: () => Date }): Promise<OfficialBrandDiscoveryResult> {
  validateOfficialBrandSource(input.source); await mkdir(input.outputDirectory, { recursive: true }); const fetcher = input.fetcher ?? fetch; const now = input.now ?? (() => new Date()); const startedAt = now().toISOString(); const hosts = new Set(input.source.allowedHosts.map((host) => host.toLowerCase())); const root = httpsUrl(input.source.sitemapUrls[0]!, "Sitemap URL"); const stagedPath = join(input.outputDirectory, "staged-products.jsonl"); const exclusionsPath = join(input.outputDirectory, "exclusions.jsonl"); const manifestPath = join(input.outputDirectory, "manifest.json"); const staged = createWriteStream(stagedPath); const exclusions = createWriteStream(exclusionsPath); const maximumPages = input.source.maxProductPages ?? DEFAULT_MAX_PRODUCT_PAGES; const maximumDepth = input.source.maxSitemapDepth ?? DEFAULT_MAX_SITEMAP_DEPTH; const maximumResponseBytes = input.source.maximumResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES; const minimumIntervalMs = input.source.minimumRequestIntervalMs ?? 0; const maxRetries = input.source.maxRetries ?? 0; const maxNotFoundRetries = input.source.maxNotFoundRetries ?? 0; let lastRequestAt = 0; const requestText = async (url: string) => { const elapsed = Date.now() - lastRequestAt; if (elapsed < minimumIntervalMs) await pause(minimumIntervalMs - elapsed); for (let attempt = 0;; attempt += 1) { try { const result = await boundedText(fetcher, url, maximumResponseBytes); lastRequestAt = Date.now(); if (!withinBoundary(result.effectiveUrl, hosts)) throw new Error("Redirect left the configured HTTPS host boundary."); return result; } catch (error) { lastRequestAt = Date.now(); const retryLimit = error instanceof HttpError && error.status === 404 ? maxNotFoundRetries : maxRetries; if (!(error instanceof HttpError) || ![404, 429, 500, 502, 503, 504].includes(error.status) || attempt >= retryLimit) throw error; await pause(Math.max(minimumIntervalMs, 500 * 2 ** attempt)); } } }; let recordsRead = 0; let stagedRecords = 0; let invalidRecords = 0; let duplicateRecords = 0; const productVariants = new Set<string>(); let failed = false; let limited = false;
  try { let robots = ""; try { robots = (await requestText(`https://${root.host}/robots.txt`)).text; } catch { robots = ""; } if (robots && !robotsAllows(robots)) { failed = true; await write(exclusions, { reason: "robots_disallow_all", url: `https://${root.host}/robots.txt` }); } else { const pending = input.source.sitemapUrls.map((url) => ({ url, depth: 0 })); const seenSitemaps = new Set<string>(); const pages = new Set<string>(); while (pending.length > 0 && !limited) { const current = pending.shift()!; if (seenSitemaps.has(current.url)) continue; seenSitemaps.add(current.url); if (current.depth > maximumDepth || !withinBoundary(current.url, hosts)) { invalidRecords += 1; await write(exclusions, { reason: "sitemap_outside_boundary_or_depth", url: current.url }); continue; } let locations: string[]; try { locations = sitemapLocations((await requestText(current.url)).text); } catch (error) { failed = true; await write(exclusions, { reason: "sitemap_fetch_failed", url: current.url, error: error instanceof Error ? error.message : String(error) }); continue; } for (const url of locations) { if (!withinBoundary(url, hosts)) { invalidRecords += 1; await write(exclusions, { reason: "url_outside_boundary", url }); continue; } if (/\.xml(?:$|[?#])/i.test(url)) pending.push({ url, depth: current.depth + 1 }); else if (!input.source.productPathPrefixes || input.source.productPathPrefixes.some((prefix) => new URL(url).pathname.startsWith(prefix))) { if (input.source.candidateUrlTerms && !input.source.candidateUrlTerms.some((term) => normalizeText(url).includes(normalizeText(term)))) { await write(exclusions, { reason: "product_url_not_included", url }); continue; } pages.add(url); } if (pages.size >= maximumPages) { limited = true; break; } } } for (const pageUrl of [...pages].sort()) { recordsRead += 1; try { const html = (await requestText(pageUrl)).text; const products = stagedOfficialBrandProducts({ source: input.source, pageUrl, html, observedAt: now().toISOString() }); if (products.length === 0) { invalidRecords += 1; await write(exclusions, { reason: "product_metadata_missing_or_invalid", url: pageUrl }); continue; } for (const product of products) { if (input.source.requiredNameTerms && !input.source.requiredNameTerms.some((term) => normalizeText(`${product.brand} ${product.name}`).includes(normalizeText(term)))) { invalidRecords += 1; await write(exclusions, { reason: "product_name_not_included", url: product.sourceUrl, name: product.name }); continue; } const variant = officialBrandVariantKey(product); if (productVariants.has(variant)) { duplicateRecords += 1; await write(exclusions, { reason: "duplicate_product_variant", url: product.sourceUrl, product: { brand: product.brand, name: product.name, flavour: product.flavour, netQuantityGrams: product.netQuantityGrams } }); continue; } productVariants.add(variant); await write(staged, product); stagedRecords += 1; } } catch (error) { if (error instanceof HttpError && error.status === 404) { await write(exclusions, { reason: "product_not_found", url: pageUrl }); continue; } failed = true; await write(exclusions, { reason: "product_fetch_failed", url: pageUrl, error: error instanceof Error ? error.message : String(error) }); } } } } finally { staged.end(); exclusions.end(); await Promise.all([once(staged, "finish"), once(exclusions, "finish")]); }
  const terminalEvidence = failed ? "error" : limited ? "limit" : "end_of_file"; const manifest: SourceManifest = { schemaVersion: 1, source: input.source.id, sourceKind: "brand", sourceAuthority: { identity: 70, nutrition: 40, ingredients: 40 }, sourceLicenseUrl: null, sourceRetentionNotes: "Configured official brand page; retain provenance and respect source policy.", adapterVersion: OFFICIAL_BRAND_SITEMAP_ADAPTER_VERSION, input: input.source.sitemapUrls.join(","), inputHash: stable(JSON.stringify(input.source)), inputBytes: null, sourceUpdatedAt: null, startedAt, completedAt: now().toISOString(), mode: "production", terminalEvidence, sourceComplete: terminalEvidence === "end_of_file", marketComplete: false, advertisedTotal: null, recordsRead, indiaRecords: stagedRecords, stagedRecords, invalidRecords, duplicateRecords, newRecords: 0, changedRecords: 0, unchangedRecords: 0, missingSinceRecords: 0, knownExclusions: ["Product pages not linked from the configured sitemap", "Products absent from configured brand source"], disconnectedSources: ["open_food_facts", "gs1_india_datakart", "retailer_offer_feeds"] }; await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8"); return { manifest, stagedPath, exclusionsPath, manifestPath };
}
