/**
 * Where the delivery workspace's back link returns to. `?from=agency` (set by the Agency lens
 * rows) goes back to that lens on the delivering agency; anything else, or an engagement with
 * no agency, returns to the projects inbox. Navigation only: the page's own access gate is
 * unchanged by `from`.
 */
export function resolveWorkspaceBackHref(
  from: string | undefined,
  agencyId: string | null
): string {
  if (from === 'agency' && agencyId !== null) {
    return `/projects?lens=agency&agency=${encodeURIComponent(agencyId)}`;
  }
  return '/projects';
}
