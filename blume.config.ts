import { defineConfig } from "blume";

// Blume is the PRESENTATION and search layer for the docs/ tree.
// The Markdown files under docs/ are the source of truth. Do not edit
// generated files under .blume/ or dist-docs/ — they are gitignored.
//
// Run locally:   pnpm docs:dev
// Build static:  pnpm docs:build  (output: dist-docs/)
// Validate:      pnpm docs:validate
//
// See https://useblume.dev/docs/configuration for the full option reference.
export default defineConfig({
  title: "Protein Index",
  description:
    "Normalized Indian protein-product intelligence database — repository knowledge system.",

  content: {
    root: "docs",
  },

  // The docs are not a marketing site; keep the theme quiet and readable.
  theme: {
    accent: "teal",
    radius: "md",
    mode: "system",
  },

  search: {
    provider: "orama",
  },

  markdown: {
    imageZoom: true,
    code: {
      icons: true,
      wrap: false,
    },
    codeBlocks: {
      theme: {
        light: "github-light",
        dark: "github-dark",
      },
    },
  },

  // Expose the docs tree to agents via llms.txt. The repository's own
  // /llms.txt (served by the Worker) describes the product surfaces; this one
  // describes the documentation site.
  ai: {
    llmsTxt: true,
  },

  seo: {
    og: { enabled: true },
    sitemap: true,
    robots: true,
    structuredData: true,
  },

  deployment: {
    output: "static",
    // Update this to the real docs URL when the docs site is hosted.
    site: "https://protein.significanthobbies.com/docs",
  },
});
