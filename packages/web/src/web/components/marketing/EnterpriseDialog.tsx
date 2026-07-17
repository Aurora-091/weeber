import { useState } from "react";
import { Building2, CircleCheck, Mail } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { toast } from "sonner";
import { apiFetch } from "../../lib/api";

interface FormData {
  businessType: string;
  callVolume: string;
  painPoint: string;
  timeline: string;
  extraInfo: string;
  name: string;
  email: string;
}

const EMPTY_FORM: FormData = {
  businessType: "",
  callVolume: "",
  painPoint: "",
  timeline: "",
  extraInfo: "",
  name: "",
  email: "",
};

const BUSINESS_TYPES = [
  "E-commerce / Shopify store",
  "Healthcare / Clinic / Hospital",
  "Hotel / Hospitality",
  "Real estate / Property",
  "Financial services / Insurance",
  "SaaS / Tech company",
  "Logistics / Delivery",
  "Other",
];

const CALL_VOLUMES = ["Under 500/month", "500 \u2013 2,000/month", "2,000 \u2013 10,000/month", "10,000 \u2013 50,000/month", "50,000+/month"];

const PAIN_POINTS = [
  "Too many missed calls / after-hours coverage",
  "High cost of human agents",
  "Inconsistent call quality across locations",
  "Cart abandonment / recovery",
  "Appointment booking & no-show reduction",
  "Compliance & audit trail",
  "Multi-language support",
  "Integrating voice into existing systems",
];

const TIMELINES = ["ASAP \u2014 we have an urgent need", "Within the next 1 month", "Within the next 3 months", "Just exploring for now"];

type Step = {
  key: keyof FormData;
  sectionLabel: string;
  question: string;
  type: "select" | "textarea" | "text" | "email";
  options?: string[];
  optional?: boolean;
  placeholder?: string;
};

const STEPS: Step[] = [
  { key: "businessType", sectionLabel: "Question 1 of 5", question: "What kind of business are you running?", type: "select", options: BUSINESS_TYPES },
  { key: "callVolume", sectionLabel: "Question 2 of 5", question: "How many customer calls do you handle per month?", type: "select", options: CALL_VOLUMES },
  { key: "painPoint", sectionLabel: "Question 3 of 5", question: "What's the biggest issue you're trying to solve?", type: "select", options: PAIN_POINTS },
  { key: "timeline", sectionLabel: "Question 4 of 5", question: "When are you looking to get started?", type: "select", options: TIMELINES },
  {
    key: "extraInfo",
    sectionLabel: "Question 5 of 5",
    question: "Anything specific you'd like us to know?",
    type: "textarea",
    optional: true,
    placeholder: "Custom integrations needed, existing systems, languages required, compliance needs\u2026",
  },
  { key: "name", sectionLabel: "Almost there", question: "Your name", type: "text", placeholder: "Jane Smith" },
  { key: "email", sectionLabel: "Almost there", question: "Work email", type: "email", placeholder: "jane@company.com" },
];

const TOTAL_STEPS = STEPS.length;

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStepValid(step: number, formData: FormData): boolean {
  const s = STEPS[step]!;
  if (s.optional) return true;
  const val = formData[s.key].trim();
  if (!val) return false;
  if (s.type === "email") return isValidEmail(val);
  return true;
}

const selectClass =
  "w-full bg-[var(--m-bg)] border border-[var(--m-border)] text-[var(--m-text)] rounded-lg px-3.5 py-3 text-[15px] font-medium appearance-none outline-none focus:ring-2 focus:ring-[var(--m-accent-bg)]/20 focus:border-[var(--m-text-muted)] transition-colors cursor-pointer";
const inputClass =
  "w-full bg-[var(--m-bg)] border border-[var(--m-border)] text-[var(--m-text)] rounded-lg px-3.5 py-3 text-[15px] outline-none focus:ring-2 focus:ring-[var(--m-accent-bg)]/20 focus:border-[var(--m-text-muted)] transition-colors placeholder:text-[var(--m-text-muted)]";
const textareaClass =
  "w-full bg-[var(--m-bg)] border border-[var(--m-border)] text-[var(--m-text)] rounded-lg px-3.5 py-3 text-[15px] outline-none focus:ring-2 focus:ring-[var(--m-accent-bg)]/20 focus:border-[var(--m-text-muted)] transition-colors placeholder:text-[var(--m-text-muted)] resize-none min-h-[120px]";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Which vertical/surface opened this dialog — purely a copy switch (header
   * label + success message), the form fields and submit endpoint are the
   * same for every context. Undefined/"enterprise" keeps the original
   * generic copy; add more contexts here as more verticals get their own
   * "Talk to us" entry points. */
  context?: "enterprise" | "insurance";
}

const CONTEXT_COPY: Record<"enterprise" | "insurance", { label: string; successBody: string }> = {
  enterprise: { label: "Enterprise inquiry", successBody: "Our enterprise team reviews every inquiry personally." },
  insurance: { label: "Insurance inquiry", successBody: "Our team reviews every insurance inquiry personally." },
};

/** Multi-step enterprise-inquiry form — ported from Vocalist's
 * EnterpriseDialog.tsx, wired to openvent's own POST /api/public/enterprise-inquiry
 * (routed through the existing support-tickets table) instead of a Supabase
 * edge function. */
