'use client';

import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ExternalLink, Info, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { CALENDAR_HELP_URL } from '../_lib/calendar-help';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarSyncPendingNoticeProps {
  readonly provider: CalendarProvider;
  readonly onFixPermissions: () => void;
}

/**
 * BAL-397 §9.4 — renamed from `-card`: this now renders INSIDE the connection `Card` (the
 * header row is owned by `CalendarConnectionCard`), so the root is a plain `<div>`.
 *
 * Copy correction: the shipped copy said "some permissions weren't granted", which is
 * Cronofy-era and now false — Apiroc rejects a partial grant server-side and creates no
 * account (apiroc skill, [live]). `SYNC_PENDING` today means provisioning didn't complete.
 */
export function CalendarSyncPendingNotice({
  provider,
  onFixPermissions,
}: Readonly<CalendarSyncPendingNoticeProps>): React.JSX.Element {
  const [showDetail, setShowDetail] = useState(false);
  // Plan §7 — the global `prefers-reduced-motion` CSS block only neutralises CSS animations
  // (`animate-pulse` / `animate-spin`). A JS (Motion) animation needs the hook, exactly as
  // `calendar-connections-section.tsx` does for its stagger entrance.
  const reduceMotion = useReducedMotion();
  const disclosureTransition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.2, ease: 'easeOut' as const };

  return (
    <div className="px-5 py-4">
      {/* Warning message */}
      <div className="bg-warning/5 border-warning/20 mb-4 flex gap-2.5 rounded-[10px] border p-3">
        <AlertTriangle
          className="text-warning mt-0.5 h-[15px] w-[15px] shrink-0"
          aria-hidden="true"
        />
        <div>
          <p className="text-foreground text-[13px] font-semibold">
            We&apos;re still setting up this calendar
          </p>
          <p className="text-warning mt-1 text-[13px] leading-relaxed">
            We connected your account but couldn&apos;t read the calendars on it yet. This usually
            clears on its own within a few minutes — we keep retrying in the background.
          </p>
        </div>
      </div>

      {/* Expandable explanation */}
      <button
        type="button"
        aria-expanded={showDetail}
        onClick={() => setShowDetail(!showDetail)}
        className="text-muted-foreground hover:text-foreground mb-3 flex cursor-pointer items-center gap-1.5 border-none bg-transparent p-0 text-xs font-semibold transition-colors"
      >
        <Info className="text-muted-foreground h-3 w-3" aria-hidden="true" />
        Why did this happen?
        <ChevronDown
          className={`text-muted-foreground h-3 w-3 transition-transform duration-200 ${showDetail ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      <AnimatePresence>
        {showDetail && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={disclosureTransition}
            className="overflow-hidden"
          >
            <div className="bg-muted mb-3.5 rounded-lg p-3">
              <p className="text-muted-foreground text-[13px] leading-relaxed">
                This usually means we didn&apos;t finish reading your calendar list the first time —
                nothing you did wrong. Clicking &quot;Fix permissions&quot; re-runs the connection
                without creating a new account.
              </p>
              {provider === 'google' && (
                <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
                  If it doesn&apos;t clear, the quickest fix is to remove Balo at
                  myaccount.google.com/permissions and connect again — re-running sign-in on its own
                  won&apos;t re-show the permission checkboxes.
                </p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* CTAs */}
      <div className="flex items-center gap-2.5">
        <Button
          size="sm"
          // `text-warning-foreground`, not `text-white` — the token exists in `globals.css` for
          // both themes; the hardcoded colour was carried over verbatim from the deleted card.
          className="bg-warning hover:bg-warning/90 text-warning-foreground gap-1.5 shadow-sm"
          onClick={onFixPermissions}
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Fix permissions
        </Button>
        <a
          href={CALENDAR_HELP_URL}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
        >
          Learn more
          <ExternalLink className="h-[11px] w-[11px]" aria-hidden="true" />
        </a>
      </div>

      {/* Self-healing note */}
      <div className="bg-success/5 border-success/20 mt-3.5 flex items-start gap-1.5 rounded-lg border p-2.5">
        <Check className="text-success mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="text-success text-xs leading-relaxed">
          Once permissions are granted, your calendar will sync automatically — no further action
          needed.
        </span>
      </div>
    </div>
  );
}
