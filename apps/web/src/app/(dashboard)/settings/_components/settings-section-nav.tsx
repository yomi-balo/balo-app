'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';
import type { SettingsSection } from '@/lib/analytics';
import { SETTINGS_SECTION_ORDER, resolveActiveSection } from '../_lib/settings-sections';

interface SettingsSectionNavProps {
  readonly showTeamSection: boolean;
}

/**
 * BAL-503 — the client Settings tab bar. `'use client'` leaf under the async server
 * `settings/layout.tsx`. Receives ONE serialisable boolean from the server — no capability
 * token, no role, no `NavContext`, no `LucideIcon` crosses the boundary (icons resolve here from
 * `SETTINGS_SECTION_ORDER`, imported directly).
 *
 * Markup — ROUTE LINKS, not the ARIA tabs pattern: these are full navigations to
 * `/settings/<section>`, not in-page tab panels, so `role="tab"` (which contracts for
 * `aria-controls` → a `role="tabpanel"` sibling + roving-tabindex) would be a false a11y
 * promise. `<nav aria-label>` + `aria-current="page"` is the correct pattern here.
 *
 * The ONE analytics dispatch point for `settings_section_viewed` — mirrors
 * `useNavItemTracking`'s discipline. Fires on a direct URL landing AND on a tab click (both
 * resolve through `usePathname()`), exactly once per section (survives StrictMode via the
 * `lastFired` ref, `dashboard-wallet-card.tsx` precedent), and NEVER for a section whose tab is
 * not visible to this actor (`notFound()` still mounts this layout, so without the `isVisible`
 * guard a member typing `/settings/team` would emit a view for a page they never saw).
 */
export function SettingsSectionNav({
  showTeamSection,
}: Readonly<SettingsSectionNavProps>): React.JSX.Element {
  const pathname = usePathname();
  const active = resolveActiveSection(pathname);
  const visible = SETTINGS_SECTION_ORDER.filter(
    (section) => !section.requiresManageMembers || showTeamSection
  );
  const isVisible = active !== null && visible.some((section) => section.key === active);
  const lastFired = useRef<SettingsSection | null>(null);

  useEffect(() => {
    if (!isVisible || active === null || lastFired.current === active) return;
    lastFired.current = active;
    track(SETTINGS_EVENTS.SECTION_VIEWED, { section: active });
  }, [active, isVisible]);

  return (
    <nav aria-label="Settings sections" className="mx-auto w-full max-w-3xl">
      <div className="bg-muted inline-flex gap-1 overflow-x-auto rounded-xl p-1">
        {visible.map(({ key, label, href, icon: Icon }) => {
          const isActive = key === active;
          return (
            <Link
              key={key}
              href={href}
              aria-current={isActive ? 'page' : undefined}
              className={cn(
                'focus-visible:ring-ring relative z-10 inline-flex min-h-11 items-center gap-1.5 rounded-lg px-4 py-2 text-sm whitespace-nowrap transition-colors duration-200 focus-visible:ring-2 focus-visible:outline-none',
                isActive
                  ? 'text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {isActive && (
                <motion.div
                  layoutId="settings-section-pill"
                  className="bg-card absolute inset-0 rounded-lg shadow-sm"
                  transition={{ type: 'spring', duration: 0.35, bounce: 0.15 }}
                />
              )}
              <Icon
                aria-hidden="true"
                className={cn(
                  'relative z-10 h-4 w-4',
                  isActive ? 'text-primary' : 'text-muted-foreground'
                )}
              />
              <span className="relative z-10">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
