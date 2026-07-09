import { describe, it, expect, beforeEach } from "bun:test";
import { resilientCall, __resetBreakersForTests } from "./resilient-fetch";

describe("resilientCall", () => {
  beforeEach(() => {
    __resetBreakersForTests();
  });

  it("returns ok:true with the data on a successful call", async () => {
    const result = await resilientCall(async () => "success", { integration: "test-a" });
    expect(result).toEqual({ ok: true, data: "success" });
  });

  it("retries a failing call up to maxAttempts before giving up", async () => {
    let attempts = 0;
    const result = await resilientCall(
      async () => {
        attempts += 1;
        throw new Error("boom");
      },
      { integration: "test-b", maxAttempts: 3, retryDelayMs: 1 },
    );
    expect(attempts).toBe(3);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("error");
      expect(result.message).toContain("boom");
    }
  });

  it("succeeds on a later attempt without exhausting all retries", async () => {
    let attempts = 0;
    const result = await resilientCall(
      async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("transient");
        return "recovered";
      },
      { integration: "test-c", maxAttempts: 3, retryDelayMs: 1 },
    );
    expect(attempts).toBe(2);
    expect(result).toEqual({ ok: true, data: "recovered" });
  });

  it("reports a timeout distinctly from a generic error", async () => {
    const result = await resilientCall(
      (signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
      { integration: "test-d", timeoutMs: 10, maxAttempts: 1 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("timeout");
      expect(result.message).toContain("timed out");
    }
  });

  it("opens the circuit after repeated failures and short-circuits further calls", async () => {
    let callCount = 0;
    const failingFn = async () => {
      callCount += 1;
      throw new Error("down");
    };

    // 3 consecutive failed calls (each with maxAttempts:1) trips the breaker.
    await resilientCall(failingFn, { integration: "test-e", maxAttempts: 1, retryDelayMs: 1 });
    await resilientCall(failingFn, { integration: "test-e", maxAttempts: 1, retryDelayMs: 1 });
    await resilientCall(failingFn, { integration: "test-e", maxAttempts: 1, retryDelayMs: 1 });
    expect(callCount).toBe(3);

    // Breaker should now be open — fn is never invoked again.
    const result = await resilientCall(failingFn, { integration: "test-e", maxAttempts: 1 });
    expect(callCount).toBe(3); // unchanged — fn was not called
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("circuit-open");
    }
  });

  it("keeps separate breaker state per integration name", async () => {
    const failingFn = async () => {
      throw new Error("down");
    };

    for (let i = 0; i < 3; i++) {
      await resilientCall(failingFn, { integration: "test-f-one", maxAttempts: 1, retryDelayMs: 1 });
    }
    // A different integration name should be unaffected by test-f-one's open breaker.
    const result = await resilientCall(async () => "fine", { integration: "test-f-two" });
    expect(result).toEqual({ ok: true, data: "fine" });
  });

  it("a success resets the failure count (does not accumulate toward tripping the breaker)", async () => {
    let shouldFail = true;
    const flakyFn = async () => {
      if (shouldFail) throw new Error("flaky");
      return "ok";
    };

    await resilientCall(flakyFn, { integration: "test-g", maxAttempts: 1, retryDelayMs: 1 });
    await resilientCall(flakyFn, { integration: "test-g", maxAttempts: 1, retryDelayMs: 1 });
    shouldFail = false;
    const recovered = await resilientCall(flakyFn, { integration: "test-g", maxAttempts: 1 });
    expect(recovered).toEqual({ ok: true, data: "ok" });

    // Failure count was reset by the success above, so one more failure alone
    // shouldn't trip the breaker (threshold is 3 consecutive failures).
    shouldFail = true;
    const afterOneMoreFailure = await resilientCall(flakyFn, {
      integration: "test-g",
      maxAttempts: 1,
      retryDelayMs: 1,
    });
    expect(afterOneMoreFailure.ok).toBe(false);
    if (!afterOneMoreFailure.ok) {
      expect(afterOneMoreFailure.reason).toBe("error"); // not circuit-open
    }
  });
});
