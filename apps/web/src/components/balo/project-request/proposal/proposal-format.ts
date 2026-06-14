/**
 * Format integer minutes as a decimal-hours STRING (the numeric part only — the
 * caller appends its own unit suffix, e.g. "h" or "hrs"). Trims a trailing `.0`.
 * E.g. 90 → "1.5", 60 → "1", 0 → "0". Shared by the milestones effort input and
 * the payment-terms derived-total note so the rounding stays in one place.
 */
export function minutesToHoursLabel(minutes: number): string {
  const hours = minutes / 60;
  return Number.isInteger(hours) ? String(hours) : String(Number(hours.toFixed(2)));
}
