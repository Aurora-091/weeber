import { describe, it, expect } from "bun:test";
import {
  screenOutboundText,
  screenToolArguments,
  extractPhoneCandidates,
  normalizePhone,
  describeOutboundTextScreen,
  GUARDED_TEXT_ARGS,
} from "./outbound-text-guard";
import { withOutboundTextGuard, buildVoiceTools } from "./agent";

/** The two messages production call 25 actually sent, verbatim. */
const CALL_25_PLACEHOLDER_SMS =
  "PersistentAds: Here's the advisor's number for your records: [Advisor Desk Number]. " +
  "A licensed advisor will be with you shortly.";
const CALL_25_FABRICATED_SMS =
  "PersistentAds: Please contact your licensed advisor at 888-555-0199 for assistance with your " +
  "final expense insurance options.";

describe("screenOutboundText — the two messages call 25 sent", () => {
  it("refuses the unresolved bracket placeholder", () => {
    const screen = screenOutboundText(CALL_25_PLACEHOLDER_SMS, { allowedNumbers: ["+14155550100"] });
    expect(screen.allowed).toBe(false);
    expect(screen.findings).toContain("bracket-placeholder");
  });

  it("refuses the invented advisor number", () => {
    const screen = screenOutboundText(CALL_25_FABRICATED_SMS, { allowedNumbers: ["+14155550100"] });
    expect(screen.allowed).toBe(false);
    expect(screen.findings).toContain("unverified-phone-number");
    expect(screen.unverifiedNumbers).toEqual(["8885550199"]);
  });

  it("would have allowed that same message if the org had actually configured that number", () => {
    // The point of the provenance rule: the text is not the problem, the
    // absence of a source for it is. This is the exact scenario ADR-105's
    // `humanTransferNumber` fix creates.
    const screen = screenOutboundText(CALL_25_FABRICATED_SMS, { allowedNumbers: ["+1 (888) 555-0199"] });
    expect(screen.allowed).toBe(true);
    expect(screen.findings).toEqual([]);
  });

  it("allows a number the caller said themselves", () => {
    const screen = screenOutboundText("Got it — I'll have someone call you back on 9876543210.", {
      allowedNumbers: ["9876543210"],
    });
    expect(screen.allowed).toBe(true);
  });
});

describe("screenOutboundText — what it must not refuse", () => {
  it("allows ordinary prose with no numbers at all", () => {
    const screen = screenOutboundText("Thanks for your time — a licensed advisor will call you shortly.");
    expect(screen.allowed).toBe(true);
    expect(screen.findings).toEqual([]);
  });

  it("does not treat an ISO date-time as a phone number", () => {
    // bookAppointment carries a real one, and notes legitimately mention dates.
    const screen = screenOutboundText("Booked for 2026-08-12T14:30:00 as agreed.");
    expect(screen.allowed).toBe(true);
  });

  it("does not treat an order number or an amount as a phone number", () => {
    const screen = screenOutboundText("Order ORD-48213, total 12,500 rupees, 45 minutes from now.");
    expect(screen.allowed).toBe(true);
  });

  it("allows a bracketed lowercase aside, which is prose rather than a slot", () => {
    const screen = screenOutboundText("We'll follow up [as discussed] tomorrow.");
    expect(screen.allowed).toBe(true);
  });
});

describe("screenOutboundText — leaked model syntax in writing", () => {
  it("refuses tool-call envelope syntax", () => {
    // The exact leak measured on a gateway 8B deployment for ADR-104, in the
    // written channel instead of the spoken one.
    const screen = screenOutboundText('3"}</function>Your order is confirmed.');
    expect(screen.allowed).toBe(false);
    expect(screen.findings).toContain("tool-syntax");
  });

  it("refuses rather than scrubbing — an SMS is atomic, unlike a half-spoken sentence", () => {
    const screen = screenOutboundText(CALL_25_PLACEHOLDER_SMS);
    expect(screen.allowed).toBe(false);
    // The screen deliberately returns no repaired text to send instead.
    expect(Object.keys(screen)).toEqual(["allowed", "findings", "unverifiedNumbers"]);
  });
});

describe("normalizePhone / extractPhoneCandidates", () => {
  it("treats country-code and formatting variants of one number as the same number", () => {
    const forms = ["+1 888 555 0199", "18885550199", "(888) 555-0199", "888.555.0199"];
    const normalized = new Set(forms.map(normalizePhone));
    expect(normalized.size).toBe(1);
  });

  it("ignores digit runs shorter than a dialable number", () => {
    expect(extractPhoneCandidates("call 555-0199 back")).toEqual([]);
  });

  it("ignores digit runs longer than E.164 allows", () => {
    expect(extractPhoneCandidates("ref 1234567890123456789")).toEqual([]);
  });

  it("de-duplicates a number repeated in different formats", () => {
    expect(extractPhoneCandidates("either +1 888 555 0199 or (888) 555-0199")).toEqual(["8885550199"]);
  });
});

describe("describeOutboundTextScreen", () => {
  it("names the findings and the offending numbers, so a log line is usable evidence", () => {
    const screen = screenOutboundText(CALL_25_FABRICATED_SMS);
    const described = describeOutboundTextScreen(screen);
    expect(described).toContain("unverified-phone-number");
    expect(described).toContain("8885550199");
  });
});

