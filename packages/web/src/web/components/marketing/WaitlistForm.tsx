import { useState } from "react";
import { ArrowRight, Check, Circle as XCircle, CircleCheck as CheckCircle2, Copy, Mail, Phone, Share2, Sparkles } from "lucide-react";
import { useCopy } from "../../lib/useCopy";
import { apiFetch } from "../../lib/api";
import { useWaitlistCount } from "../../lib/useWaitlistCount";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";

/**
 * Shared waitlist join form — extracted from landing.tsx's original inline
 * `HeroForm` (same component, same backend contract) so /shopify and any
 * other marketing page can embed a real, working "Get early access" form
 * instead of just linking back to Home's `#waitlist` anchor. Behavior is
 * byte-identical to the original Home hero form; only the file moved.
 */

const BASE_COUNT = 43;

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone: string) {
  if (!phone) return true;
  return /^\+?[\d\s\-()]{7,20}$/.test(phone);
}

type JoinResponse =
  | { joined: true; alreadyJoined: true; ownReferralCode: string | null }
  | { joined: true; alreadyJoined: false; ownReferralCode: string; position: number; displayCount: number }
  | { error: string };

function ReferralShare({ referralCode }: { referralCode: string }) {
  const { copied, copy } = useCopy({ message: "Referral link copied!", timeout: 2000 });
  const referralUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/?ref=${referralCode}`;
  const shareText = "I just joined the Weeber waitlist — AI voice agents that book, recover carts, and follow up. 24/7, no code. Join here:";
  const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(`${shareText} ${referralUrl}`)}`;
  const canNativeShare = typeof navigator !== "undefined" && Boolean(navigator.share);

  function handleNativeShare() {
    if (navigator.share) {
      navigator.share({ title: "Weeber — AI Voice Agents", text: shareText, url: referralUrl }).catch(() => {});
    }
  }

  return (
    <div className="mt-5">
      <p className="text-[12.5px] font-medium text-[var(--m-text-secondary)] mb-2">Your referral link</p>
      <div className="flex items-center gap-2 bg-[var(--m-bg-alt)] border border-[var(--m-border)] rounded-lg px-3.5 py-2.5">
        <span className="flex-1 text-[13px] font-mono text-[var(--m-text-muted)] truncate select-all">{referralUrl}</span>
        <button
          type="button"
          onClick={() => copy(referralUrl)}
          className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-md bg-[var(--m-text)] text-[var(--m-bg)] hover:opacity-90 transition-opacity flex-shrink-0"
        >
          {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <a
          href={whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-md border border-[var(--m-border)] text-[var(--m-text)] hover:bg-[var(--m-surface)] transition-colors"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z" />
            <path d="M12 0C5.373 0 0 5.373 0 12c0 2.136.563 4.14 1.547 5.878L0 24l6.335-1.517A11.945 11.945 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 21.818a9.818 9.818 0 01-5.015-1.378l-.36-.214-3.727.893.943-3.618-.235-.372A9.764 9.764 0 012.182 12C2.182 6.57 6.57 2.182 12 2.182S21.818 6.57 21.818 12 17.43 21.818 12 21.818z" />
          </svg>
          WhatsApp
        </a>
        {canNativeShare && (
          <button type="button" onClick={handleNativeShare} className="flex items-center gap-1.5 text-[12px] font-semibold px-3 py-1.5 rounded-md border border-[var(--m-border)] text-[var(--m-text)] hover:bg-[var(--m-surface)] transition-colors">
            <Share2 className="w-3.5 h-3.5" />
            Share
          </button>
        )}
        <p className="text-[11.5px] text-[var(--m-text-muted)] flex items-center gap-1 ml-auto">
          <ArrowRight className="w-3 h-3" />
          Each referral moves you up 2 spots
        </p>
      </div>
    </div>
  );
}

/** `source` is passed through to POST /api/public/waitlist for
 * page-level attribution (e.g. "landing" vs "shopify-solution"). */
export function WaitlistForm({ source = "landing" }: { source?: string }) {
  const { count } = useWaitlistCount();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState({ name: false, email: false });
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);
  const [referralCode, setReferralCode] = useState("");
  const [submittedEmail, setSubmittedEmail] = useState("");
  const [alreadyJoined, setAlreadyJoined] = useState(false);

  const [phone, setPhone] = useState("");
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneSaved, setPhoneSaved] = useState(false);

  const emailValid = isValidEmail(email);
  const nameValid = name.trim().length > 0;
  const phoneValid = isValidPhone(phone);
  const canSubmit = nameValid && emailValid;
  const liveDisplayCount = Math.max(BASE_COUNT, count ?? BASE_COUNT);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ name: true, email: true });
    if (!nameValid) {
      document.getElementById("waitlist-name")?.focus();
      return;
    }
    if (!emailValid) {
      document.getElementById("waitlist-email")?.focus();
      return;
    }
    if (!canSubmit) return;
    setState("loading");
    setErrorMsg("");

    const urlRef = new URLSearchParams(window.location.search).get("ref") ?? undefined;

    try {
      const res = await apiFetch("/api/public/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), source, referralCode: urlRef }),
      });
      const data: JoinResponse = await res.json().catch(() => ({ error: "Something went wrong. Try again or email hello@weeber.ai" }));
      if (!res.ok || "error" in data) {
        setState("error");
        setErrorMsg("error" in data ? data.error : "Something went wrong. Try again or email hello@weeber.ai");
        return;
      }
      setState("success");
      setSubmittedEmail(email.trim());
      setAlreadyJoined(data.alreadyJoined);
      setReferralCode(data.alreadyJoined ? (data.ownReferralCode ?? "") : data.ownReferralCode);
      setShowSuccess(true);
    } catch {
      setState("error");
      setErrorMsg("Couldn't reach the server. Try again or email hello@weeber.ai");
    }
  }

  async function handlePhoneSave() {
    if (!phoneValid || !phone.trim() || !submittedEmail) return;
    setPhoneSaving(true);
    try {
      const res = await apiFetch("/api/public/waitlist/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: submittedEmail, phone: phone.trim() }),
      });
      if (res.ok) setPhoneSaved(true);
    } catch {
      // non-critical — silently ignore
    } finally {
      setPhoneSaving(false);
    }
  }

  const inputClass =
    "w-full h-12 px-4 pr-10 text-[16px] font-medium bg-[var(--m-surface)] border-[1.5px] border-[var(--m-input-border)] text-[var(--m-text)] placeholder:text-[var(--m-text-muted)] placeholder:font-normal shadow-[var(--m-input-shadow)] focus:border-[var(--m-text)] focus:outline-none focus:shadow-[0_0_0_3px_var(--m-input-focus-ring)] transition-all rounded-lg";
  const inputErrorClass = "border-red-400 focus:border-red-500 focus:shadow-[0_0_0_3px_rgba(239,68,68,0.15)]";

  return (
    <div className="max-w-[430px] mx-auto">
      <form onSubmit={handleSubmit} className="space-y-2.5" noValidate>
        <div className="relative">
          <input
            type="text"
            id="waitlist-name"
            name="name"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setTouched((t) => ({ ...t, name: true }));
            }}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            placeholder="Your name"
            aria-label="Your name"
            aria-invalid={touched.name && !nameValid ? "true" : undefined}
            aria-describedby={touched.name && !nameValid ? "name-error" : undefined}
            className={`${inputClass} ${touched.name && !nameValid ? inputErrorClass : ""}`}
          />
          {touched.name && name.length >= 1 && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true">
              {nameValid ? <CheckCircle2 className="w-4 h-4 text-[#22C55E]" /> : <XCircle className="w-4 h-4 text-red-500" />}
            </span>
          )}
          {touched.name && !nameValid && (
            <p id="name-error" className="mt-1 text-[11.5px] text-red-500 font-medium">
              Please enter your name.
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type="email"
              id="waitlist-email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setTouched((t) => ({ ...t, email: true }));
              }}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              placeholder="you@yourbrand.com"
              aria-label="Business email"
              aria-invalid={touched.email && !emailValid ? "true" : undefined}
              aria-describedby={touched.email && !emailValid ? "email-error" : undefined}
              className={`${inputClass} ${touched.email && !emailValid ? inputErrorClass : ""}`}
            />
            {touched.email && email.length >= 3 && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true">
                {emailValid ? <CheckCircle2 className="w-4 h-4 text-[#22C55E]" /> : <XCircle className="w-4 h-4 text-red-500" />}
              </span>
            )}
          </div>
          <button
            type="submit"
            disabled={state === "loading" || !canSubmit}
            className="h-12 px-7 text-[1rem] font-semibold bg-[var(--m-accent-bg)] text-[var(--m-accent-fg)] border-none rounded-lg hover:opacity-[0.85] transition-opacity disabled:opacity-50 btn-press whitespace-nowrap cursor-pointer"
          >
            {state === "loading" ? "Joining..." : "Get early access"}
          </button>
        </div>
        {touched.email && !emailValid && email.length >= 3 && (
          <p id="email-error" className="text-[11.5px] text-red-500 font-medium -mt-1">
            Please enter a valid email address.
          </p>
        )}

        {state === "error" && <p className="text-xs text-red-600">{errorMsg}</p>}
      </form>

      <p className="mt-4 text-[13px] text-center text-[var(--m-text-muted)]">
        First 100 customers lock in <span className="font-bold text-[var(--m-text)]">founder pricing.</span>
      </p>

      <Dialog open={showSuccess} onOpenChange={setShowSuccess}>
        <DialogContent className="marketing sm:max-w-[560px] p-0 !bg-white dark:!bg-[#0A0A0A] text-[var(--m-text)] border border-[#E6E5E2] dark:border-[rgba(255,255,255,0.12)] shadow-[0_24px_80px_-12px_rgba(0,0,0,0.25)] dark:shadow-[0_24px_80px_-12px_rgba(0,0,0,0.7)] overflow-hidden [&_button[data-slot=dialog-close]]:text-[var(--m-text-secondary)] [&_button[data-slot=dialog-close]]:hover:text-[var(--m-text)]">
          <div className="px-8 pt-8 pb-8">
            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-[#22C55E]/10 border border-[#22C55E]/20 mb-6">
              <Sparkles className="w-7 h-7 text-[#22C55E]" />
            </div>
            <DialogHeader className="text-left">
              <DialogTitle className="font-display text-[26px] md:text-[30px] font-extrabold tracking-[-0.035em] leading-[1.1] text-[var(--m-text)]">
                {alreadyJoined ? "You're already on the list." : <>You're in — #{liveDisplayCount} in line.</>}
              </DialogTitle>
              <DialogDescription className="text-[var(--m-text-secondary)] mt-3 text-[15px] leading-relaxed">
                {alreadyJoined ? "We'll reach out at that email when a slot opens up." : "Every referral moves you up 2 spots. Share your link and skip the queue."}
              </DialogDescription>
            </DialogHeader>

            <div className="mt-6 flex items-center gap-3 px-4 py-3.5 bg-[#F3F2EF] dark:bg-[#141414] border border-[#E6E5E2] dark:border-[rgba(255,255,255,0.08)] rounded-lg">
              <Mail className="w-4 h-4 text-[var(--m-text-secondary)] flex-shrink-0" />
              <span className="text-sm text-[var(--m-text)] truncate flex-1">{submittedEmail}</span>
              <span className="text-[11px] font-mono text-[#22C55E] bg-[#22C55E]/10 px-2 py-0.5 rounded font-medium">Confirmed</span>
            </div>

            {!phoneSaved ? (
              <div className="mt-4">
                <p className="text-[12.5px] font-medium text-[var(--m-text-secondary)] mb-2">
                  Add your phone <span className="text-[var(--m-text-muted)] font-normal">(optional — we'll text when you're up next)</span>
                </p>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--m-text-muted)]" aria-hidden="true" />
                    <input
                      type="tel"
                      name="tel"
                      autoComplete="tel"
                      inputMode="tel"
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value);
                        setPhoneTouched(true);
                      }}
                      placeholder="+91 98765 43210"
                      aria-label="Phone number (optional)"
                      aria-invalid={phoneTouched && phone.length >= 3 && !phoneValid ? "true" : undefined}
                      aria-describedby={phoneTouched && phone.length >= 3 && !phoneValid ? "phone-error" : undefined}
                      className="w-full h-10 pl-8 pr-3 text-[14px] bg-[var(--m-surface)] border-[1.5px] border-[var(--m-input-border)] text-[var(--m-text)] placeholder:text-[var(--m-text-muted)] focus:border-[var(--m-text)] focus:outline-none rounded-lg transition-all"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={phoneSaving || !phone.trim() || !phoneValid}
                    onClick={handlePhoneSave}
                    className="h-10 px-4 text-[13px] font-semibold bg-[var(--m-text)] text-[var(--m-bg)] rounded-lg hover:opacity-80 transition-opacity disabled:opacity-40 whitespace-nowrap cursor-pointer"
                  >
                    {phoneSaving ? "Saving..." : "Save"}
                  </button>
                </div>
                {phoneTouched && phone.length >= 3 && !phoneValid && (
                  <p id="phone-error" className="mt-1 text-[11px] text-red-500">
                    Include country code, e.g. +91 98765 43210
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-4 flex items-center gap-2 text-[13px] text-[#22C55E]">
                <CheckCircle2 className="w-4 h-4" />
                Phone saved — we'll text you when your spot opens.
              </div>
            )}

            {referralCode && <ReferralShare referralCode={referralCode} />}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
