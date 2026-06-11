/**
 * First word of a display name — the shared possessive / message-framing helper
 * for the client proposal-review surface (A6.4 / BAL-289). Hoisted so the review
 * shell, summary card, and accept-confirm modal share one source of truth.
 */
export function firstName(name: string): string {
  return name.split(' ')[0] ?? name;
}
