import type { CallConfig } from "./graph-types";

const DISCOUNT_PERCENT_MIN = 1;
const DISCOUNT_PERCENT_MAX = 30;

/**
 * Clamp discount percent to the existing tool's 1-30% cap — prevents
 * fat-fingered template or user override from authorizing absurd discounts.
 */
export function clampDiscount(value: number): number {
  if (value <= 0) return 0;
  return Math.min(Math.max(value, DISCOUNT_PERCENT_MIN), DISCOUNT_PERCENT_MAX);
}

/**
 * Resolve the discount percent for the current attempt from a call node's config.
 * Supports both flat number and per-attempt escalating map.
 */
export function resolveDiscountPercent(
  config: CallConfig,
  attemptNumber: number,
): number {
  if (typeof config.discountPercent === "number") {
    return clampDiscount(config.discountPercent);
  }
  const key = String(attemptNumber);
  const value = config.discountPercent[key] ?? 0;
  return clampDiscount(value);
}

/**
 * Compose the cart recovery URL with discount code pre-applied.
 * Shopify auto-applies discounts when ?discount=CODE is in the URL.
 */
export function composeCartRecoveryUrl(
  abandonedCheckoutUrl: string,
  discountCode: string,
): string {
  if (!abandonedCheckoutUrl || !discountCode) return abandonedCheckoutUrl || "";
  const separator = abandonedCheckoutUrl.includes("?") ? "&" : "?";
  return `${abandonedCheckoutUrl}${separator}discount=${encodeURIComponent(discountCode)}`;
}

/**
 * Simple {{merge_tag}} interpolation for SMS and webhook templates.
 */
export function renderTemplate(
  template: string,
  context: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = context[key];
    return value !== undefined ? String(value) : match;
  });
}

/**
 * Build the structured facts block injected into the voice agent's system
 * prompt — same pattern as capturedState's "known facts" block.
 */
export function buildWorkflowFactsBlock(
  context: Record<string, string | number>,
): string {
  const lines: string[] = [];
  if (context.customer_name) lines.push(`Customer: ${context.customer_name}.`);
  // Producers are inconsistent: the Shopify COD and feedback contexts write
  // camelCase `orderId` (read by workflows/engine.ts for the post-call
  // annotate), templates and docs use `order_id`. Accept both — an agent that
  // cannot name the order cannot confirm it.
  const orderRef = context.order_id ?? context.orderId;
  // The amount is emitted even when the producer forgot the currency — a COD
  // confirmation call that cannot state the amount is useless. Without a
  // currency the agent says the bare number rather than guessing one.
  const amountLabel = orderRef ? "Order value" : "Cart value";
  if (context.cart_value && context.currency) {
    lines.push(`${amountLabel}: ${context.currency}${context.cart_value}.`);
  } else if (context.cart_value) {
    lines.push(
      `${amountLabel}: ${context.cart_value} (currency unknown — say the number without naming a currency).`,
    );
  }
  if (orderRef) lines.push(`Order reference: #${orderRef}.`);
  if (context.shop_name) lines.push(`Shop: ${context.shop_name}.`);
  if (context.attempt_number) lines.push(`This is call attempt #${context.attempt_number}.`);
  const discount = Number(context.discount_percent);
  if (discount > 0) {
    lines.push(
      `If offering a discount this call, offer exactly ${discount}%, not more.`,
    );
  }
  if (context.discount_code) {
    lines.push(`Discount code to share: ${context.discount_code}.`);
  }
  if (context.cart_recovery_url) {
    lines.push(`Cart recovery link (with discount): ${context.cart_recovery_url}.`);
  }
  return lines.length > 0 ? lines.join(" ") : "";
}
