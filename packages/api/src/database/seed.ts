import { db } from "./index";
import { agentTemplates, workflowTemplates } from "./schema";
import { eq } from "drizzle-orm";
import { join } from "path";
import { CART_RECOVERY_TEMPLATE } from "../voice/workflows/seed-graph";

export async function seedAgentTemplates() {
  console.log("[db-seed] Seeding agent templates...");
  // packages/api/src/database -> repo root is 4 levels up, not 3 (D5, this
  // audit): the prompt files live at <repo-root>/docs/agent-prompts, not
  // packages/docs/agent-prompts. The off-by-one silently meant every
  // Bun.file(...).exists() check below returned false in every environment
  // (local and Railway alike), so seeding always skipped all 3 templates via
  // `continue` — while still logging "seeded successfully" unconditionally
  // at the end, regardless of whether anything was actually written.
  const promptsDir = join(import.meta.dir, "../../../../docs/agent-prompts");

  const templates = [
    {
      key: "shopify-cart-recovery",
      name: "Shopify Cart Recovery",
      vertical: "shopify",
      description: "Recovers abandoned checkouts by calling customers after they abandon their cart.",
      fileName: "01-cart-recovery-agent.md",
      defaultTools: ["offerCartRecoveryDiscount", "captureField", "setDisposition"],
      active: true,
    },
    {
      key: "shopify-cod-confirmation",
      name: "Shopify COD Confirmation",
      vertical: "shopify",
      description: "Confirms Cash on Delivery orders to reduce RTO (Return to Origin) rates.",
      fileName: "02-cod-confirmation-agent.md",
      defaultTools: ["confirmCodOrder", "captureField", "setDisposition"],
      active: true,
    },
    {
      key: "shopify-feedback",
      name: "Shopify Post-Delivery Feedback",
      vertical: "shopify",
      description: "Calls customers after order fulfillment to collect post-delivery feedback.",
      fileName: "03-feedback-agent.md",
      defaultTools: ["captureField", "setDisposition"],
      active: false,
    },
    {
      key: "insurance-policy-renewal",
      name: "Insurance Policy Renewal Reminder",
      vertical: "insurance",
      description: "Reminds policyholders of an upcoming renewal or premium due date and routes anything beyond a simple confirm/decline to a licensed agent.",
      fileName: "04-insurance-policy-renewal-agent.md",
      defaultTools: ["captureField", "setDisposition", "transferToHuman", "crmSync"],
      active: true,
    },
    {
      key: "insurance-lead-followup",
      name: "Insurance Lead Follow-Up",
      vertical: "insurance",
      description: "Follows up on a new inbound lead, qualifies interest, and books a callback with a licensed advisor.",
      fileName: "05-insurance-lead-followup-agent.md",
      defaultTools: ["captureField", "bookAppointment", "setDisposition", "crmSync"],
      active: true,
    },
  ];

  let seededCount = 0;
  let skippedCount = 0;

  for (const t of templates) {
    try {
      const filePath = join(promptsDir, t.fileName);
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        console.error(`[db-seed] Prompt file does not exist at ${filePath}`);
        skippedCount++;
        continue;
      }
      const promptContent = await file.text();

      const existing = await db
        .select()
        .from(agentTemplates)
        .where(eq(agentTemplates.key, t.key))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(agentTemplates)
          .set({
            name: t.name,
            vertical: t.vertical,
            description: t.description,
            defaultPersonaPrompt: promptContent,
            defaultTools: t.defaultTools,
            active: t.active,
          })
          .where(eq(agentTemplates.key, t.key));
      } else {
        await db.insert(agentTemplates).values({
          key: t.key,
          name: t.name,
          vertical: t.vertical,
          description: t.description,
          defaultPersonaPrompt: promptContent,
          defaultTools: t.defaultTools,
          active: t.active,
        });
      }
      seededCount++;
    } catch (err) {
      console.error(`[db-seed] failed to seed template ${t.key}:`, err);
      skippedCount++;
    }
  }

  // Previously logged "seeded successfully" unconditionally, even when every
  // template was skipped (see the promptsDir path fix above, D5) — that
  // false-positive log line is exactly what let the empty-templates-table
  // bug go unnoticed across every deploy until this audit.
  if (skippedCount > 0) {
    console.error(`[db-seed] ${seededCount}/${templates.length} agent templates seeded, ${skippedCount} skipped — see errors above.`);
  } else {
    console.log(`[db-seed] All ${seededCount} agent templates seeded successfully.`);
  }
}

export async function seedWorkflowTemplates() {
  console.log("[db-seed] Seeding workflow templates...");
  const [existing] = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, CART_RECOVERY_TEMPLATE.id))
    .limit(1);
  if (existing) {
    console.log(`[db-seed] Workflow template "${CART_RECOVERY_TEMPLATE.id}" already exists — skipping.`);
    return;
  }
  await db.insert(workflowTemplates).values({
    id: CART_RECOVERY_TEMPLATE.id,
    vertical: CART_RECOVERY_TEMPLATE.vertical,
    name: CART_RECOVERY_TEMPLATE.name,
    graph: CART_RECOVERY_TEMPLATE.graph,
  });
  console.log(`[db-seed] Workflow template "${CART_RECOVERY_TEMPLATE.id}" seeded.`);
}
