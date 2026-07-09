/**
 * Retry-once helper for critical DB writes. A single transient network blip
 * (e.g. ECONNRESET to Turso) currently means a write is silently lost forever
 * — this wraps a write so it gets one retry with a short delay before giving
 * up and logging loudly instead of swallowing the failure.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  { retries = 1, delayMs = 300, label = "db-write" }: { retries?: number; delayMs?: number; label?: string } = {},
): Promise<T | undefined> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.warn(`[${label}] write failed (attempt ${attempt + 1}/${retries + 1}), retrying...`, err);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  console.error(`[${label}] write failed after ${retries + 1} attempts — giving up`, lastErr);
  return undefined;
}
