import type { ReactNode } from "react";

/**
 * The eyebrow-label + h2 + optional body pattern every section on Home
 * already uses (pulsing dot, font-mono uppercase eyebrow, font-display
 * heading) — pulled out so the new marketing pages match Home's
 * typography exactly instead of re-deriving the same classes per section.
 */
export function SectionHeading({
  eyebrow,
  title,
  body,
  align = "left",
}: {
  eyebrow: string;
  title: ReactNode;
  body?: ReactNode;
  align?: "left" | "center";
}) {
  return (
    <div data-reveal className={align === "center" ? "text-center" : ""}>
      <span className="inline-flex items-center gap-2 font-mono text-[11px] tracking-[.16em] uppercase text-[var(--m-text-muted)]">
        <span className="w-[6px] h-[6px] rounded-full bg-[var(--m-text)] animate-pulse" />
        {eyebrow}
      </span>
      <h2
        className={`mt-4 font-display text-[clamp(28px,3.8vw,46px)] font-extrabold tracking-[-0.03em] leading-[1.04] text-[var(--m-text)] ${
          align === "center" ? "mx-auto max-w-2xl" : "max-w-xl"
        }`}
      >
        {title}
      </h2>
      {body && (
        <p className={`mt-4 text-[17px] text-[var(--m-text-secondary)] leading-relaxed ${align === "center" ? "mx-auto max-w-xl" : "max-w-xl"}`}>
          {body}
        </p>
      )}
    </div>
  );
}
