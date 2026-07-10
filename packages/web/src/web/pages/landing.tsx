import { useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Check, Copy, Loader2, PhoneCall, Share2, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { useTheme } from "../lib/theme";
import { cn } from "../lib/utils";
import { apiFetch } from "../lib/api";
import { useWaitlistCount } from "../lib/useWaitlistCount";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog";

const FEATURES = [
  {
    icon: PhoneCall,
    title: "Vertical voice agents",
    body: "Pre-built for Shopify (order status, abandoned-cart recovery) and clinics (booking, reminders, no-show follow-up). Not a generic bot builder.",
  },
  {
    icon: ShieldCheck,
    title: "Compliance baked in",
    body: "TCPA-aware calling windows, Do-Not-Call list enforcement, and a full audit trail on every outbound call — not bolted on after the fact.",
  },
  {
    icon: Zap,
    title: "Live in an afternoon",
    body: "Answer a short setup wizard, upload your knowledge base, get a phone number. No prompt engineering required.",
  },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[\d\s\-()]{7,20}$/;

type JoinResponse =
  | { joined: true; alreadyJoined: true; ownReferralCode: string | null }
  | { joined: true; alreadyJoined: false; ownReferralCode: string; position: number; displayCount: number }
  | { error: string };

/** Referral share/copy block shown on the success dialog — the whole point
 * of the referral system is making this link trivially easy to grab. */
function ReferralShare({ referralCode }: { referralCode: string }) {
  const [copied, setCopied] = useState(false);
  const referralUrl = `${window.location.origin}/?ref=${referralCode}`;
  const shareText = "I just joined the Weeber waitlist — AI voice agents that book, recover carts, and follow up. 24/7, no code. Join here:";
  const canShare = typeof navigator !== "undefined" && Boolean(navigator.share);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(referralUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be blocked (permissions/insecure context) — the
      // link is still selectable text, so this is a soft failure.
    }
  }

  return (
    <div className="mt-5">
      <p className="mb-2 text-xs font-medium text-muted-foreground">Your referral link</p>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <span className="flex-1 truncate select-all font-mono text-xs text-muted-foreground">{referralUrl}</span>
        <button
          type="button"
          onClick={copyLink}
          className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
        >
          {copied ? <Check className="size-3" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
        {canShare && (
          <button
            type="button"
            onClick={() => navigator.share({ title: "Weeber — AI Voice Agents", text: shareText, url: referralUrl }).catch(() => {})}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <Share2 className="size-3" aria-hidden />
            Share
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Every referral moves you up 2 spots in line.</p>
    </div>
  );
}

function WaitlistForm() {
  const { count } = useWaitlistCount();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [referralCode, setReferralCode] = useState("");
  const [displayCount, setDisplayCount] = useState<number | null>(null);
  const [submittedEmail, setSubmittedEmail] = useState("");

  const [phone, setPhone] = useState("");
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneSaved, setPhoneSaved] = useState(false);

  // Referral code from a shared link (?ref=weeber-xxxxxxx), captured once on
  // mount — carried through to the join request whether the visitor scrolls
  // straight to the form or reads the page first.
  const [referredByCode] = useState(() => new URLSearchParams(window.location.search).get("ref") ?? undefined);

  const nameValid = name.trim().length > 0;
  const emailValid = EMAIL_RE.test(email);
  const canSubmit = nameValid && emailValid && !pending;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    if (!nameValid || !emailValid) return;
    setPending(true);
    setError(null);
    try {
      const res = await apiFetch("/api/public/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          source: "landing",
          referralCode: referredByCode,
        }),
      });
      const data: JoinResponse = await res.json().catch(() => ({ error: "Something went wrong — try again." }));
      if (!res.ok || "error" in data) {
        setError("error" in data ? data.error : "Something went wrong — try again.");
        return;
      }
      setSubmittedEmail(email.trim());
      if (!data.alreadyJoined) {
        setReferralCode(data.ownReferralCode);
        setDisplayCount(data.displayCount);
      } else {
        setReferralCode(data.ownReferralCode ?? "");
      }
      setShowSuccess(true);
    } catch {
      setError("Couldn't reach the server — try again.");
    } finally {
      setPending(false);
    }
  }

  async function savePhone() {
    if (!PHONE_RE.test(phone) || !phone.trim() || !submittedEmail) return;
    setPhoneSaving(true);
    try {
      const res = await apiFetch("/api/public/waitlist/phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: submittedEmail, phone: phone.trim() }),
      });
      if (res.ok) setPhoneSaved(true);
    } catch {
      // Non-critical follow-up — silently ignore, the person is already on the list.
    } finally {
      setPhoneSaving(false);
    }
  }

  return (
    <>
      <form onSubmit={submit} className="mx-auto mt-8 flex max-w-md flex-col gap-2" noValidate>
        <Input
          type="text"
          required
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(true)}
          disabled={pending}
          aria-invalid={touched && !nameValid ? "true" : undefined}
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="email"
            required
            placeholder="you@yourstore.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => setTouched(true)}
            disabled={pending}
            className="flex-1"
            aria-invalid={touched && !emailValid ? "true" : undefined}
          />
          <Button type="submit" disabled={!canSubmit}>
            {pending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Join the waitlist <ArrowRight className="size-4" aria-hidden />
          </Button>
        </div>
      </form>
      {touched && (!nameValid || !emailValid) && (
        <p className="mt-2 text-sm text-error">Enter your name and a valid email to join.</p>
      )}
      {error && <p className="mt-3 text-sm text-error">{error}</p>}
      <p className="mt-3 text-sm text-muted-foreground">
        First 100 signups lock in <span className="font-medium text-foreground">founder pricing.</span>
        {typeof count === "number" && <> Join {count.toLocaleString()}+ others already on the list.</>}
      </p>

      <Dialog open={showSuccess} onOpenChange={setShowSuccess}>
        <DialogContent className="sm:max-w-[480px]">
          <div className="flex size-11 items-center justify-center rounded-xl bg-success-soft">
            <Sparkles className="size-5 text-success" aria-hidden />
          </div>
          <DialogHeader className="text-left">
            <DialogTitle className="text-xl">
              {displayCount ? <>You're in — #{displayCount.toLocaleString()} in line.</> : "You're already on the list."}
            </DialogTitle>
            <DialogDescription>
              {displayCount
                ? "Every referral moves you up 2 spots. Share your link and skip the queue."
                : "We'll reach out at that email when a slot opens up."}
            </DialogDescription>
          </DialogHeader>

          {!phoneSaved ? (
            <div className="mt-2">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Add your phone <span className="text-muted-foreground/70">(optional — we'll text when you're up next)</span>
              </p>
              <div className="flex gap-2">
                <Input
                  type="tel"
                  placeholder="+91 98765 43210"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="flex-1"
                />
                <Button type="button" variant="outline" disabled={phoneSaving || !phone.trim()} onClick={savePhone}>
                  {phoneSaving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          ) : (
            <p className="mt-2 flex items-center gap-2 text-sm text-success">
              <Check className="size-4" aria-hidden /> Phone saved — we'll text you when your spot opens.
            </p>
          )}

          {referralCode && <ReferralShare referralCode={referralCode} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

function LandingContent() {
  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* Nav */}
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <span className="flex items-baseline gap-1.5">
            <span className="font-serif text-lg font-medium tracking-tight">Weeber</span>
          </span>
          <nav className="flex items-center gap-4 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground">
              Features
            </a>
            <Link href="/app/login" className="hover:text-foreground">
              Merchant login
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-3xl px-6 pt-20 pb-16 text-center">
        <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground">
          Voice AI for Shopify &amp; clinics
        </p>
        <h1 className="text-4xl font-medium tracking-tight sm:text-5xl">
          Phone agents that actually run your business, not just answer it.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground">
          Weeber gives Shopify stores and clinics a phone number backed by an AI agent that recovers
          abandoned carts, answers order questions, and books appointments — compliant by default.
        </p>

        <WaitlistForm />
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border">
        <div className="mx-auto max-w-5xl px-6 py-16">
          <div className="grid gap-10 sm:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title}>
                <f.icon className="size-5 text-foreground" aria-hidden />
                <h3 className="mt-3 text-sm font-medium">{f.title}</h3>
                <p className="mt-1.5 text-sm text-muted-foreground">{f.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-2 px-6 py-8 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <span>&copy; {new Date().getFullYear()} Weeber. All rights reserved.</span>
          <Link href="/app/login" className="hover:text-foreground">
            Merchant login
          </Link>
        </div>
      </footer>
    </div>
  );
}

export default function LandingPage() {
  const { theme } = useTheme();
  return (
    <div className={cn("theme-weeber", theme === "dark" && "dark")}>
      <LandingContent />
    </div>
  );
}
