/**
 * Client for the inbound direction of the weebersh <-> Weeber contract
 * (Weeber -> weebersh, contract.md endpoints 9-11). weebersh does NOT hand
 * Weeber a Shopify access token — it holds and refreshes its own offline
 * session per shop and performs the actual Shopify write itself. Weeber's
 * job is just to call the right weebersh endpoint with the right body and
 * handle weebersh's (honest, unlike the outbound direction) status codes.
 *
 * Per contract.md: "Weeber is the caller and already retries on 5xx per
 * its own logic" — so callers of these functions should treat a thrown
 * error (5xx or network failure) as retryable and a resolved 4xx-shaped
 * result as terminal (don't blindly retry a 422 forever).
 */

function weebershBaseUrl(): string {
  // weebersh's own application_url (shopify.app.toml), NOT WEEBER_API_URL —
  // that env var is the other direction (weebersh's own outbound target).
  const url = process.env.WEEBERSH_APP_URL;
  if (!url) throw new Error("WEEBERSH_APP_URL not configured — cannot call back into weebersh");
  return url.replace(/\/$/, "");
}

function callbackSecret(): string {
  const secret = process.env.WEEBER_CALLBACK_SECRET;
  if (!secret) throw new Error("WEEBER_CALLBACK_SECRET not configured — cannot call back into weebersh");
  return secret;
}

async function postToWeebersh<T>(path: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${weebershBaseUrl()}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Weeber-Callback-Secret": callbackSecret(),
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as T;
  return { status: res.status, data };
}

export type AnnotateOrderInput = {
  shop: string;
  orderId: number;
  tagsAdd?: string[];
  note?: string;
};

/** Contract endpoint 9 — POST /api/weeber/orders/annotate */
export async function annotateOrder(input: AnnotateOrderInput) {
  return postToWeebersh<{ order_id: number; tags_added: string[]; note?: string }>("/api/weeber/orders/annotate", {
    shop: input.shop,
    order_id: input.orderId,
    tags_add: input.tagsAdd ?? [],
    note: input.note,
  });
}

export type CancelOrderInput = {
  shop: string;
  orderId: number;
  reason: "CUSTOMER" | "DECLINED" | "FRAUD" | "INVENTORY" | "STAFF" | "OTHER";
  notifyCustomer?: boolean;
  restock?: boolean;
  staffNote?: string;
};

/** Contract endpoint 10 — POST /api/weeber/orders/cancel */
export async function cancelOrder(input: CancelOrderInput) {
  return postToWeebersh<{ order_id: number; status: "processing" | "already_cancelled"; job_id?: string }>(
    "/api/weeber/orders/cancel",
    {
      shop: input.shop,
      order_id: input.orderId,
      reason: input.reason,
      notify_customer: input.notifyCustomer ?? false,
      restock: input.restock ?? true,
      staff_note: input.staffNote,
    },
  );
}

export type CreateDiscountInput = {
  shop: string;
  /** Must be stable/retry-safe (e.g. suffixed with the checkout token) — a fresh random code per retry breaks idempotency per the contract. */
  code: string;
  title: string;
  valueType: "percentage" | "fixed_amount";
  value: number;
  usageLimit?: number;
  appliesOncePerCustomer?: boolean;
};

/** Contract endpoint 11 — POST /api/weeber/discounts/create */
export async function createDiscount(input: CreateDiscountInput) {
  return postToWeebersh<{ code: string; status: "created" | "already_exists"; discount_id?: string }>(
    "/api/weeber/discounts/create",
    {
      shop: input.shop,
      code: input.code,
      title: input.title,
      value_type: input.valueType,
      value: input.value,
      usage_limit: input.usageLimit ?? 1,
      applies_once_per_customer: input.appliesOncePerCustomer ?? true,
    },
  );
}
