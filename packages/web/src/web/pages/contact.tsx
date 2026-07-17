import { useState } from "react";
import { Mail, CalendarClock, Users, Send, CircleCheck as CheckCircle2 } from "lucide-react";
import { usePageMeta } from "../lib/usePageMeta";
import { apiFetch } from "../lib/api";
import { MarketingPageShell } from "../components/marketing/MarketingPageShell";
import { EnterpriseDialog } from "../components/marketing/EnterpriseDialog";

function GeneralContactForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !message.trim()) return;
    setState("loading");
    setErrorMsg("");
    try {
      const res = await apiFetch("/api/public/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), subject: "Contact form", message: message.trim() }),
      });
      const data = await res.json().catch(() => ({ error: "Something went wrong" }));
      if (!res.ok || data.error) {
        setState("error");
        setErrorMsg(data.error ?? "Something went wrong. Try again or email hello@weeber.ai");
        return;
      }
      setState("success");
    } catch {
      setState("error");
      setErrorMsg("Couldn't reach the server. Try again or email hello@weeber.ai");
    }
  }

  if (state === "success") {
    return (
      <div className="flex flex-col items-center text-center py-8">
        <div className="w-12 h-12 rounded-full bg-[#22C55E]/10 border border-[#22C55E]/20 flex items-center justify-center mb-4">
          <CheckCircle2 className="w-6 h-6 text-[#22C55E]" aria-hidden />
        </div>
        <h3 className="font-display font-bold text-[16px] text-[var(--m-text)]">Message sent.</h3>
        <p className="mt-1.5 text-[14px] text-[var(--m-text-secondary)]">We'll get back to you by email shortly.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@yourbrand.com"
        aria-label="Your email"
        className="w-full h-12 px-4 text-[15px] bg-[var(--m-surface)] border-[1.5px] border-[var(--m-input-border)] text-[var(--m-text)] placeholder:text-[var(--m-text-muted)] focus:border-[var(--m-text)] focus:outline-none rounded-lg transition-all"
      />
      <textarea
        required
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="What's on your mind?"
        aria-label="Your message"
        rows={4}
        className="w-full px-4 py-3 text-[15px] bg-[var(--m-surface)] border-[1.5px] border-[var(--m-input-border)] text-[var(--m-text)] placeholder:text-[var(--m-text-muted)] focus:border-[var(--m-text)] focus:outline-none rounded-lg transition-all resize-none"
      />
      {state === "error" && <p className="text-[13px] text-red-600">{errorMsg}</p>}
      <button
        type="submit"
        disabled={state === "loading" || !email.trim() || !message.trim()}
        className="w-full h-12 px-6 text-[15px] font-semibold bg-[var(--m-text)] text-[var(--m-bg)] rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
      >
        <Send className="w-4 h-4" aria-hidden />
        {state === "loading" ? "Sending..." : "Send message"}
      </button>
    </form>
  );
}

export function ContactPage() {
  usePageMeta({
    title: "Contact Weeber — Waitlist, Demos & Partnerships",
    description: "Get in touch with Weeber — general questions, enterprise inquiries, demo requests, or partnership conversations. We reply by email, usually the same day.",
    path: "/contact",
  });
  const [enterpriseOpen, setEnterpriseOpen] = useState(false);

  return (
    <MarketingPageShell>
      <section className="relative pt-32 pb-16 px-6 text-center border-b border-[var(--m-border)]">
        <div className="max-w-[640px] mx-auto">
          <h1 data-reveal className="font-display text-[clamp(2.2rem,5vw,3.6rem)] font-extrabold leading-[1.02] tracking-[-0.03em] text-[var(--m-text)]">
            Let's talk.
          </h1>
        </div>
      </section>

      <section className="px-6 py-20">
        <div className="max-w-[1000px] mx-auto grid md:grid-cols-3 gap-6" data-reveal>
          {/* Waitlist */}
          <div className="p-8 rounded-2xl border border-[var(--m-border)] bg-[var(--m-bg-alt)] flex flex-col">
            <Mail className="w-6 h-6 text-[var(--m-text)] mb-4" aria-hidden />
            <h2 className="font-display font-bold text-[17px] text-[var(--m-text)]">Join the waitlist</h2>
            <p className="mt-2 text-[14px] text-[var(--m-text-secondary)] leading-relaxed flex-1">
              Small business or Shopify store? Get early access and lock in founder pricing.
            </p>
            <a
              href="/#waitlist"
              className="mt-6 block text-center px-5 py-2.5 rounded-lg text-[14px] font-semibold bg-[var(--m-text)] text-[var(--m-bg)] hover:opacity-90 transition-opacity"
            >
              Join the waitlist
            </a>
          </div>

          {/* Book a demo */}
          <div className="p-8 rounded-2xl border border-[var(--m-border)] bg-[var(--m-bg-alt)] flex flex-col">
            <CalendarClock className="w-6 h-6 text-[var(--m-text)] mb-4" aria-hidden />
            <h2 className="font-display font-bold text-[17px] text-[var(--m-text)]">Book a demo</h2>
            <p className="mt-2 text-[14px] text-[var(--m-text-secondary)] leading-relaxed flex-1">
              High-volume or regulated team? Tell us about your setup and we'll walk you through it.
            </p>
            <button
              type="button"
              onClick={() => setEnterpriseOpen(true)}
              className="mt-6 px-5 py-2.5 rounded-lg text-[14px] font-semibold border border-[var(--m-border)] text-[var(--m-text)] hover:bg-[var(--m-surface)] transition-colors"
            >
              Talk to our team
            </button>
          </div>

          {/* Investors & press */}
          <div className="p-8 rounded-2xl border border-[var(--m-border)] bg-[var(--m-bg-alt)] flex flex-col">
            <Users className="w-6 h-6 text-[var(--m-text)] mb-4" aria-hidden />
            <h2 className="font-display font-bold text-[17px] text-[var(--m-text)]">Investors & press</h2>
            <p className="mt-2 text-[14px] text-[var(--m-text-secondary)] leading-relaxed flex-1">
              Working on diligence or a story? Reach out directly.
            </p>
            <a
              href="mailto:hello@weeber.ai"
              className="mt-6 block text-center px-5 py-2.5 rounded-lg text-[14px] font-semibold border border-[var(--m-border)] text-[var(--m-text)] hover:bg-[var(--m-surface)] transition-colors"
            >
              hello@weeber.ai
            </a>
          </div>
        </div>
      </section>

      {/* General message form */}
      <section className="border-t border-[var(--m-border)] px-6 py-20">
        <div className="max-w-[480px] mx-auto" data-reveal>
          <h2 className="font-display text-[22px] font-bold text-[var(--m-text)] text-center mb-6">Or just send us a message</h2>
          <GeneralContactForm />
        </div>
      </section>

      <EnterpriseDialog open={enterpriseOpen} onOpenChange={setEnterpriseOpen} />
    </MarketingPageShell>
  );
}
