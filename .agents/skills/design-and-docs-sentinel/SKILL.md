---
name: design-and-docs-sentinel
description:
  Unified daily UI/UX design system and documentation health routine. Use to audit
  design token drift, verify WCAG AA color contrast, check documentation freshness,
  validate Mermaid architecture diagrams, and prune stale fossils.
license: MIT
metadata:
  author: weeber-team
  version: '1.0.0'
---

# Design & Documentation Sentinel (Daily Workflow)

This skill provides a standardized routine for auditing, maintaining, and certifying the health of Weeber's **Web UI/UX Design System** and **Living Documentation Architecture**.

## When to Run

- **Daily Routine:** Every morning or at the start of a coding/review session.
- **Pre-PR / Pre-Merge:** Before merging any changes affecting `packages/web/`, `architecture/`, or `docs/`.
- **Scheduled Trigger:** Can be run automatically via cron or `/schedule` (`0 9 * * *`).

---

## 🛠️ Step 1: Run Automated Sentinel Audit

Execute the unified auditor from repo root:

```bash
bun run audit:daily
```

This automatically validates:
1. **Design Token Drift (`design:guard`):** Checks against `tools/ui-guard/design-budget.json` (arbitrary px, raw button/select tags, unstyled cards).
2. **WCAG AA Contrast (`contrast:gate`):** Verifies light/dark mode color pairs against WCAG AA standards (`4.5:1` text, `3:1` UI controls).
3. **Brain Completeness:** Verifies required files (`docs/brain/project-brief.md`, `active-context.md`, `progress.md`, `00-index.md`).
4. **Anti-Stale & Fossil Scanner:** Flags retired design tokens or obsolete vertical declarations.

---

## 🎨 Step 2: UI/UX & Visual Regression Inspection

When UI components or stylesheets have changed:

```bash
# 1. Start UI dev preview
cd packages/web && bun run dev

# 2. Check font loading & typography integrity
bun run test:fonts

# 3. Check automated accessibility tree
bun run test:a11y

# 4. Check Playwright visual regression snapshots
bun run test:visual
```

### Key UI/UX Checkpoints:
- [ ] Are `.theme-weeber` tokens respected on `/app` and `/dashboard`?
- [ ] Is `--radius` set to `12px` (`0.75rem`)?
- [ ] Are status colors using semantic badges (`-soft` background + strong text)?
- [ ] Do all icon-only buttons declare `aria-label`?
- [ ] Is there zero sub-12px text?

---

## 📚 Step 3: Documentation & Brain Synchronization

Review and update the active brain state:

1. **[`docs/brain/active-context.md`](file:///docs/brain/active-context.md):**
   - Record current focus, last completed task, and next immediate milestone.
2. **[`docs/brain/progress.md`](file:///docs/brain/progress.md):**
   - Shift finished items from *In Progress* to *Shipped / Completed*.
3. **[`architecture/*.md`](file:///architecture/):**
   - Ensure Mermaid sequence diagrams and ER diagrams match schema changes and new API routes.
4. **Knowledge Graph Links:**
   - Ensure all inter-document links use relative markdown paths that Obsidian and GitHub can navigate.

---

## 🧹 Step 4: Anti-Stale Protocol

Check for and resolve documentation fossils:
- **Retired tokens:** e.g., indigo `oklch(0.53 0.19 275)` or 10px radius.
- **Fictional verticals:** Only **`shopify`** and **`insurance`** are active. Never describe clinic/hotel as current features.
- **Schema discrepancies:** Check `packages/api/src/database/schema.ts` against `architecture/data-model.md`.

---

## 📊 Summary Output Format

When reporting results of the daily audit, format output using this template:

```markdown
### 🛡️ Daily Sentinel Report (YYYY-MM-DD)

- **UI/UX & Design Guard:** [PASS / WARN / FAIL] (X/Y violations within budget)
- **WCAG AA Contrast Gate:** [PASS / WARN / FAIL] (X/42 pairs passing)
- **Living Brain & Architecture:** [PASS / WARN / FAIL] (Zero broken links)
- **Anti-Stale Health:** [PASS / WARN / FAIL] (Zero fossil tokens)

**Actions Taken / Next Steps:**
1. ...
```
