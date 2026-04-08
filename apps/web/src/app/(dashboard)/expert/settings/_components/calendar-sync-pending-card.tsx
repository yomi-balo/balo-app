'use client';

import { useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ExternalLink, Info, RefreshCw } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { GoogleIcon, MicrosoftIcon } from './calendar-provider-icons';
import type { CalendarConnection, CalendarProvider } from '../_types/calendar';

interface CalendarSyncPendingCardProps {
  connection: CalendarConnection;
  provider: CalendarProvider;
  onFixPermissions: () => void;
}

export function CalendarSyncPendingCard({
  connection,
  provider,
  onFixPermissions,
}: Readonly<CalendarSyncPendingCardProps>): React.JSX.Element {
  const [showDetail, setShowDetail] = useState(false);

  const ProviderIcon = provider === 'google' ? GoogleIcon : MicrosoftIcon;
  const providerName = provider === 'google' ? 'Google Calendar' : 'Microsoft 365';

  return (
    <Card className="overflow-hidden">
      {/* Header — amber tone, distinct from connected (green) and auth_error (red) */}
      <div className="bg-warning/5 border-warning/20 border-b px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="bg-card border-border flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] border shadow-sm">
            <ProviderIcon size={21} />
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-foreground block text-sm font-semibold">{providerName}</span>
            <div className="mt-0.5 flex items-center gap-1.5">
              <div className="bg-warning h-[7px] w-[7px] rounded-full" />
              <span className="text-warning text-xs font-semibold">Permissions incomplete</span>
            </div>
          </div>
          {connection.providerEmail && (
            <span className="text-muted-foreground hidden text-xs sm:inline">
              {connection.providerEmail}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-5 py-4">
        {/* Warning message */}
        <div className="bg-warning/5 border-warning/20 mb-4 flex gap-2.5 rounded-[10px] border p-3">
          <AlertTriangle
            className="text-warning mt-0.5 h-[15px] w-[15px] shrink-0"
            aria-hidden="true"
          />
          <div>
            <p className="text-foreground text-[13px] font-semibold">
              We couldn&apos;t read your calendar
            </p>
            <p className="text-warning mt-1 text-[13px] leading-relaxed">
              Your calendar was connected but some permissions weren&apos;t granted. Balo needs full
              access to calculate your real availability.
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
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="overflow-hidden"
            >
              <div className="bg-muted mb-3.5 rounded-lg p-3">
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  During the {providerName} connection step, your calendar provider shows permission
                  toggles that need to be manually turned on. If you clicked through quickly, some
                  toggles may have been left off. Clicking &quot;Fix permissions&quot; will let you
                  re-grant them without creating a new account.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* CTAs */}
        <div className="flex items-center gap-2.5">
          <Button
            size="sm"
            className="bg-warning hover:bg-warning/90 gap-1.5 text-white shadow-sm"
            onClick={onFixPermissions}
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Fix permissions
          </Button>
          <a
            href="https://docs.cronofy.com/developers/faqs/initial-sync/"
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
    </Card>
  );
}
