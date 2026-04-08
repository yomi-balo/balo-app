'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Info, RefreshCw, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { track, CALENDAR_EVENTS } from '@/lib/analytics';
import { GoogleIcon, MicrosoftIcon } from './calendar-provider-icons';
import { CalendarSubCalendarRow } from './calendar-sub-calendar-row';
import { CalendarDisconnectConfirm } from './calendar-disconnect-confirm';
import { setTargetCalendarAction } from '../_actions/set-target-calendar';
import type { CalendarConnection, CalendarProvider } from '../_types/calendar';

interface CalendarConnectedCardProps {
  connection: CalendarConnection;
  provider: CalendarProvider;
  onDisconnect: () => void;
  onToggleConflictCheck: (
    subCalendarId: string,
    checked: boolean,
    provider: CalendarProvider
  ) => void;
}

function SyncBadge({
  status,
}: Readonly<{ status: CalendarConnection['status'] }>): React.JSX.Element | null {
  if (status === 'connected') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="bg-success h-[7px] w-[7px] animate-pulse rounded-full" />
        <span className="text-success text-xs font-semibold">Synced</span>
      </div>
    );
  }

  if (status === 'sync_pending') {
    return (
      <div className="flex items-center gap-1.5">
        <RefreshCw className="text-primary h-3 w-3 animate-spin" />
        <span className="text-primary text-xs font-semibold">Syncing...</span>
      </div>
    );
  }

  if (status === 'auth_error') {
    return (
      <div className="flex items-center gap-1.5">
        <div className="bg-destructive h-[7px] w-[7px] rounded-full" />
        <span className="text-destructive text-xs font-semibold">Sync error</span>
      </div>
    );
  }

  return null;
}

export function CalendarConnectedCard({
  connection,
  provider,
  onDisconnect,
  onToggleConflictCheck,
}: Readonly<CalendarConnectedCardProps>): React.JSX.Element {
  const [expanded, setExpanded] = useState(true);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const ProviderIcon = provider === 'google' ? GoogleIcon : MicrosoftIcon;
  const providerLabel = provider === 'google' ? 'Google Calendar' : 'Microsoft 365';
  const isError = connection.status === 'auth_error';
  const activeCount = connection.subCalendars.filter((cal) => cal.conflictChecking).length;

  const handleDisconnect = useCallback((): void => {
    track(CALENDAR_EVENTS.DISCONNECT_INITIATED, { provider });
    toast.info('Calendar integration is coming soon.');
    setConfirmDisconnect(false);
    onDisconnect();
  }, [provider, onDisconnect]);

  const handleReconnect = useCallback((): void => {
    toast.info('Calendar integration is coming soon.');
  }, []);

  return (
    <Card className="overflow-hidden">
      {/* Card header */}
      <div
        className={cn(
          'border-b px-5 py-4',
          isError
            ? 'bg-destructive/5 border-destructive/20'
            : 'from-primary/5 to-primary/10 dark:from-primary/10 dark:to-primary/15 border-border/50 bg-gradient-to-r'
        )}
      >
        <div className="flex items-center gap-3">
          {/* Provider icon */}
          <div className="bg-card border-border flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-[10px] border shadow-sm">
            <ProviderIcon size={21} />
          </div>

          {/* Name + status */}
          <div className="min-w-0 flex-1">
            <span className="text-foreground block text-sm font-semibold">{providerLabel}</span>
            <div className="mt-0.5">
              <SyncBadge status={connection.status} />
            </div>
          </div>

          {/* Email + action */}
          <div className="flex shrink-0 items-center gap-2">
            {connection.providerEmail && (
              <span className="text-muted-foreground hidden text-xs sm:inline">
                {connection.providerEmail}
              </span>
            )}

            {isError && (
              <Button
                variant="destructive"
                size="sm"
                className="h-8 gap-1.5 px-3 text-xs"
                onClick={handleReconnect}
              >
                <RefreshCw className="h-3 w-3" />
                Reconnect
              </Button>
            )}
            {!isError && !confirmDisconnect && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-3 text-xs"
                onClick={() => setConfirmDisconnect(true)}
              >
                <Trash2 className="h-3 w-3" />
                Disconnect all calendars
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Disconnect confirmation */}
      {confirmDisconnect && (
        <CalendarDisconnectConfirm
          onCancel={() => setConfirmDisconnect(false)}
          onConfirm={handleDisconnect}
        />
      )}

      {/* Error banner */}
      {isError && (
        <div className="bg-destructive/5 border-destructive/20 flex items-start gap-2 border-b px-5 py-2.5">
          <Info className="text-destructive mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <p className="text-destructive text-sm leading-relaxed">
            Authorization has expired. Reconnect your account to resume sync.
          </p>
        </div>
      )}

      {/* Sub-calendars section (hidden during error) */}
      {!isError && (
        <>
          {/* Collapsible header */}
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex w-full cursor-pointer items-center justify-between px-5 pt-3 select-none"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-[11px] font-bold tracking-wider uppercase">
                Calendars
              </span>
              <span className="bg-primary/10 text-primary border-primary/20 rounded border px-1.5 py-0 text-[10px] font-bold">
                {activeCount} blocking conflicts
              </span>
            </div>
            <ChevronDown
              className={cn(
                'text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform duration-200',
                expanded && 'rotate-180'
              )}
              aria-hidden="true"
            />
          </button>

          {/* Sub-calendar list */}
          {expanded && (
            <div className="px-2.5 pt-2 pb-1">
              {/* Column header */}
              <div className="flex justify-end px-2.5 pb-1">
                <span className="text-muted-foreground text-[10px] font-semibold tracking-wider uppercase">
                  Use for conflicts
                </span>
              </div>

              {connection.subCalendars.map((cal) => (
                <CalendarSubCalendarRow
                  key={cal.id}
                  calendar={cal}
                  onToggle={onToggleConflictCheck}
                />
              ))}

              {/* Explanation */}
              <div className="flex items-start gap-1.5 px-2.5 pt-2 pb-2.5">
                <Info
                  className="text-muted-foreground mt-0.5 h-3 w-3 shrink-0"
                  aria-hidden="true"
                />
                <span className="text-muted-foreground text-[11px] leading-relaxed">
                  Events on enabled calendars will block that time slot from client bookings. Event
                  titles and details are never visible to clients.
                </span>
              </div>
            </div>
          )}

          {/* Target calendar selector */}
          {connection.subCalendars.length > 0 && (
            <>
              <Separator />
              <TargetCalendarSelector connection={connection} provider={provider} />
            </>
          )}
        </>
      )}
    </Card>
  );
}

