/**
 * BAL-441 (owner Q2) — the controlled PDF filename: `Balo-Receipt-2026-08-12-8f2c1a3d.pdf` /
 * `Balo-Payout-2026-08-12-8f2c1a3d.pdf` — the UTC session date from `occurredAtIso` (omitted
 * when null) plus the first 8 characters of the session id (a UUID, so this is plain string
 * slicing — no regex, dodging the super-linear trap SonarCloud S5852 flags, matching
 * `proposalPdfFileName`'s shape).
 */
export function statementPdfFileName(
  lens: 'client' | 'expert',
  occurredAtIso: string | null,
  sessionId: string
): string {
  const kind = lens === 'client' ? 'Receipt' : 'Payout';
  const shortId = sessionId.slice(0, 8);
  const date = occurredAtIso === null ? null : occurredAtIso.slice(0, 10);
  return date === null ? `Balo-${kind}-${shortId}.pdf` : `Balo-${kind}-${date}-${shortId}.pdf`;
}
