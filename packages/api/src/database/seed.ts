import { db } from "./index";
import { agentTemplates, workflowTemplates } from "./schema";
import { eq } from "drizzle-orm";
import { join } from "path";
import { SHOPIFY_WORKFLOW_TEMPLATES } from "../voice/workflows/seed-graph";

/**
 * Single source of truth for the seeded agent templates — exported (not
 * inlined in seedAgentTemplates) so seed.test.ts can assert every template's
 * `defaultTools` is actually a subset of `AVAILABLE_TOOL_NAMES` (agent-frame.ts)
 * without duplicating this list. Guards against a repeat of the
 * confirmCodOrder/offerCartRecoveryDiscount bug: both tools were listed here
 * and referenced in their script docs' own "Tools" table, but were never
 * added to AVAILABLE_TOOL_NAMES or agent.ts's buildVoiceTools map, so
 * buildVoiceTools silently filtered them out of every call's actual tool
 * list — the model was told (by its own persona) to call a tool it never
 * had, with zero error anywhere. That was only caught by reading a live
 * call's production log line by line, not by any test — this test exists so
 * the next tool addition fails CI instead of shipping silently broken.
 */
export const AGENT_TEMPLATES = [
    {
      key: "shopify-cart-recovery",
      name: "Shopify Cart Recovery",
      vertical: "shopify",
      description: "Recovers abandoned checkouts by calling customers after they abandon their cart.",
      fileName: "01-cart-recovery-agent.md",
      literalGreetingTemplate: "Hi, this is {{agent_name}} calling from {{merchant_name}}. Do you have a quick minute?",
      defaultTools: ["offerCartRecoveryDiscount", "captureField", "setDisposition", "setIntent"],
      active: true,
    },
    {
      key: "shopify-cod-confirmation",
      name: "Shopify COD Confirmation",
      vertical: "shopify",
      description: "Confirms Cash on Delivery orders to reduce RTO (Return to Origin) rates.",
      fileName: "02-cod-confirmation-agent.md",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling from {{merchant_name}}. Can I have two minutes of your time?",
      defaultTools: ["confirmCodOrder", "captureField", "setDisposition", "setIntent"],
      active: true,
    },
    {
      key: "shopify-feedback",
      name: "Shopify Post-Delivery Feedback",
      vertical: "shopify",
      description: "Calls customers after order fulfillment to collect post-delivery feedback.",
      fileName: "03-feedback-agent.md",
      literalGreetingTemplate: "Hi, this is {{agent_name}} from {{merchant_name}}. Your {{product_name}} was delivered recently — do you have a minute to share how it went?",
      defaultTools: ["captureField", "setDisposition", "setIntent"],
      // Confirmed final by the user 2026-07-18 (was drafted without a Bolna reference sample,
      // unlike 01/02 — held inactive pending explicit confirmation per WEEBER-PLAN.md's
      // STOP-AND-ASK gate #4 / project-brief.md item 4). Flipping to active makes it selectable
      // by merchants and eligible for AI-draft (org-queries.ts:118, ai-draft.ts:78 both filter on
      // `active = true`) — takes effect on next boot's seed upsert.
      active: true,
    },
    {
      key: "insurance-policy-renewal",
      name: "Insurance Policy Renewal Reminder",
      vertical: "insurance",
      description: "Reminds policyholders of an upcoming renewal or premium due date and routes anything beyond a simple confirm/decline to a licensed agent.",
      fileName: "04-insurance-policy-renewal-agent.md",
      literalGreetingTemplate: "Hello, this is {{agent_name}} calling on behalf of {{company_name}} — a quick reminder about your policy renewal. Do you have a moment?",
      // flagGuardrailEvent added 2026-07-16 during the India+US regulatory iteration — the script
      // now explicitly calls it on the new "replacement" refusal (see
      // docs/agent-prompts/00-insurance-regulatory-reference.md); would otherwise repeat the
      // confirmCodOrder/offerCartRecoveryDiscount silent-drop bug seed.test.ts guards against.
      defaultTools: ["captureField", "setDisposition", "setIntent", "transferToHuman", "flagGuardrailEvent", "crmSync"],
      active: true,
    },
    {
      key: "insurance-lead-followup",
      name: "Insurance Lead Follow-Up",
      vertical: "insurance",
      description: "Follows up on a new inbound lead, qualifies interest, and books a callback with a licensed advisor.",
      fileName: "05-insurance-lead-followup-agent.md",
      literalGreetingTemplate: "Hi, this is {{agent_name}} calling from {{company_name}} — you'd recently shown interest in {{interest_area}}. Do you have a couple of minutes?",
      // flagGuardrailEvent added 2026-07-16 — same reasoning as insurance-policy-renewal above.
      defaultTools: ["captureField", "bookAppointment", "setDisposition", "setIntent", "flagGuardrailEvent", "crmSync"],
      active: true,
    },
    {
      key: "insurance-appointment-setter",
      name: "Insurance Appointment Setter / Warm-Transfer Router",
      vertical: "insurance",
      description: "Confirms continued interest from an already-warm lead and live-transfers to a licensed advisor, or books a specific callback if no advisor is available.",
      fileName: "06-insurance-appointment-setter-agent.md",
      literalGreetingTemplate: "Hi, is this {{lead_name}}? This is {{agent_name}} with {{company_name}} — you'd recently shown interest in {{interest_area}}, and I'd love to connect you with one of our licensed advisors. Is now a good time?",
      defaultTools: ["captureField", "transferToHuman", "bookAppointment", "flagGuardrailEvent", "setDisposition", "setIntent", "crmSync"],
      active: true,
    },
    {
      key: "insurance-post-sale-welcome",
      name: "Insurance Post-Sale Welcome / Delivery Confirmation",
      vertical: "insurance",
      description: "Welcomes a new policyholder after a policy is issued, confirms documents arrived, and routes any coverage/claims/change/cancel request to a licensed advisor.",
      fileName: "07-insurance-post-sale-welcome-agent.md",
      literalGreetingTemplate: "Hello, is this {{policyholder_name}}? This is {{agent_name}} calling on behalf of {{company_name}} — a quick welcome call now that your new policy is in place. Do you have a moment?",
      defaultTools: ["captureField", "lookupInfo", "transferToHuman", "flagGuardrailEvent", "setDisposition", "setIntent", "crmSync"],
      active: true,
    },
    {
      key: "insurance-feedback-nps",
      name: "Insurance Post-Interaction Feedback / NPS",
      vertical: "insurance",
      description: "Collects a 1-5 satisfaction rating and one open comment after a servicing interaction or claim, routing any complaint to a licensed human without engaging on its merits.",
      fileName: "08-insurance-feedback-nps-agent.md",
      literalGreetingTemplate: "Hi, this is {{agent_name}} from {{company_name}}. I'm following up on {{interaction_type}} — do you have a minute to share how it went?",
      defaultTools: ["captureField", "flagGuardrailEvent", "transferToHuman", "setDisposition", "setIntent", "crmSync"],
      active: true,
    },
  ];

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
  const templates = AGENT_TEMPLATES;

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
            literalGreetingTemplate: t.literalGreetingTemplate ?? null,
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
          literalGreetingTemplate: t.literalGreetingTemplate ?? null,
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
  let seededCount = 0;
  let skippedCount = 0;
  for (const t of SHOPIFY_WORKFLOW_TEMPLATES) {
    try {
      const [existing] = await db
        .select()
        .from(workflowTemplates)
        .where(eq(workflowTemplates.id, t.id))
        .limit(1);
      if (existing) {
        console.log(`[db-seed] Workflow template "${t.id}" already exists — skipping.`);
        skippedCount++;
        continue;
      }
      await db.insert(workflowTemplates).values({
        id: t.id,
        vertical: t.vertical,
        name: t.name,
        graph: t.graph,
      });
      console.log(`[db-seed] Workflow template "${t.id}" seeded.`);
      seededCount++;
    } catch (err) {
      console.error(`[db-seed] failed to seed workflow template ${t.id}:`, err);
      skippedCount++;
    }
  }
  console.log(
    `[db-seed] Workflow templates: ${seededCount} seeded, ${skippedCount} skipped (of ${SHOPIFY_WORKFLOW_TEMPLATES.length}).`,
  );
}
