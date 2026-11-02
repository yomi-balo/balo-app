/**
 * The internal payout-entity name for a SOLO agency (agency-of-one). Locked Decision
 * 5: `"${firstName} ${lastName}".trim() || 'Independent Expert'`. This is an internal
 * label only — the UI NEVER surfaces it to the solo expert as "your agency".
 */
export function soloAgencyName(firstName: string | null, lastName: string | null): string {
  const composed = `${firstName ?? ''} ${lastName ?? ''}`.trim();
  return composed || 'Independent Expert';
}
