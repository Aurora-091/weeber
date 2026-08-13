const RELATIVE_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "week", ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
  { unit: "second", ms: 1000 },
];

function toDate(input: Date | string | number): Date | null {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Compact relative time ("just now", "5m ago", "3h ago", "2d ago"). Falls
 * back to a formatted date once it's more than a week old so lists stay
 * scannable. Locale-agnostic strings — Intl only handles the exact-date fallback. */
export function formatRelative(input: Date | string | number, locale?: string): string {
  const date = toDate(input);
  if (!date) return "—";
  const diff = date.getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45_000) return "just now";
  if (abs >= RELATIVE_UNITS[2].ms) {
    return formatDate(date, locale);
  }
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (abs >= ms) {
      const value = Math.round(diff / ms);
      const suffix = unit === "second" ? "s" : unit === "minute" ? "m" : unit === "hour" ? "h" : "d";
      return value <= 0 ? `${Math.abs(value)}${suffix} ago` : `in ${value}${suffix}`;
    }
  }
  return "just now";
}

/** Short date ("Jul 12" for this year, "Jul 12, 2025" for older). */
export function formatDate(input: Date | string | number, locale = "en-US"): string {
  const date = toDate(input);
  if (!date) return "—";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
  }).format(date);
}

/** Date + time — used on detail pages where second-level precision matters. */
export function formatDateTime(input: Date | string | number, locale = "en-US"): string {
  const date = toDate(input);
  if (!date) return "—";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** BCP-47 locale hint from the org's stored country code. Falls back to
 * "en-US" so Intl always has a valid locale — never crashes on unknown codes. */
export function localeFromCountry(countryCode: string | null | undefined): string {
  if (!countryCode) return "en-US";
  const code = countryCode.toUpperCase();
  const map: Record<string, string> = {
    IN: "en-IN",
    US: "en-US",
    GB: "en-GB",
    CA: "en-CA",
    AU: "en-AU",
    DE: "de-DE",
    FR: "fr-FR",
    ES: "es-ES",
    IT: "it-IT",
    JP: "ja-JP",
    BR: "pt-BR",
    MX: "es-MX",
  };
  return map[code] ?? "en-US";
}

/** Formatted money using the org's locale + currency. Falls back to INR
 * because that's Weeber's launch market — matches the existing home.tsx
 * default so nothing renders in a different currency by accident. */
export function formatMoney(
  amount: number | null | undefined,
  currency: string | null | undefined,
  locale = "en-IN",
): string {
  if (amount == null || Number.isNaN(amount)) return "—";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: (currency || "INR").toUpperCase(),
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency ?? "INR"} ${amount.toFixed(0)}`;
  }
}

/** Compact number ("1.2K", "3.4M") — used on stat cards where full precision
 * would push the number off a card. */
export function formatCompactNumber(value: number | null | undefined, locale = "en-US"): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Time left on the org's self-expiring compliance test mode, as a short label
 * ("47m", "3h", "1d"). Returns null once it has lapsed, so callers must handle
 * the expired case explicitly rather than rendering a misleading "0m" while the
 * bypass is in fact already off — the whole point of surfacing this is that the
 * moment it flips is the moment a live demo call starts getting refused.
 */
export function formatTimeRemaining(input: Date | string | number): string | null {
  const date = toDate(input);
  if (!date) return null;
  const ms = date.getTime() - Date.now();
  if (ms <= 0) return null;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
