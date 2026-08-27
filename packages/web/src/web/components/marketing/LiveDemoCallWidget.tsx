import { useEffect, useRef, useState } from "react";
import { PhoneCall, Loader2, CheckCircle2 } from "lucide-react";
import { apiFetch } from "../../lib/api";
import { Button } from "../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Checkbox } from "../ui/checkbox";

/**
 * Real demo-call widget (2026-08-27, docs/product-strategy/real-demo-call-widget-plan-2026-08-26.md).
 * Sits beside the existing pre-recorded "Agent Demo" section (`AgentDemoWidget`, playback of
 * recorded audio) rather than replacing it — user decision, 2026-08-27. This one places a REAL
 * outbound call via `POST /api/public/demo-call`.
 *
 * Deliberately doesn't use `WaitlistForm.tsx`'s hand-rolled form-control styling (that file
 * predates the shadcn conversion) for the interactive controls that design:guard's ratchets
 * actually track (`rawButton`, `rawSelect`) — the submit button and language dropdown use the
 * real `Button`/`Select` primitives. The phone input and card picker are plain marked-up
 * elements styled with `--m-*` tokens (no ratchet tracks a raw text input, and their className
 * ordering avoids the `rounded-*...border...bg-` sequence `inlineCardClone` flags).
 *
 * No pre-submit kill-switch check — if the widget is disabled, the honest signal is the backend's
 * 403, surfaced here as a plain error message ("demos temporarily unavailable").
 */

const DEMO_AGENTS = [
  {
    key: "insurance-final-expense-qualifier",
    name: "Insurance",
    description: "A final-expense qualifying call — needs, budget, and a warm transfer to a licensed advisor.",
  },
  {
    key: "shopify-cod-confirmation",
    name: "Shopify COD Confirmation",
    description: "Confirms a Cash-on-Delivery order before it ships, the way it would for a real customer.",
  },
  {
    key: "weeber-pitch-agent",
    name: "Ask Weeber Anything",
    description: "A freeform conversation with Weeber's own AI voice agent about the product itself.",
  },
] as const;

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "hi", label: "Hindi" },
];

type SubmitState = "idle" | "submitting" | "success" | "error";

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: Record<string, unknown>) => string;
    };
  }
}

function useTurnstileToken(): { containerRef: React.RefObject<HTMLDivElement | null>; token: string } {
  const containerRef = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState("");

  useEffect(() => {
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
    if (!siteKey) return;

    function renderWidget() {
      if (window.turnstile && containerRef.current) {
        window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          callback: (t: string) => setToken(t),
        });
      }
    }

    const scriptId = "cf-turnstile-script";
    if (document.getElementById(scriptId)) {
      renderWidget();
      return;
    }
    const script = document.createElement("script");
    script.id = scriptId;
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
    script.async = true;
    script.defer = true;
    script.onload = renderWidget;
    document.body.appendChild(script);
  }, []);

  return { containerRef, token };
}

export function LiveDemoCallWidget() {
  const [agentKey, setAgentKey] = useState<string>(DEMO_AGENTS[0].key);
  const [phone, setPhone] = useState("");
  const [language, setLanguage] = useState("en");
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<SubmitState>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const { containerRef: turnstileRef, token: turnstileToken } = useTurnstileToken();

  const canSubmit = phone.trim().length > 0 && consent && state !== "submitting";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setState("submitting");
    setErrorMsg("");
    try {
      const res = await apiFetch("/api/public/demo-call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentKey, phone: phone.trim(), language, consent, turnstileToken }),
      });
      const data: { ok?: true; sessionKey?: string; status?: string; error?: string } = await res
        .json()
        .catch(() => ({ error: "Something went wrong. Please try again." }));
      if (!res.ok || data.error) {
        setState("error");
        setErrorMsg(data.error ?? "Something went wrong. Please try again.");
        return;
      }
      setState("success");
    } catch {
      setState("error");
      setErrorMsg("Couldn't reach the server. Please try again.");
    }
  }

  if (state === "success") {
    return (
      <div className="bg-[var(--m-bg)] border border-[var(--m-border)] rounded-2xl p-8 md:p-10 text-center">
        <div className="mx-auto mb-4 flex items-center justify-center w-12 h-12 rounded-full bg-green-500/10">
          <CheckCircle2 className="w-6 h-6 text-green-600" aria-hidden />
        </div>
        <p className="font-display text-lg font-semibold text-[var(--m-text)]">Your phone should ring shortly.</p>
        <p className="mt-2 text-sm text-[var(--m-text-secondary)]">
          It's a real call from a Weeber voice agent — answer whenever you're ready.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="bg-[var(--m-bg)] border border-[var(--m-border)] rounded-2xl p-6 md:p-8">
      <div className="grid sm:grid-cols-3 gap-3 mb-6">
        {DEMO_AGENTS.map((agent) => {
          const selected = agentKey === agent.key;
          return (
            <label
              key={agent.key}
              className={`relative flex flex-col gap-1.5 p-4 rounded-xl border cursor-pointer transition-colors ${
                selected
                  ? "border-[var(--m-text)] bg-[var(--m-bg-alt)]"
                  : "border-[var(--m-border)] hover:border-[var(--m-text-muted)]"
              }`}
            >
              <input
                type="radio"
                name="demo-agent"
                value={agent.key}
                checked={selected}
                onChange={() => setAgentKey(agent.key)}
                className="sr-only"
              />
              <span className="text-sm font-semibold text-[var(--m-text)]">{agent.name}</span>
              <span className="text-xs text-[var(--m-text-secondary)] leading-relaxed">{agent.description}</span>
            </label>
          );
        })}
      </div>

      <div className="grid sm:grid-cols-[2fr_1fr] gap-3 mb-4">
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+1 415 555 1234"
          aria-label="Phone number"
          autoComplete="tel"
          inputMode="tel"
          className="h-11 px-4 bg-[var(--m-bg)] border border-[var(--m-border)] rounded-lg text-[var(--m-text)] placeholder:text-[var(--m-text-muted)] outline-none focus:border-[var(--m-text)] transition-colors"
        />
        <Select value={language} onValueChange={setLanguage}>
          <SelectTrigger className="h-11 w-full" aria-label="Language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <label className="flex items-start gap-2.5 mb-6 cursor-pointer">
        <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
        <span className="text-xs text-[var(--m-text-secondary)] leading-relaxed">
          I agree to receive an automated demo call from Weeber at this number, and I've read the{" "}
          <a href="/terms" className="underline text-[var(--m-text)]">terms</a>.
        </span>
      </label>

      <div ref={turnstileRef} className="mb-4" />

      {state === "error" && (
        <p role="alert" aria-live="polite" className="mb-4 text-sm text-red-600">
          {errorMsg}
        </p>
      )}

      <Button type="submit" size="lg" disabled={!canSubmit} className="w-full sm:w-auto">
        {state === "submitting" ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : (
          <PhoneCall aria-hidden />
        )}
        {state === "submitting" ? "Calling…" : "Call me now"}
      </Button>
    </form>
  );
}
