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
import { CalendarSyncPendingCard } from './calendar-sync-pending-card';
import { CalendarO365GuidanceModal } from './calendar-o365-guidance-modal';
import { CalendarO365WaitingCard } from './calendar-o365-waiting-card';
import { CalendarSessionExpiredCard } from './calendar-session-expired-card';
import { CalendarTrustRow } from './calendar-trust-row';
import { useCalendarPolling } from '../_hooks/use-calendar-polling';
import { getCalendarConnectionAction } from '../_actions/get-calendar-connection';
import { initiateCalendarConnectAction } from '../_actions/initiate-calendar-connect';
import { disconnectCalendarAction } from '../_actions/disconnect-calendar';
import { toggleConflictCheckAction } from '../_actions/toggle-conflict-check';
import { fixCalendarPermissionsAction } from '../_actions/fix-calendar-permissions';
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

type CalendarViewState =
  | 'loading'
  | 'empty'
  | 'connecting'
  | 'connected'
  | 'sync_pending'
  | 'o365_guidance'
  | 'o365_waiting'
  | 'session_expired';

const TEN_MINUTES_MS = 10 * 60 * 1000;

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
        if (data) {
          setViewState(data.status === 'sync_pending' ? 'sync_pending' : 'connected');
        } else {
          setViewState('empty');
        }
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
    let cancelled = false;
    const calendarConnected = searchParams.get('calendar_connected');
    const calendarError = searchParams.get('calendar_error');
    const calendarStatus = searchParams.get('calendar_status');

    if (calendarConnected === 'true') {
      if (calendarStatus === 'sync_pending') {
        toast.warning('Calendar connected but some permissions need fixing.');
        void getCalendarConnectionAction().then((data) => {
          if (cancelled) return;
          setConnection(data);
          setViewState('sync_pending');
        });
        return () => {
          cancelled = true;
        };
      }
      toast.success('Calendar connected successfully!');
      void getCalendarConnectionAction().then((data) => {
        if (cancelled) return;
        setConnection(data);
        setViewState(data ? 'connected' : 'empty');
      });
    } else if (calendarError) {
      if (calendarError === 'o365_admin_approval') {
        setViewState('o365_waiting');
        return () => {
          cancelled = true;
        };
      }
      if (calendarError === 'state_expired' || calendarError === 'callback_failed') {
        void getCalendarConnectionAction().then((data) => {
          if (cancelled) return;
          if (data) {
            setConnection(data);
            setViewState(data.status === 'sync_pending' ? 'sync_pending' : 'connected');
          } else {
            setViewState('session_expired');
          }
        });
        return () => {
          cancelled = true;
        };
      }
      toast.error(`Calendar connection failed: ${calendarError}`);
      setViewState('empty');
    }

    return () => {
      cancelled = true;
    };
  }, [searchParams]);

  // Poll for sync_pending → connected transition
  useCalendarPolling({
    enabled: viewState === 'sync_pending',
    intervalMs: 5_000,
    onStatusChange: (conn) => {
      if (conn.status === 'connected') {
        setConnection(conn);
        setViewState('connected');
        toast.success('Calendar synced successfully!');
        track(CALENDAR_EVENTS.SYNC_PENDING_RESOLVED, {
          provider: conn.subCalendars[0]?.provider ?? connectingProvider,
        });
      }
    },
  });

  // 10-minute timeout for connecting state
  useEffect(() => {
    if (viewState !== 'connecting') return;
    const timer = setTimeout(() => {
      track(CALENDAR_EVENTS.CONNECTING_TIMEOUT, { provider: connectingProvider });
      setViewState('session_expired');
    }, TEN_MINUTES_MS);
    return () => clearTimeout(timer);
  }, [viewState, connectingProvider]);

  const handleConnect = useCallback(
    async (provider: CalendarProvider) => {
      // O365 guidance intercept
      if (provider === 'microsoft' && viewState !== 'o365_guidance') {
        track(CALENDAR_EVENTS.O365_GUIDANCE_SHOWN, {} as Record<string, never>);
        setConnectingProvider('microsoft');
        setViewState('o365_guidance');
        return;
      }

      track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider });
      setConnectingProvider(provider);
      setViewState('connecting');

      const result = await initiateCalendarConnectAction(provider);
      if (result.success && result.connectUrl) {
        globalThis.location.href = result.connectUrl;
      } else {
        toast.error(result.error ?? 'Failed to initiate calendar connection');
        setViewState('empty');
      }
    },
    [viewState]
  );

  const handleO365Continue = useCallback(async () => {
    track(CALENDAR_EVENTS.O365_GUIDANCE_CONTINUED, {} as Record<string, never>);
    track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider: 'microsoft' });
    setViewState('connecting');
    const result = await initiateCalendarConnectAction('microsoft');
    if (result.success && result.connectUrl) {
      globalThis.location.href = result.connectUrl;
    } else {
      toast.error(result.error ?? 'Failed to initiate calendar connection');
      setViewState('empty');
    }
  }, []);

  const handleCancelConnect = useCallback(() => {
    if (viewState === 'o365_guidance') {
      track(CALENDAR_EVENTS.O365_GUIDANCE_CANCELLED, {} as Record<string, never>);
    }
    setViewState('empty');
  }, [viewState]);

  const handleDisconnect = useCallback(async () => {
    const result = await disconnectCalendarAction();
    if (result.success) {
      setConnection(null);
      setViewState('empty');
    } else {
      toast.error(result.error ?? 'Failed to disconnect calendar');
    }
  }, []);

  const handleReconnect = useCallback(async (provider: CalendarProvider) => {
    track(CALENDAR_EVENTS.RECONNECT_CLICKED, { provider });
    track(CALENDAR_EVENTS.CONNECT_INITIATED, { provider });
    setConnectingProvider(provider);
    setViewState('connecting');

    const result = await initiateCalendarConnectAction(provider);
    if (result.success && result.connectUrl) {
      globalThis.location.href = result.connectUrl;
    } else {
      toast.error(result.error ?? 'Failed to initiate calendar reconnection');
      setViewState('connected');
    }
  }, []);

  const handleFixPermissions = useCallback(async () => {
    const provider = connection?.subCalendars[0]?.provider ?? connectingProvider;
    track(CALENDAR_EVENTS.FIX_PERMISSIONS_CLICKED, { provider });

    const result = await fixCalendarPermissionsAction();
    if (result.success && result.relinkUrl) {
      globalThis.location.href = result.relinkUrl;
    } else {
      toast.error('Failed to generate permission fix link. Please try again.');
    }
  }, [connection, connectingProvider]);

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

  // Centered states hide the trust row
  const hideTrustRow =
    viewState === 'connecting' ||
    viewState === 'loading' ||
    viewState === 'o365_waiting' ||
    viewState === 'session_expired';

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
            onReconnect={handleReconnect}
            onToggleConflictCheck={handleToggleConflictCheck}
          />
        )}

        {viewState === 'sync_pending' && connection && (
          <CalendarSyncPendingCard
            connection={connection}
            provider={connection.subCalendars[0]?.provider ?? connectingProvider}
            onFixPermissions={handleFixPermissions}
          />
        )}

        {viewState === 'o365_guidance' && (
          <CalendarO365GuidanceModal
            onContinue={handleO365Continue}
            onCancel={handleCancelConnect}
          />
        )}

        {viewState === 'o365_waiting' && (
          <CalendarO365WaitingCard
            onTryAgain={() => {
              track(CALENDAR_EVENTS.O365_WAITING_TRY_AGAIN, {} as Record<string, never>);
              void handleConnect('microsoft');
            }}
            onCancel={handleCancelConnect}
          />
        )}

        {viewState === 'session_expired' && (
          <CalendarSessionExpiredCard
            provider={connectingProvider}
            onTryAgain={() => {
              track(CALENDAR_EVENTS.SESSION_EXPIRED_TRY_AGAIN, { provider: connectingProvider });
              void handleConnect(connectingProvider);
            }}
          />
        )}
      </motion.div>

      {/* Trust row — hidden for centered/loading states */}
      {!hideTrustRow && (
        <motion.div variants={itemVariants}>
          <CalendarTrustRow />
        </motion.div>
      )}
    </motion.div>
  );
}
