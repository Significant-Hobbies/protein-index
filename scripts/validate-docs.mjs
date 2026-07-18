#!/usr/bin/env node
// Validate the docs/ Markdown knowledge system.
//
// Checks:
//   1. Every .md file under docs/ has YAML frontmatter with a non-empty `title`.
//   2. Every Markdown link and every relative path link resolves to a file
//      that exists in the repository (or is an allowed external/anchor link).
//   3. No link points into gitignored generated dirs (.blume/, dist-docs/).
//
// Markdown in docs/ is the source of truth; this script keeps it internally
// consistent. It does not require Blume or any dependency — just Node.
//
// Usage: node scripts/validate-docs.mjs
//        pnpm docs:validate

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const IGNORED_DIRS = new Set([".blume", ".blume-verify", "dist-docs", "node_modules"]);

const exit = (code) => process.exit(code);

function fail(file, line, message) {
  const where = file ? `${relative(ROOT, file)}:${line}` : "<unknown>";
  console.error(`✖ ${where} — ${message}`);
  return 1;
}

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      out.push(...(await walk(join(dir, entry.name))));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return { ok: false, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { ok: false, body: text };
  const fm = text.slice(3, end);
  const body = text.slice(end + 4);
  const titleMatch = fm.match(/^title:\s*(.+?)\s*$/m);
  return { ok: true, title: titleMatch ? titleMatch[1].replace(/^["']|["']$/g, "") : "", body };
}

// Match [label](target) where target is not preceded by a backtick (code span).
const LINK_RE = /(?<!`)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// Match bare path references in backticks that look like repo paths, e.g.
// `docs/foo.md`, `scripts/bar.ts`, `migrations/0001_*.sql`. We only validate
// the ones that start with a known repo-relative prefix to avoid noise.
const BARE_PATH_RE = /`((?:docs|scripts|shared|worker|src|test|migrations|public|config|openspec|review-decisions|benchmarks|data)(?:\/[^\s`]+)?)`/g;

// Skip bare paths that are clearly templates (contain <, >, {, }) rather than
// real file references. These appear in prose like `openspec/changes/<slug>/`.
function isTemplatePath(p) {
  return /[<>{}]/.test(p);
}

function stripHeadingAnchor(target) {
  const hashIdx = target.indexOf("#");
  if (hashIdx === -1) return { path: target, anchor: null };
  return { path: target.slice(0, hashIdx), anchor: target.slice(hashIdx + 1) };
}

async function pathExists(absPath) {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveLinkTarget(fromFile, rawTarget, files) {
  // External links are out of scope for local validation.
  if (/^[a-z]+:\/\//i.test(rawTarget) || rawTarget.startsWith("mailto:")) {
    return { ok: true, external: true };
  }
  // Pure anchor links refer to the current file.
  if (rawTarget.startsWith("#")) {
    return { ok: true, anchor: true };
  }

  const { path: targetPath, anchor } = stripHeadingAnchor(rawTarget);

  // Absolute repo-relative paths (start with /).
  let abs;
  if (targetPath.startsWith("/")) {
    abs = join(ROOT, targetPath.slice(1));
  } else {
    abs = resolve(dirname(fromFile), targetPath);
  }

  // Reject links into ignored generated dirs.
  const relToRoot = relative(ROOT, abs);
  if (relToRoot && relToRoot.split(sep)[0] && IGNORED_DIRS.has(relToRoot.split(sep)[0])) {
    return { ok: false, reason: `points into gitignored generated dir "${relToRoot.split(sep)[0]}/"` };
  }

  const exists = await pathExists(abs);
  if (!exists) {
    return { ok: false, reason: `target not found: ${relative(ROOT, abs) || targetPath}` };
  }

  // For .md links with an anchor, verify the heading exists in the target.
  if (anchor && extname(abs) === ".md") {
    const targetText = await readFile(abs, "utf8");
    const headingSlug = anchor.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-");
    const headings = [...targetText.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map((m) =>
      m[1].toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-")
    );
    if (!headings.includes(headingSlug)) {
      return { ok: false, reason: `anchor "#${anchor}" not found in ${relative(ROOT, abs)}` };
    }
  }

  return { ok: true };
}

async function main() {
  let errors = 0;
  const files = await walk(DOCS);
  if (files.length === 0) {
    console.error("✖ no Markdown files found under docs/");
    exit(1);
  }

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const fm = parseFrontmatter(text);
    if (!fm.ok) {
      errors += fail(file, 1, "missing YAML frontmatter (expected ---\\ntitle: ...\\n---)");
      continue;
    }
    if (!fm.title || !fm.title.trim()) {
      errors += fail(file, 1, "frontmatter is missing a non-empty `title`");
    }

    const lines = text.split("\n");
    let match;
    // Validate [label](target) links.
    for (let i = 0; i < lines.length; i++) {
      LINK_RE.lastIndex = 0;
      while ((match = LINK_RE.exec(lines[i])) !== null) {
        const target = match[2];
        const res = await resolveLinkTarget(file, target, files);
        if (!res.ok) {
          errors += fail(file, i + 1, `broken link "${target}": ${res.reason}`);
        }
      }
    }
    // Validate bare repo-relative paths in backticks.
    for (let i = 0; i < lines.length; i++) {
      BARE_PATH_RE.lastIndex = 0;
      while ((match = BARE_PATH_RE.exec(lines[i])) !== null) {
        const target = match[1];
        if (isTemplatePath(target)) continue;
        const abs = join(ROOT, target);
        const relToRoot = relative(ROOT, abs);
        if (relToRoot && relToRoot.split(sep)[0] && IGNORED_DIRS.has(relToRoot.split(sep)[0])) {
          errors += fail(file, i + 1, `path points into gitignored dir: \`${target}\``);
          continue;
        }
        if (!(await pathExists(abs))) {
          errors += fail(file, i + 1, `path not found: \`${target}\``);
        }
      }
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} docs validation error(s).`);
    exit(1);
  }
  console.log(`✔ docs validated: ${files.length} file(s), all links resolve.`);
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
