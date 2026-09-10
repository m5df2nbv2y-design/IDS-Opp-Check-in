const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const longDate = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const shortDateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

export function formatAmount(amount: number): string {
  return currency.format(amount);
}

export function formatCompactAmount(amount: number): string {
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${Math.round(amount / 1_000)}K`;
  return currency.format(amount);
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return longDate.format(new Date(date));
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  return shortDateTime.format(new Date(date));
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? fullName;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

/** "12 Feb 2027" — compact, unambiguous for a recipient on a phone. */
export function formatShortDate(value: string | Date | null | undefined): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(`${value}T00:00:00.000Z`) : value;
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Executive reporting format: exact below a million ("$850,000"), abbreviated
 * above it ("$1.2M", "$8.7M"). Trailing ".0" is dropped — "$1M", not "$1.0M".
 */
export function formatReportAmount(amount: number): string {
  if (Math.abs(amount) >= 1_000_000) {
    const millions = (amount / 1_000_000).toFixed(1).replace(/\.0$/, "");
    return `$${millions}M`;
  }
  return currency.format(amount);
}
