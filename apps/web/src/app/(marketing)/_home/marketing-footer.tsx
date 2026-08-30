import Link from 'next/link';
import { Logo } from '@/components/layout/logo';
import { getVersionString, APP_VERSION } from '@/lib/version';
import { FOOTER_COLUMNS, VERTICAL } from './copy';

/**
 * BAL-493 §13.2 / §13.3 — the marketing home's OWN page-level `<footer>`.
 *
 * The root `app/layout.tsx` always renders `<AppFooter />`, which now returns `null` on this
 * route specifically (`isMarketingHomePath`) so THIS is the only `contentinfo` landmark on `/`
 * — P4a fixed the duplicate-landmark defect this would otherwise cause (see `app-footer.tsx`'s
 * docblock). The version stamp that would otherwise be lost moves into this footer's bottom bar
 * via the SAME `getVersionString()` / `APP_VERSION` — nothing is dropped, it just moves.
 *
 * Only real, resolving destinations are linked (`FOOTER_COLUMNS`, `copy.ts`) — the design
 * reference's ~19-link footer is preserved there as a `TODO(MJ)` rather than linked to nowhere.
 * No social link (no confirmed destination) and no bottom-bar `<nav aria-label="Legal">` — both
 * omitted until real destinations exist, also `TODO(MJ)` in `copy.ts`.
 *
 * Plain `<Link>`s, not `<CtaLink>` — `MARKETING_HOME_CTA_PLACEMENTS` has no `'footer'` member
 * (every member has exactly one live emitter; the footer isn't one of them).
 */
export function MarketingFooter(): React.JSX.Element {
  return (
    <footer className="mk-footer">
      <div className="mk-wrap">
        <div className="mk-footer-grid">
          <div className="mk-footer-brand">
            <Logo />
            <p>
              Vetted {VERTICAL.name} experts, bookable by the minute. Consultations, projects and
              packages in one place.
            </p>
          </div>
          {FOOTER_COLUMNS.map((column) => (
            <div key={column.heading}>
              <h3>{column.heading}</h3>
              <ul>
                {column.links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href}>{link.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mk-footer-bottom">
          <span>© 2026 Balo Technologies</span>
          <span title={`Branch: ${APP_VERSION.branch} | Built: ${APP_VERSION.buildTime}`}>
            {getVersionString()}
          </span>
        </div>
      </div>
    </footer>
  );
}
