/**
 * Route into the delivery workspace from the request-detail surface. `from=request_detail` is
 * the `entry` whitelist literal read by `app/(dashboard)/engagements/[id]/page.tsx`, so it must
 * stay exact.
 */
export function deliveryWorkspaceHref(engagementId: string): string {
  return `/engagements/${engagementId}?from=request_detail`;
}
