'use client';

import { Link2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PROVIDER_META } from '../_lib/calendar-providers';
import { CALENDAR_SLOT_STATUS } from '../_lib/calendar-slot-status';
import type { CalendarSlotState } from '../_lib/calendar-slot-state';
import type { CalendarConnection, CalendarProvider } from '../_types/calendar';
import { CalendarConnectionMenu } from './calendar-connection-menu';
import { CalendarReconnectNotice } from './calendar-reconnect-notice';
import { CalendarSyncPendingNotice } from './calendar-sync-pending-notice';
import { CalendarO365WaitingNotice } from './calendar-o365-waiting-notice';
import { CalendarBusyCalendarsPanel } from './calendar-busy-calendars-panel';
import { CalendarTargetCalendarPanel } from './calendar-target-calendar-panel';
import { CalendarRowHeader } from './calendar-row-header';
import { SettingsStatusPill } from './settings-card';

interface CalendarConnectionCardProps {
  readonly provider: CalendarProvider;
  readonly slotState: CalendarSlotState;
  readonly connection: CalendarConnection | undefined;
  readonly pending: boolean;
  readonly onConnect: (provider: CalendarProvider) => void;
  readonly onCancelConnect: (provider: CalendarProvider) => void;
  readonly onReconnect: (provider: CalendarProvider) => void;
  readonly onFixPermissions: (provider: CalendarProvider) => void;
  readonly onDisconnect: (provider: CalendarProvider) => void;
  readonly onToggleBusy: (calendarId: string, checked: boolean, provider: CalendarProvider) => void;
  readonly onChangeTarget: (calendarId: string) => void;
}

/** The dimmed-and-INERT wrapper used by `reconnect_needed`. Presentation only — the real
 *  inertness is `disabled` threaded onto the primitives inside (see `renderPanels`). */
const DIMMED_WRAPPER_CLASS = 'flex flex-col gap-4 opacity-60';

/** In-row action buttons: the 44px touch floor on mobile, compact from `sm` up. */
const ROW_ACTION_CLASS = 'h-11 gap-1.5 sm:h-8';

/** Slot states with no live connection row to reconnect/disconnect — their own body carries
 *  every affordance the expert needs, so the header menu is hidden entirely. */
const MENU_HIDDEN_STATES = new Set<CalendarSlotState>([
  'idle',
  'connecting',
  'attempt_failed',
  'o365_guidance',
  'o365_waiting',
]);

/** Slot states whose subline reports the last sync — only once one is known. */
const SYNC_REPORTING_STATES = new Set<CalendarSlotState>(['connected', 'reconnect_needed']);

function formatLastSynced(lastSyncedAt: string): string {
  const diffMs = Date.now() - new Date(lastSyncedAt).getTime();
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 1) return 'Synced just now';
  if (diffMinutes < 60) return `Last synced ${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `Last synced ${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `Last synced ${diffDays}d ago`;
}

/**
 * Who the row's account is: its email; else its primary calendar's name when that is an
 * address (Google names the primary calendar after the account email); else the provider's
 * sublabel ("Google Workspace or Gmail"), for a row with no account behind it yet.
 */
function accountLabel(connection: CalendarConnection | undefined, sublabel: string): string {
  if (connection?.providerEmail) return connection.providerEmail;
  const primaryName = connection?.subCalendars.find((cal) => cal.primary)?.name;
  if (primaryName?.includes('@')) return primaryName;
  return sublabel;
}

/**
 * The fragment after the account label. `setting_up` is still reading the calendars; a live or
 * lapsed connection reports its last sync once there is one — never a pending-sync message
 * beside a "Connected" pill.
 */
function syncFragment(slotState: CalendarSlotState, lastSyncedAt: string | null): string | null {
  if (slotState === 'setting_up') return 'Reading your calendars…';
  if (lastSyncedAt && SYNC_REPORTING_STATES.has(slotState)) return formatLastSynced(lastSyncedAt);
  return null;
}

/**
 * ONE connection's row in the Calendars card: the shared header (brand tile, provider label,
 * account email, status pill, options menu) plus a body chosen by `slotState`, indented to sit
 * under the label. A connected row's busy-calendar toggles and booking-target picker are always
 * visible — nothing to expand.
 *
 * Everything the row renders comes from its own props, so it renders unchanged for several
 * accounts of the same provider. `subCalendars[0]?.provider` is never read — `provider` always
 * comes from the prop (itself sourced from the connection row, never a sub-calendar).
 */
