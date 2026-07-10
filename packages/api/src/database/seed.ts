import { db } from "./index";
import { agentTemplates } from "./schema";
import { eq } from "drizzle-orm";
import { join } from "path";

export async function seedAgentTemplates() {
  console.log("[db-seed] Seeding agent templates...");
  const promptsDir = join(import.meta.dir, "../../../docs/agent-prompts");

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
  ];

  for (const t of templates) {
    try {
      const filePath = join(promptsDir, t.fileName);
      const file = Bun.file(filePath);
      if (!(await file.exists())) {
        console.error(`[db-seed] Prompt file does not exist at ${filePath}`);
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
    } catch (err) {
      console.error(`[db-seed] failed to seed template ${t.key}:`, err);
    }
  }
  console.log("[db-seed] Agent templates seeded successfully.");
}
