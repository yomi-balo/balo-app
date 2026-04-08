'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { motion } from 'motion/react';
import { Calendar, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { IconBadge } from '@/components/balo/icon-badge';
import { track, CALENDAR_EVENTS } from '@/lib/analytics';
import { CalendarEmptyState } from './calendar-empty-state';
import { CalendarConnectingState } from './calendar-connecting-state';
import { CalendarConnectedCard } from './calendar-connected-card';
import { CalendarTrustRow } from './calendar-trust-row';
import { getCalendarConnectionAction } from '../_actions/get-calendar-connection';
import { initiateCalendarConnectAction } from '../_actions/initiate-calendar-connect';
import { disconnectCalendarAction } from '../_actions/disconnect-calendar';
import { toggleConflictCheckAction } from '../_actions/toggle-conflict-check';
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

type CalendarViewState = 'loading' | 'empty' | 'connecting' | 'connected';

// ── Component ────────────────────────────────────────────────

export function CalendarTab(): React.JSX.Element {
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<CalendarConnection | null>(null);
  const [viewState, setViewState] = useState<CalendarViewState>('loading');
  const [connectingProvider, setConnectingProvider] = useState<CalendarProvider>('google');

  // Fetch connection on mount
  useEffect(() => {
    let cancelled = false;

    async function fetchConnection(): Promise<void> {
      try {
        const data = await getCalendarConnectionAction();
        if (cancelled) return;
        setConnection(data);
        setViewState(data ? 'connected' : 'empty');
      } catch {
        if (cancelled) return;
        setViewState('empty');
      }
    }

    void fetchConnection();
    return () => {
      cancelled = true;
    };
  }, []);

  // Handle OAuth callback results from search params
  useEffect(() => {
    const calendarConnected = searchParams.get('calendar_connected');
    const calendarError = searchParams.get('calendar_error');

    if (calendarConnected === 'true') {
      toast.success('Calendar connected successfully!');
      // Re-fetch connection data
      void getCalendarConnectionAction().then((data) => {
        setConnection(data);
        setViewState(data ? 'connected' : 'empty');
      });
    } else if (calendarError) {
      toast.error(`Calendar connection failed: ${calendarError}`);
      setViewState('empty');
    }
  }, [searchParams]);

  const handleConnect = useCallback(async (provider: CalendarProvider) => {
    track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider });
    setConnectingProvider(provider);
    setViewState('connecting');

    const result = await initiateCalendarConnectAction(provider);
    if (result.success && result.connectUrl) {
      // Redirect to Cronofy OAuth
      globalThis.location.href = result.connectUrl;
    } else {
      toast.error(result.error ?? 'Failed to initiate calendar connection');
      setViewState('empty');
    }
  }, []);

  const handleCancelConnect = useCallback(() => {
    setViewState('empty');
  }, []);

  const handleDisconnect = useCallback(async () => {
    const result = await disconnectCalendarAction();
    if (result.success) {
      setConnection(null);
      setViewState('empty');
    } else {
      toast.error(result.error ?? 'Failed to disconnect calendar');
    }
  }, []);

  const handleToggleConflictCheck = useCallback(
    async (subCalendarId: string, checked: boolean, provider: CalendarProvider) => {
      track(CALENDAR_EVENTS.SUB_CALENDAR_TOGGLED, {
        sub_calendar_id: subCalendarId,
        conflict_checking: checked,
        provider,
      });

      const result = await toggleConflictCheckAction({
        subCalendarId,
        conflictChecking: checked,
      });
      if (!result.success) {
        toast.error(result.error ?? 'Failed to update conflict checking');
      }
    },
    []
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
        {viewState === 'loading' && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
          </div>
        )}

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

      {/* Trust row — shown always except during connecting/loading */}
      {viewState !== 'connecting' && viewState !== 'loading' && (
        <motion.div variants={itemVariants}>
          <CalendarTrustRow />
        </motion.div>
      )}
    </motion.div>
  );
}
