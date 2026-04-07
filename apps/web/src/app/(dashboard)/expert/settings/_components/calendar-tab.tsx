'use client';

import { useCallback, useState } from 'react';
import { motion } from 'motion/react';
import { Calendar } from 'lucide-react';
import { toast } from 'sonner';
import { IconBadge } from '@/components/balo/icon-badge';
import { track, CALENDAR_EVENTS } from '@/lib/analytics';
import { CalendarEmptyState } from './calendar-empty-state';
import { CalendarConnectingState } from './calendar-connecting-state';
import { CalendarConnectedCard } from './calendar-connected-card';
import { CalendarTrustRow } from './calendar-trust-row';
import type { CalendarConnection, CalendarProvider } from '../_types/calendar';

// ── Animation variants (matches payouts-tab + rate-tab) ──────

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3, ease: 'easeOut' as const } },
};

// ── View state derivation ────────────────────────────────────

type CalendarViewState = 'empty' | 'connecting' | 'connected';

/**
 * Hook placeholder for BAL-232 integration.
 * Returns null (empty state) until the calendar backend is built.
 */
function useCalendarConnection(): CalendarConnection | null {
  return null;
}

// ── Component ────────────────────────────────────────────────

export function CalendarTab(): React.JSX.Element {
  const connection = useCalendarConnection();

  const [viewState, setViewState] = useState<CalendarViewState>(connection ? 'connected' : 'empty');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- setter will be used in BAL-232 OAuth flow
  const [connectingProvider, setConnectingProvider] = useState<CalendarProvider>('google');

  const handleConnect = useCallback((provider: CalendarProvider) => {
    track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider });
    toast.info('Calendar integration is coming soon.');
    // When BAL-232 is ready, this will initiate the OAuth flow:
    // setConnectingProvider(provider);
    // setViewState('connecting');
  }, []);

  const handleCancelConnect = useCallback(() => {
    setViewState('empty');
  }, []);

  const handleDisconnect = useCallback(() => {
    // Stub: BAL-232 will handle the real disconnect flow
    setViewState('empty');
  }, []);

  const handleToggleConflictCheck = useCallback(
    (subCalendarId: string, checked: boolean) => {
      track(CALENDAR_EVENTS.SUB_CALENDAR_TOGGLED, {
        sub_calendar_id: subCalendarId,
        conflict_checking: checked,
        provider: connectingProvider,
      });
      toast.info('Calendar integration is coming soon.');
    },
    [connectingProvider]
  );

  return (
    <motion.div variants={containerVariants} initial="hidden" animate="show">
      {/* Header */}
      <motion.div variants={itemVariants} className="mb-8 flex items-center gap-3">
        <IconBadge icon={Calendar} color="#7C3AED" size={44} iconSize={22} />
        <div>
          <h1 className="text-foreground text-2xl font-semibold">Calendar</h1>
          <p className="text-muted-foreground mt-0.5 text-sm leading-relaxed">
            Connect your calendar so Balo only shows clients times when you&apos;re genuinely free.
          </p>
        </div>
      </motion.div>

      {/* View state content */}
      <motion.div variants={itemVariants}>
        {viewState === 'empty' && <CalendarEmptyState onConnect={handleConnect} />}

        {viewState === 'connecting' && (
          <CalendarConnectingState provider={connectingProvider} onCancel={handleCancelConnect} />
        )}

        {viewState === 'connected' && connection && (
          <CalendarConnectedCard
            connection={connection}
            provider={connection.subCalendars[0]?.provider ?? connectingProvider}
            onDisconnect={handleDisconnect}
            onToggleConflictCheck={handleToggleConflictCheck}
          />
        )}
      </motion.div>

      {/* Trust row — shown always except during connecting */}
      {viewState !== 'connecting' && (
        <motion.div variants={itemVariants}>
          <CalendarTrustRow />
        </motion.div>
      )}
    </motion.div>
  );
}