// ── Target Calendar Selector ──────────────────────────────────

function TargetCalendarSelector({
  connection,
  provider,
}: Readonly<{
  connection: CalendarConnection;
  provider: CalendarProvider;
}>): React.JSX.Element {
  const primaryCalendar = connection.subCalendars.find((c) => c.primary);
  const defaultValue = connection.targetCalendarId ?? primaryCalendar?.id ?? '';
  const [showSaved, setShowSaved] = useState(false);

  const handleChange = useCallback(
    async (calendarId: string) => {
      const selectedCal = connection.subCalendars.find((c) => c.id === calendarId);
      track(CALENDAR_EVENTS.TARGET_CALENDAR_SET, {
        target_calendar_id: calendarId,
        provider: selectedCal?.provider ?? provider,
      });

      const result = await setTargetCalendarAction({ targetCalendarId: calendarId });
      if (result.success) {
        setShowSaved(true);
      } else {
        toast.info('Calendar integration is coming soon.');
      }
    },
    [connection.subCalendars, provider]
  );

  useEffect(() => {
    if (!showSaved) return;
    const timer = setTimeout(() => setShowSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [showSaved]);

  return (
    <div className="px-5 py-4">
      <div className="mb-1 flex items-center gap-2">
        <label htmlFor="target-calendar-select" className="text-foreground text-sm font-medium">
          Target calendar
        </label>
        <AnimatePresence>
          {showSaved && (
            <motion.span
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="text-success flex items-center gap-1 text-xs font-medium"
            >
              <Check className="h-3 w-3" />
              Saved
            </motion.span>
          )}
        </AnimatePresence>
      </div>
      <p className="text-muted-foreground mb-3 text-xs">
        New consultation events will be created in this calendar.
      </p>
      <Select defaultValue={defaultValue} onValueChange={handleChange}>
        <SelectTrigger id="target-calendar-select" size="sm" className="w-full">
          <SelectValue placeholder="Select a calendar" />
        </SelectTrigger>
        <SelectContent>
          {connection.subCalendars.map((cal) => (
            <SelectItem key={cal.id} value={cal.id}>
              {cal.name}
              {cal.primary ? ' (Primary)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
