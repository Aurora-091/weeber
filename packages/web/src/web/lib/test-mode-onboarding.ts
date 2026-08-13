/**
 * Onboarding's "are you testing, or calling real customers?" step.
 *
 * The decision logic lives here rather than inside `setup-modal.tsx` on
 * ADR-111's precedent (`classifyReadiness`): the one rule worth asserting is
 * *when the answer is allowed to write to the server*, and a rule buried in a
 * click handler inside an 800-line modal is a rule no test reaches.
 *
 * What test mode actually is (see `POST /api/app/compliance/test-mode` and
 * `voice/compliance/insurance-gates.ts`): a self-expiring 24h org-scoped
 * bypass of the calling-window check and the two insurance config gates
 * (1600-series number, producer licensing). It never lifts DNC and never lifts
 * the FTSA attempt cap — ADR-108's `TEST_MODE_BYPASSABLE` is the list, and
 * those two are deliberately absent from it. Any copy this module feeds must
 * say so, because a merchant who reads "compliance off" and then dials a
 * scrubbed list has been misled by us.
 */

export type TestModeState = {
  /** Bypass currently in force. */
  active: boolean;
  /** A timestamp exists and is in the past — the state worth naming loudest,
   * since the toggle reads "off" either way but here a gate that passed
   * yesterday will refuse the next call. */
  expired: boolean;
  until: Date | null;
};

export function resolveTestModeState(until: string | Date | null | undefined, now = Date.now()): TestModeState {
  if (!until) return { active: false, expired: false, until: null };
  const date = until instanceof Date ? until : new Date(until);
  if (Number.isNaN(date.getTime())) return { active: false, expired: false, until: null };
  const active = date.getTime() > now;
  return { active, expired: !active, until: date };
}

/**
 * Whether answering the onboarding question should actually call
 * `POST /compliance/test-mode`.
 *
 * "Yes" always posts — it is what arms the 24h window, and re-arming it is the
 * point of answering yes.
 *
 * "No" posts **only when a window is currently active**, and that asymmetry is
 * the whole reason this is a function. Posting `enabled: false` for an org that
 * never had test mode on is a write that changes nothing, and it would fire on
 * every fresh signup; posting it for an org whose window *is* live is a
 * deliberate revocation the merchant just asked for by saying these are real
 * customers. An expired window needs no post either — the column is already
 * spent, and clearing it would erase the one piece of evidence ADR-108's
 * lapsed-test-mode hint reads to explain why a call was refused.
 */
export function shouldPostTestMode(answer: "testing" | "real-customers", state: TestModeState): boolean {
  return answer === "testing" ? true : state.active;
}

/** Review-step summary. Never says "compliance off" — see the module note. */
export function summarizeTestMode(state: TestModeState): string {
  if (state.active) return "On — expires within 24 hours. DNC and call-attempt limits still apply.";
  if (state.expired) return "Off — it lapsed, so the next call runs every gate.";
  return "Off — every compliance gate applies.";
}
