/**
 * BAL-495 rule, lifted verbatim from `sidebar-nav-link.tsx:32-35`. Exact for /dashboard,
 * prefix-with-separator for everything else. Pure — no router, no mount, no DOM.
 *
 * BAL-501 — extracted so `MobileTabBar` can share the identical rule rather than inventing a
 * second one (design-spec.md §2 "Active / inactive").
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  return href === '/dashboard'
    ? pathname === '/dashboard'
    : pathname === href || pathname.startsWith(href + '/');
}
