'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { resolveBreadcrumbTrail, type NavCrumb } from './nav-registry';
import { useEntityCrumbLabel } from './breadcrumb-context';

const EARLIER_CRUMB_LINK_CLASSNAME =
  'text-muted-foreground hover:text-foreground focus-visible:ring-ring truncate rounded-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none';
const EARLIER_CRUMB_TEXT_CLASSNAME = 'text-muted-foreground truncate font-medium';
const LAST_CRUMB_CLASSNAME = 'text-foreground truncate font-semibold';
const LAST_CRUMB_LINK_CLASSNAME = `${LAST_CRUMB_CLASSNAME} focus-visible:ring-ring rounded-sm focus-visible:ring-2 focus-visible:outline-none`;

/**
 * The content of one crumb — a `<Link>` when it carries an `href`, a plain `<span>` otherwise.
 * Every non-last crumb `resolveBreadcrumbTrail` returns carries a real `href` (every
 * `ENTITY_PARENTS` entry does), so the `href === null` branch below only ever fires for the last
 * crumb — kept explicit rather than asserted away, since `NavCrumb.href` is honestly typed
 * `string | null`. `aria-current="page"` for the last crumb sits on the wrapping `<h1>` (see
 * `Breadcrumbs` below), not here, so it applies uniformly whether the current page is a link or
 * plain text.
 */
function crumbContent(crumb: NavCrumb, variant: 'last' | 'earlier'): React.JSX.Element {
  if (variant === 'last') {
    if (crumb.href === null) {
      return <span className={LAST_CRUMB_CLASSNAME}>{crumb.label}</span>;
    }
    return (
      <Link href={crumb.href} className={LAST_CRUMB_LINK_CLASSNAME}>
        {crumb.label}
      </Link>
    );
  }
  if (crumb.href === null) {
    return <span className={EARLIER_CRUMB_TEXT_CLASSNAME}>{crumb.label}</span>;
  }
  return (
    <Link href={crumb.href} className={EARLIER_CRUMB_LINK_CLASSNAME}>
      {crumb.label}
    </Link>
  );
}

/**
 * BAL-499 — the top bar's breadcrumb trail: the nav-registry-derived route crumb(s), plus the
 * currently-viewed entity's own label when one has been published (`EntityCrumb` — see
 * `breadcrumb-context.tsx`'s anti-staleness guarantee).
 *
 * The LAST crumb always carries the page's `<h1>` — `request-context.tsx:127` documents that
 * dashboard pages render `h2` sections UNDER the chrome's `h1`, so dropping it would leave those
 * pages starting at `h2` and trip axe's `heading-order`. If the last crumb also carries an
 * `href` (an entity route with no published label yet), it renders as a link inside the `h1` so
 * the way back is never lost.
 *
 * BAL-499 F5 — this convention now holds for all four entity pages, not just
 * `/projects/[requestId]`: `case-header.tsx`, `engagement-header.tsx`, and `recap-header.tsx`
 * each demoted their own page heading from `h1` to `h2` so it sits correctly UNDER this chrome
 * `<h1>` instead of duplicating the same title as a second `h1` (a screen-reader user navigating
 * by heading was hearing the title twice in a row). Any future entity page must follow the same
 * rule: its own title heading is `h2` (or deeper), never `h1` — this component owns the `h1`.
 *
 * An unrecognised route renders nothing (`resolveBreadcrumbTrail` returns `[]`): no crumb beats
 * a wrong crumb (BAL-499 D11) — the old silent `'Dashboard'` fallback is gone.
 */
export function Breadcrumbs(): React.JSX.Element | null {
  const pathname = usePathname();
  const routeTrail = resolveBreadcrumbTrail(pathname);
  const entityLabel = useEntityCrumbLabel(pathname);
  const crumbs: readonly NavCrumb[] =
    entityLabel === null ? routeTrail : [...routeTrail, { label: entityLabel, href: null }];

  if (crumbs.length === 0) return null; // D18 — unchanged; no mobile-only fallback

  const lastIndex = crumbs.length - 1;
  const parent = crumbs[lastIndex - 1]; // NavCrumb | undefined (noUncheckedIndexedAccess)
  const backHref = parent === undefined || parent.href === null ? null : parent.href;

  return (
    <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
      {/* MOBILE-ONLY back affordance. A real <Link>, never history.back() — a deep-linked
          entity page has no in-app history to go back to (design-spec.md:104-108). */}
      {backHref !== null && parent !== undefined && (
        <Link
          href={backHref}
          aria-label={`Back to ${parent.label}`}
          className="text-foreground hover:bg-accent focus-visible:ring-ring -ml-2 inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none lg:hidden"
        >
          <ArrowLeft className="size-[18px]" aria-hidden="true" />
        </Link>
      )}

      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((crumb, index) => {
          const isLast = index === lastIndex;
          if (!isLast) {
            // EARLIER crumbs — desktop only. `hidden lg:flex`, NOT a second component.
            return (
              <li
                key={crumb.href ?? crumb.label}
                className="hidden min-w-0 items-center gap-1.5 lg:flex"
              >
                {index > 0 && (
                  <ChevronRight
                    className="text-muted-foreground size-3.5 shrink-0"
                    aria-hidden="true"
                  />
                )}
                {crumbContent(crumb, 'earlier')}
              </li>
            );
          }
          return (
            <li key={crumb.href ?? crumb.label} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && (
                <ChevronRight
                  className="text-muted-foreground hidden size-3.5 shrink-0 lg:block"
                  aria-hidden="true"
                />
              )}
              {/* ⚠⚠ THE ONE <h1>. Same node in both layouts. 17px/600 on mobile per the
                  prototype (balo-nav-explorer.jsx:2324-2333), text-sm from lg up (today's value). */}
              <h1
                aria-current="page"
                className="min-w-0 truncate text-[17px] font-semibold tracking-[-0.01em] lg:text-sm"
              >
                {crumbContent(crumb, 'last')}
              </h1>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