describe("screenToolArguments", () => {
  it("screens crmSync notes", () => {
    const refusal = screenToolArguments("crmSync", {
      callerName: "Dana",
      notes: "Qualified. Advisor desk is 888-555-0199.",
    });
    expect(refusal?.field).toBe("notes");
  });

  it("screens bookAppointment notes but never its dateTimeIso", () => {
    const refusal = screenToolArguments("bookAppointment", {
      callerName: "Dana",
      dateTimeIso: "2026-08-12T14:30:00Z",
      notes: "Follow-up call.",
    });
    expect(refusal).toBeNull();
  });

  it("returns null for a tool with no guarded free-text fields", () => {
    expect(screenToolArguments("hangUp", { reason: "caller said goodbye" })).toBeNull();
  });

  it("returns null for a non-object input", () => {
    expect(screenToolArguments("sendSms", "not an object")).toBeNull();
  });

  it("reports the first failing field, so the refusal message names one thing to fix", () => {
    const refusal = screenToolArguments("crmSync", {
      callerName: "[Caller Name]",
      notes: "Reach them on 888-555-0199.",
    });
    expect(refusal?.field).toBe("callerName");
  });
});

describe("withOutboundTextGuard", () => {
  const stubTool = (name: string) => ({
    execute: async (args: unknown) => ({ ran: true, args, name }),
  });

  it("refuses the call instead of executing it, and tells the model why", async () => {
    let refused: { toolName: string; field: string } | null = null;
    const guarded = withOutboundTextGuard(stubTool("crmSync") as never, "crmSync", {
      allowedNumbers: () => [],
      onRefusal: (toolName, field) => {
        refused = { toolName, field };
      },
    }) as unknown as { execute: (args: unknown) => Promise<Record<string, unknown>> };

    const result = await guarded.execute({ notes: "Advisor desk is 888-555-0199." });
    expect(result.refused).toBe(true);
    expect(result.field).toBe("notes");
    expect(String(result.message)).toContain("Rewrite it");
    expect(refused as unknown).toEqual({ toolName: "crmSync", field: "notes" });
  });

  it("passes a clean call straight through", async () => {
    const guarded = withOutboundTextGuard(stubTool("crmSync") as never, "crmSync", {
      allowedNumbers: () => [],
    }) as unknown as { execute: (args: unknown) => Promise<Record<string, unknown>> };
    const result = await guarded.execute({ notes: "Qualified, wants an advisor callback." });
    expect(result.ran).toBe(true);
  });

  it("reads allowedNumbers at call time, not at construction time", async () => {
    // The number the caller reads out on turn six is a number the agent may
    // repeat on turn seven. A snapshot would refuse exactly that case.
    const spoken: string[] = [];
    const guarded = withOutboundTextGuard(stubTool("crmSync") as never, "crmSync", {
      allowedNumbers: () => spoken,
    }) as unknown as { execute: (args: unknown) => Promise<Record<string, unknown>> };

    const before = await guarded.execute({ notes: "Best number is 9876543210." });
    expect(before.refused).toBe(true);

    spoken.push("9876543210");
    const after = await guarded.execute({ notes: "Best number is 9876543210." });
    expect(after.ran).toBe(true);
  });

  it("leaves an unguarded tool untouched", () => {
    const def = stubTool("hangUp");
    expect(withOutboundTextGuard(def as never, "hangUp", { allowedNumbers: () => [] })).toBe(def as never);
  });

  it("leaves every tool untouched when no context is supplied — the harness and test-chat case", () => {
    const def = stubTool("crmSync");
    expect(withOutboundTextGuard(def as never, "crmSync", undefined)).toBe(def as never);
  });
});

describe("the guard is actually wired into every call's tool set", () => {
  // ADR-090's class: a guard with tests and no caller. `sendSms` is excluded on
  // purpose — its execute() is signal-only and stream.ts owns the send, which
  // this asserts stays true.
  it("bookAppointment is wrapped when a context is supplied", async () => {
    const tools = buildVoiceTools(undefined, undefined, undefined, undefined, undefined, undefined, {
      allowedNumbers: () => [],
    }) as unknown as Record<string, { execute?: (args: unknown) => Promise<unknown> }>;
    const result = (await tools.bookAppointment?.execute?.({
      callerName: "Dana",
      dateTimeIso: "2026-08-12T14:30:00Z",
      notes: "Call the advisor desk on 888-555-0199.",
    })) as Record<string, unknown>;
    expect(result.refused).toBe(true);
  });

  it("is a no-op on the same tool when no context is supplied", async () => {
    const tools = buildVoiceTools(undefined) as unknown as Record<
      string,
      { execute?: (args: unknown) => Promise<unknown> }
    >;
    const result = (await tools.bookAppointment?.execute?.({
      callerName: "Dana",
      dateTimeIso: "2026-08-12T14:30:00Z",
      notes: "Call the advisor desk on 888-555-0199.",
    })) as Record<string, unknown>;
    expect(result.refused).toBeUndefined();
  });

  it("sendSms is declared guarded but screened in stream.ts, where its side effect lives", async () => {
    expect(GUARDED_TEXT_ARGS.sendSms).toEqual(["body"]);
    const source = await Bun.file(new URL("./stream.ts", import.meta.url)).text();
    const smsBlock = source.slice(source.indexOf('if (name === "sendSms"'));
    const screenAt = smsBlock.indexOf("screenOutboundText(smsBody");
    const sendAt = smsBlock.indexOf("sendSmsForOrg(");
    expect(screenAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(screenAt);
  });
});