export function EnterpriseDialog({ open, onOpenChange, context = "enterprise" }: Props) {
  const copy = CONTEXT_COPY[context];
  const [step, setStep] = useState(0);
  const [formData, setFormData] = useState<FormData>(EMPTY_FORM);
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function handleClose(v: boolean) {
    if (!v) {
      setTimeout(() => {
        setStep(0);
        setFormData(EMPTY_FORM);
        setSubmitted(false);
        setSubmitting(false);
      }, 300);
    }
    onOpenChange(v);
  }

  function handleChange(val: string) {
    const key = STEPS[step]!.key;
    setFormData((prev) => ({ ...prev, [key]: val }));
  }

  function handleContinue() {
    if (step < TOTAL_STEPS - 1) {
      setStep((s) => s + 1);
    } else {
      void handleSubmit();
    }
  }

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/public/enterprise-inquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}) as { error?: string });
        throw new Error(err?.error || "Submission failed");
      }
      setSubmitted(true);
    } catch {
      toast.error("Failed to submit inquiry. Please try again or reach out to hello@weeber.ai.");
    } finally {
      setSubmitting(false);
    }
  }

  const isLast = step === TOTAL_STEPS - 1;
  const canContinue = isStepValid(step, formData);
  const current = STEPS[step]!;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="marketing sm:max-w-[560px] p-0 bg-[var(--m-bg)] text-[var(--m-text)] border border-[var(--m-border)] shadow-[0_24px_80px_-12px_rgba(0,0,0,0.25)] overflow-hidden [&_button[data-slot=dialog-close]]:text-[var(--m-text-secondary)] [&_button[data-slot=dialog-close]]:hover:text-[var(--m-text)]">
        {submitted ? (
          <div className="px-8 pt-8 pb-8">
            <div className="flex items-center justify-center w-14 h-14 rounded-2xl bg-[#22C55E]/10 border border-[#22C55E]/20 mb-6">
              <CircleCheck className="w-7 h-7 text-[#22C55E]" />
            </div>
            <DialogHeader className="text-left">
              <DialogTitle className="font-display text-[26px] md:text-[30px] font-extrabold tracking-[-0.035em] leading-[1.1] text-[var(--m-text)]">We'll be in touch soon.</DialogTitle>
              <DialogDescription className="text-[var(--m-text-secondary)] mt-3 text-[15px] leading-relaxed">
                {copy.successBody}
              </DialogDescription>
            </DialogHeader>
            <div className="mt-6 flex items-center gap-3 px-4 py-3.5 bg-[var(--m-surface)] border border-[var(--m-border)] rounded-lg">
              <Mail className="w-4 h-4 text-[var(--m-text-secondary)] flex-shrink-0" />
              <span className="text-sm text-[var(--m-text)] truncate flex-1">{formData.email}</span>
              <span className="text-[11px] font-mono text-[#22C55E] bg-[#22C55E]/10 px-2 py-0.5 rounded font-medium">Submitted</span>
            </div>
            <p className="mt-4 text-sm text-[var(--m-text-muted)]">
              Or reach us directly at{" "}
              <a href="mailto:hello@weeber.ai" className="text-[var(--m-text)] underline underline-offset-2">
                hello@weeber.ai
              </a>
            </p>
          </div>
        ) : (
          <div className="px-8 pt-6 pb-8">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-2">
                <Building2 className="w-4 h-4 text-[var(--m-text-secondary)]" />
                <span className="font-mono text-[11px] tracking-[.14em] uppercase text-[var(--m-text-secondary)]">{copy.label}</span>
              </div>
              <div className="flex items-center gap-1">
                {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
                  <div key={i} className="h-[3px] w-5 rounded-full transition-colors duration-300" style={{ backgroundColor: i <= step ? "var(--m-text)" : "var(--m-border)" }} />
                ))}
              </div>
            </div>

            <div className="font-mono text-[11px] tracking-[.14em] uppercase text-[var(--m-text-muted)] mb-3">{current.sectionLabel}</div>

            <h3 className="font-display text-[22px] md:text-[26px] font-extrabold tracking-[-0.03em] leading-[1.1] text-[var(--m-text)] mb-6">{current.question}</h3>

            <div className="mb-2">
              {current.type === "select" && (
                <div className="relative">
                  <select className={selectClass} value={formData[current.key]} onChange={(e) => handleChange(e.target.value)}>
                    <option value="" disabled>
                      Select an option\u2026
                    </option>
                    {current.options!.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--m-text-muted)]" />
                    </svg>
                  </div>
                </div>
              )}

              {current.type === "textarea" && (
                <textarea className={textareaClass} value={formData[current.key]} onChange={(e) => handleChange(e.target.value)} placeholder={current.placeholder} />
              )}

              {(current.type === "text" || current.type === "email") && (
                <input
                  type={current.type}
                  className={inputClass}
                  value={formData[current.key]}
                  onChange={(e) => handleChange(e.target.value)}
                  placeholder={current.placeholder}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canContinue) handleContinue();
                  }}
                />
              )}
            </div>

            {current.optional && <p className="text-xs text-[var(--m-text-muted)] mb-6">This is optional \u2014 hit Continue to skip</p>}

            <div className="flex items-center gap-3 mt-8">
              {step > 0 && (
                <button type="button" onClick={() => setStep((s) => s - 1)} className="px-4 py-2.5 text-sm font-medium text-[var(--m-text-secondary)] hover:text-[var(--m-text)] transition-colors">
                  Back
                </button>
              )}
              <button
                type="button"
                onClick={handleContinue}
                disabled={!canContinue || submitting}
                className="flex-1 flex items-center justify-center gap-2 bg-[var(--m-accent-bg)] text-[var(--m-accent-fg)] text-sm font-semibold py-3 px-5 rounded-lg transition-opacity disabled:opacity-40 hover:opacity-90 active:scale-[0.98]"
              >
                {submitting ? (
                  <span className="flex items-center gap-2">
                    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                    </svg>
                    Submitting\u2026
                  </span>
                ) : isLast ? (
                  "Submit"
                ) : (
                  "Continue \u2192"
                )}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
