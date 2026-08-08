/**
 * HIPAA guardrail. Code cannot verify a signed Business Associate Agreement —
 * that's a legal contract between the operator and each vendor touching PHI
 * (telephony provider, STT provider, TTS provider, LLM provider). What code
 * CAN do is refuse to silently assume compliance: when HIPAA mode is
 * enabled, `assertHipaaPreflight` throws unless the operator has also
 * explicitly confirmed BAAs are in place — a deliberate human checkpoint,
 * meant to be called once at process boot so a misconfigured deployment
 * fails loudly before it ever handles a call, not silently after.
 *
 * This is a guardrail, not a compliance certification. Enabling HIPAA mode
 * does not make your deployment "HIPAA compliant" by itself — it removes one
 * common failure mode (nobody actually checked).
 */
export type HipaaOptions = {
  enabled?: boolean;
  baaConfirmed?: boolean;
  retentionDays?: number;
};

function readEnv(key: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[key] : undefined;
}

export function isHipaaMode(options: HipaaOptions = {}): boolean {
  if (options.enabled !== undefined) return options.enabled;
  return (readEnv("COMPLIANCE_MODE") ?? "").toLowerCase() === "hipaa";
}

export function assertHipaaPreflight(options: HipaaOptions = {}): void {
  if (!isHipaaMode(options)) return;

  const confirmed = options.baaConfirmed !== undefined ? options.baaConfirmed : readEnv("HIPAA_BAA_CONFIRMED") === "true";

  if (!confirmed) {
    throw new Error(
      "HIPAA mode is enabled but BAA confirmation is missing. Refusing to start: confirm Business " +
        "Associate Agreements are signed with every vendor in the pipeline that may touch PHI " +
        "(telephony, STT, TTS, LLM providers) before enabling HIPAA mode. This confirmation is a " +
        "deliberate human checkpoint, not a technical verification — this package cannot confirm a " +
        "legal contract exists on your behalf.",
    );
  }
}

/** In HIPAA mode, use a shorter default retention window unless overridden. */
export function getHipaaRetentionDays(options: HipaaOptions = {}): number {
  if (options.retentionDays !== undefined) return options.retentionDays;
  const configured = readEnv("HIPAA_RETENTION_DAYS");
  return configured ? Number(configured) : 30;
}
