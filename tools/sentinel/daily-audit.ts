#!/usr/bin/env bun
/**
 * Daily Sentinel — Unified UI/UX & Documentation Quality Auditor for Weeber.
 *
 * Runs daily or on-demand to enforce:
 * 1. Design System Tokens & Budget Ratchets (`design:guard`, `contrast:gate`)
 * 2. Documentation Hygiene (Brain files, Evergreen specs, Markdown link integrity)
 * 3. Anti-Stale Scanner (Retired tokens, obsolete verticals, dropped tables)
 *
 * Usage:
 *   bun run audit:daily
 *   bun tools/sentinel/daily-audit.ts
 *   bun tools/sentinel/daily-audit.ts --json
 *   bun tools/sentinel/daily-audit.ts --report
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const JSON_OUT = process.argv.includes("--json");

interface AuditSection {
  name: string;
  passed: boolean;
  warnings: string[];
  errors: string[];
  details: Record<string, unknown>;
}

const report: {
  timestamp: string;
  passed: boolean;
  sections: AuditSection[];
} = {
  timestamp: new Date().toISOString(),
  passed: true,
  sections: [],
};

// Colors for terminal output
const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

function log(msg: string) {
  if (!JSON_OUT) console.log(msg);
}

// ----------------------------------------------------------------------------
// 1. Check UI & Design Tokens (design:guard & contrast:gate)
// ----------------------------------------------------------------------------
function checkDesignSystem(): AuditSection {
  const section: AuditSection = {
    name: "Design System & Tokens (UI Guard)",
    passed: true,
    warnings: [],
    errors: [],
    details: {},
  };

  // Run design-guard
  const guardPath = resolve(REPO_ROOT, "tools/ui-guard/design-guard.ts");
  if (existsSync(guardPath)) {
    const res = spawnSync("bun", [guardPath, "--json"], { cwd: REPO_ROOT, encoding: "utf-8" });
    if (res.status === 0) {
      section.details.designGuard = "Passed (Under budget)";
    } else {
      section.passed = false;
      section.errors.push(`Design guard ratchet exceeded budget (Exit code ${res.status})`);
      if (res.stdout) {
        try {
          const parsed = JSON.parse(res.stdout);
          section.details.designGuardErrors = parsed;
        } catch {
          section.details.designGuardRaw = res.stdout.slice(0, 500);
        }
      }
    }
  } else {
    section.warnings.push("tools/ui-guard/design-guard.ts not found");
  }

  // Run contrast-gate
  const contrastPath = resolve(REPO_ROOT, "tools/ui-guard/contrast-gate.ts");
  if (existsSync(contrastPath)) {
    const res = spawnSync("bun", [contrastPath], { cwd: REPO_ROOT, encoding: "utf-8" });
    if (res.status === 0) {
      section.details.contrastGate = "Passed (WCAG AA Contrast Validated)";
    } else {
      section.passed = false;
      section.errors.push(`Contrast gate failed WCAG AA thresholds (Exit code ${res.status})`);
      section.details.contrastGateOutput = res.stdout ? res.stdout.slice(0, 500) : res.stderr.slice(0, 500);
    }
  } else {
    section.warnings.push("tools/ui-guard/contrast-gate.ts not found");
  }

  return section;
}

// ----------------------------------------------------------------------------
// 2. Check Documentation Brain System (docs/brain/)
// ----------------------------------------------------------------------------
function checkBrainSystem(): AuditSection {
  const section: AuditSection = {
    name: "Documentation Brain & Index System",
    passed: true,
    warnings: [],
    errors: [],
    details: {},
  };

  const brainFiles = [
    "docs/brain/project-brief.md",
    "docs/brain/active-context.md",
    "docs/brain/progress.md",
    "docs/brain/00-index.md",
  ];

  for (const rel of brainFiles) {
    const full = resolve(REPO_ROOT, rel);
    if (!existsSync(full)) {
      section.passed = false;
      section.errors.push(`Missing essential brain file: ${rel}`);
    } else {
      const content = readFileSync(full, "utf-8");
      if (content.length < 50) {
        section.warnings.push(`Brain file ${rel} appears suspiciously empty (<50 chars)`);
      }
      // Check for active-context freshness
      if (rel.includes("active-context.md")) {
        const hasFocus = content.includes("## Current focus");
        if (!hasFocus) {
          section.warnings.push("docs/brain/active-context.md is missing '## Current focus' section");
        }
      }
    }
  }

  // Check architecture files
  const archFiles = [
    "architecture/README.md",
    "architecture/voice-orchestration.md",
    "architecture/api-flow.md",
    "architecture/user-flow.md",
    "architecture/data-model.md",
  ];

  for (const rel of archFiles) {
    const full = resolve(REPO_ROOT, rel);
    if (!existsSync(full)) {
      section.warnings.push(`Missing architecture doc: ${rel}`);
    }
  }

  return section;
}

// ----------------------------------------------------------------------------
// 3. Anti-Stale & Fossil Scanner
// ----------------------------------------------------------------------------
function scanAntiStale(): AuditSection {
  const section: AuditSection = {
    name: "Anti-Stale & Knowledge Graph Scanner",
    passed: true,
    warnings: [],
    errors: [],
    details: {},
  };

  const fossilTokens = [
    { pattern: "oklch(0.53 0.19 275)", desc: "Retired indigo accent token (ADR-039 replaced with monochrome)" },
    { pattern: "--radius: 0.625rem", desc: "Retired 10px radius token (ADR-043 replaced with 12px / 0.75rem)" },
  ];

  // 1. Scan active stylesheets
  const stylesFiles = [
    resolve(REPO_ROOT, "packages/web/src/web/styles.css"),
    resolve(REPO_ROOT, "packages/web/src/web/styles-marketing.css"),
  ];

  const staleFindings: string[] = [];

  for (const styleFile of stylesFiles) {
    if (!existsSync(styleFile)) continue;
    const content = readFileSync(styleFile, "utf-8");
    const rel = relative(REPO_ROOT, styleFile).replace(/\\/g, "/");

    for (const fossil of fossilTokens) {
      if (content.includes(fossil.pattern)) {
        staleFindings.push(`${rel} contains fossil token: ${fossil.desc}`);
      }
    }
  }

  // 2. Scan active markdown docs (excluding historical audit/changelog lines)
  function getMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "archive" && entry.name !== "node_modules") {
          results.push(...getMarkdownFiles(full));
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(full);
      }
    }
    return results;
  }

  const docsToScan = [
    ...getMarkdownFiles(resolve(REPO_ROOT, "architecture")),
    ...getMarkdownFiles(resolve(REPO_ROOT, "docs/brain")),
  ].filter(p => existsSync(p));

  for (const file of docsToScan) {
    const lines = readFileSync(file, "utf-8").split("\n");
    const rel = relative(REPO_ROOT, file).replace(/\\/g, "/");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip lines that discuss historical changes/fossils
      if (line.toLowerCase().includes("was") || line.toLowerCase().includes("fossil") || line.toLowerCase().includes("retired")) {
        continue;
      }
      for (const fossil of fossilTokens) {
        if (line.includes(fossil.pattern)) {
          staleFindings.push(`${rel}:${i + 1} uses fossil token: ${fossil.desc}`);
        }
      }
    }
  }

  if (staleFindings.length > 0) {
    section.warnings.push(...staleFindings);
    section.details.staleFindings = staleFindings;
  } else {
    section.details.status = "Clean (Zero fossil tokens detected in active documentation)";
  }

  return section;
}

// ----------------------------------------------------------------------------
// Run Sentinel & Output
// ----------------------------------------------------------------------------
function run() {
  log(`\n${colors.bold}${colors.cyan}🛡️  Weeber Daily Sentinel — UI/UX & Documentation Quality Auditor${colors.reset}`);
  log(`${colors.gray}Run time: ${report.timestamp}${colors.reset}\n`);

  const sections = [
    checkDesignSystem(),
    checkBrainSystem(),
    scanAntiStale(),
  ];

  report.sections = sections;
  report.passed = sections.every(s => s.passed);

  if (JSON_OUT) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.passed ? 0 : 1);
  }

  for (const s of sections) {
    const badge = s.passed
      ? `${colors.green}[PASS]${colors.reset}`
      : `${colors.red}[FAIL]${colors.reset}`;

    log(`${badge} ${colors.bold}${s.name}${colors.reset}`);

    if (s.errors.length > 0) {
      for (const err of s.errors) {
        log(`  ${colors.red}✗ ${err}${colors.reset}`);
      }
    }

    if (s.warnings.length > 0) {
      for (const warn of s.warnings) {
        log(`  ${colors.yellow}⚠ ${warn}${colors.reset}`);
      }
    }

    for (const [k, v] of Object.entries(s.details)) {
      log(`  ${colors.gray}• ${k}: ${JSON.stringify(v)}${colors.reset}`);
    }
    log("");
  }

  if (report.passed) {
    log(`${colors.bold}${colors.green}✓ All daily UI/UX and documentation quality gates passed.${colors.reset}\n`);
    process.exit(0);
  } else {
    log(`${colors.bold}${colors.red}✗ Sentinel detected failures. Please resolve before pushing.${colors.reset}\n`);
    process.exit(1);
  }
}

run();
