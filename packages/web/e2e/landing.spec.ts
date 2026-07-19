import { expect, test } from "@playwright/test";

/**
 * Happy-path E2E for the public landing page — the site's single conversion
 * surface. Runs against the built + previewed bundle (see playwright.config.ts).
 * Everything asserted here is client-side and backend-free, so it stays
 * deterministic in CI.
 */
test.describe("public landing page", () => {
  test("renders the hero and the waitlist form", async ({ page }) => {
    await page.goto("/");

    // The document title is baked into index.html (static, crawlable).
    await expect(page).toHaveTitle(/Weeber/);

    // Hero headline is server-static content, so it must be present on load.
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Every call you miss");

    // The waitlist form (the conversion CTA) hydrates and is interactive.
    await expect(page.getByLabel("Your name")).toBeVisible();
    await expect(page.getByLabel("Business email")).toBeVisible();
  });

  test("gates the waitlist submit on client-side validation", async ({ page }) => {
    await page.goto("/");

    const submit = page.getByRole("button", { name: "Get early access" });
    // Nothing filled in yet → CTA is disabled.
    await expect(submit).toBeDisabled();

    // A name plus an invalid email must NOT unlock the button.
    await page.getByLabel("Your name").fill("Rushikesh");
    await page.getByLabel("Business email").fill("not-an-email");
    await expect(submit).toBeDisabled();

    // Correcting the email to a valid one unlocks it — all in-browser, no API.
    await page.getByLabel("Business email").fill("r@weeber.ai");
    await expect(submit).toBeEnabled();
  });
});
