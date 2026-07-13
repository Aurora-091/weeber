/**
 * Per-key fixed-window limiter, reused for anything that reaches a metered
 * upstream (paid TTS API, paid LLM calls) so a single org/actor can't be
 * unmetered — see app/routes.ts's previewRateLimited/testChatRateLimited
 * and voice/test-call-tokens.ts's test-call issuance limiter, each with
 * their own window/keyspace. Process-local, resets on restart — fine for a
 * single-instance deployment, same tradeoff already accepted by
 * middleware/rate-limit.ts's outbound-call limiter.
 */
export function makeFixedWindowLimiter(windowMs: number, maxPerWindow: number) {
  const windows = new Map<string, { start: number; count: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const window = windows.get(key);
    if (!window || now - window.start >= windowMs) {
      windows.set(key, { start: now, count: 1 });
      return false;
    }
    window.count += 1;
    return window.count > maxPerWindow;
  };
}
