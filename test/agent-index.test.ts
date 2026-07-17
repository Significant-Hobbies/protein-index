import { describe, expect, it } from "vitest";
import {
  INDEX_MD,
  LLMS_TXT,
  buildApiAiCatalog,
  productToMarkdown,
} from "../worker/agent-index";

describe("agent-index surfaces", () => {
  it("llms.txt is agent-readable markdown/text", () => {
    expect(LLMS_TXT.startsWith("# Protein Index")).toBe(true);
    expect(LLMS_TXT).toContain("/api/ai");
    expect(LLMS_TXT).not.toContain("<!doctype");
  });

  it("index.md describes the product for agents", () => {
    expect(INDEX_MD.startsWith("# Protein Index")).toBe(true);
    expect(INDEX_MD).toContain("verified label evidence");
  });

  it("api/ai catalog matches fleet contract", () => {
    const cat = buildApiAiCatalog("https://protein.significanthobbies.com");
    expect(cat.name).toBe("Protein Index");
    expect(cat.llms).toContain("/llms.txt");
    expect(Array.isArray(cat.surfaces)).toBe(true);
    expect(cat.surfaces.some((s) => s.id === "home")).toBe(true);
    expect(cat.markdown.negotiation).toBe(true);
  });

  it("formats product markdown without inventing fields", () => {
    const md = productToMarkdown({
      id: "abc",
      name: "Test Protein",
      brand: "Acme",
      gtin: "123",
    });
    expect(md).toContain("# Test Protein");
    expect(md).toContain("Acme");
    expect(md).toContain("/api/products/abc");
  });
});
