/** Client-safe "Jul 3"-style short date for the domain-join admin surfaces (BAL-347). */
export function formatShortDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}
