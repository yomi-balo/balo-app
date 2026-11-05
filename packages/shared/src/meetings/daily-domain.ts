/**
 * One Daily subdomain label: non-empty, lowercase letters, digits and hyphens only.
 *
 * The ONE definition, shared by the `meetings` repository's join-url prefix guard and the venue
 * re-provision service. Plain character checks, no regex over caller input.
 */
export function isDailyDomainLabel(label: string): boolean {
  if (label.length === 0) return false;
  for (const char of label) {
    const isLower = char >= 'a' && char <= 'z';
    const isDigit = char >= '0' && char <= '9';
    if (!isLower && !isDigit && char !== '-') return false;
  }
  return true;
}