export function CalendarConnectionCard({
  provider,
  slotState,
  connection,
  pending,
  onConnect,
  onCancelConnect,
  onReconnect,
  onFixPermissions,
  onDisconnect,
  onToggleBusy,
  onChangeTarget,
}: Readonly<CalendarConnectionCardProps>): React.JSX.Element {
  const { label, sublabel } = PROVIDER_META[provider];
  const status = CALENDAR_SLOT_STATUS[slotState];
  const syncLine = syncFragment(slotState, connection?.lastSyncedAt ?? null);

  /**
   * The busy-calendars + target-calendar pair, rendered by BOTH `connected` and
   * `reconnect_needed`. Extracted so the pair exists once (SonarCloud's duplication gate would
   * otherwise see a clone) and, more importantly, so `disabled` has exactly ONE place to land.
   *
   * ⚠ `disabled` IS THE REAL INERTNESS (BAL-397 fix round). `pointer-events-none` blocks the
   * mouse and nothing else, and `aria-disabled` on an ancestor `<div>` is advisory — it
   * disables no descendant. Under `reconnect_needed` the panels used to stay fully in the tab
   * order and fully operable, so a keyboard-only expert could tab into a visibly-dimmed row,
   * flip a Switch, and fire a mutation against a connection whose credentials are EXPIRED.
   * Threading `disabled` onto the `Switch` and the `SelectTrigger` themselves is what actually
   * removes them from the tab order and refuses the interaction.
   */
  const renderPanels = (conn: CalendarConnection, disabled: boolean): React.JSX.Element => (
    <>
      <CalendarBusyCalendarsPanel
        connection={conn}
        pending={pending}
        disabled={disabled}
        onToggle={onToggleBusy}
      />
      <CalendarTargetCalendarPanel
        connection={conn}
        provider={provider}
        pending={pending}
        disabled={disabled}
        onChange={onChangeTarget}
      />
    </>
  );

  const renderBody = (): React.ReactNode => {
    switch (slotState) {
      case 'connected':
        if (!connection) return null;
        return renderPanels(connection, false);
      case 'setting_up':
        return (
          <CalendarSyncPendingNotice
            provider={provider}
            onFixPermissions={() => onFixPermissions(provider)}
          />
        );
      case 'reconnect_needed':
        return (
          <>
            <CalendarReconnectNotice onReconnect={() => onReconnect(provider)} />
            {connection && (
              <div aria-disabled="true" className={DIMMED_WRAPPER_CLASS}>
                {renderPanels(connection, true)}
              </div>
            )}
          </>
        );
      case 'connecting':
        return (
          <div className="flex flex-col items-start gap-2.5">
            <p className="text-muted-foreground text-[12.5px] leading-relaxed">
              Waiting for authorization — a {label} sign-in window should have opened. Finish there,
              then come back.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                className={ROW_ACTION_CLASS}
                onClick={() => onConnect(provider)}
              >
                <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
                Re-open window
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={ROW_ACTION_CLASS}
                onClick={() => onCancelConnect(provider)}
              >
                Cancel
              </Button>
            </div>
          </div>
        );
      case 'attempt_failed':
        return (
          <div className="flex flex-col items-start gap-2.5">
            <p className="text-muted-foreground text-[12.5px] leading-relaxed">
              That sign-in didn&apos;t finish — nothing changed. Give it another go whenever
              you&apos;re ready.
            </p>
            <Button
              type="button"
              size="sm"
              className={ROW_ACTION_CLASS}
              onClick={() => onConnect(provider)}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Try again
            </Button>
          </div>
        );
      case 'o365_waiting':
        return (
          <CalendarO365WaitingNotice
            onTryAgain={() => onConnect(provider)}
            onCancel={() => onCancelConnect(provider)}
          />
        );
      // ⚠ NO `o365_guidance` BODY (BAL-397). The guidance is a Dialog, and this row
      // takes no slot for it — a placeholder body here ("Review what to expect in the dialog
      // above") only ever rendered because the transient claimed a slot, which unmounted
      // every other row behind the modal overlay.
      case 'o365_guidance':
      case 'idle':
        return null;
      default: {
        const exhaustive: never = slotState;
        throw new Error(`Unhandled calendar slot state: ${String(exhaustive)}`);
      }
    }
  };

  const body = renderBody();

  return (
    <div className="flex flex-col gap-3">
      <CalendarRowHeader
        provider={provider}
        subline={
          <>
            <span>{accountLabel(connection, sublabel)}</span>
            {syncLine && <span> · {syncLine}</span>}
          </>
        }
      >
        {status && <SettingsStatusPill tone={status.tone}>{status.words}</SettingsStatusPill>}
        {!MENU_HIDDEN_STATES.has(slotState) && (
          <CalendarConnectionMenu
            provider={provider}
            slotState={slotState}
            onReconnect={() => onReconnect(provider)}
            onDisconnect={() => onDisconnect(provider)}
          />
        )}
      </CalendarRowHeader>

      {body && <div className="flex flex-col gap-4 pl-10">{body}</div>}
    </div>
  );
}
