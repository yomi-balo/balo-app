'use client';

import { Link2, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PROVIDER_META } from '../_lib/calendar-providers';
import type { CalendarSlotState } from '../_lib/calendar-slot-state';
import type { CalendarConnection, CalendarProvider } from '../_types/calendar';
import { CalendarConnectionMenu } from './calendar-connection-menu';
import { CalendarReconnectNotice } from './calendar-reconnect-notice';
import { CalendarSyncPendingNotice } from './calendar-sync-pending-notice';
import { CalendarO365WaitingNotice } from './calendar-o365-waiting-notice';
import { CalendarBusyCalendarsPanel } from './calendar-busy-calendars-panel';
import { CalendarTargetCalendarPanel } from './calendar-target-calendar-panel';

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
const DIMMED_WRAPPER_CLASS = 'opacity-60';

const STATUS_BADGE: Record<
  CalendarSlotState,
  {
    readonly words: string;
    readonly className?: string;
    readonly variant?: 'secondary' | 'destructive';
  }
> = {
  idle: { words: '' },
  connected: { words: 'Connected', className: 'bg-success text-success-foreground' },
  setting_up: { words: 'Setting up', variant: 'secondary' },
  reconnect_needed: { words: 'Reconnect needed', className: 'bg-warning text-warning-foreground' },
  attempt_failed: { words: "Didn't finish", variant: 'destructive' },
  connecting: { words: 'Waiting for you', variant: 'secondary' },
  // ⚠ BAL-397 fix round — `o365_guidance` IS A MODAL, NOT A CARD, and no longer occupies a
  // provider slot (see `occupiesSlot` in `calendar-connections-section.tsx`), so this card is
  // not rendered for it. Kept as a badge-less entry rather than deleted because
  // `CalendarSlotState` still names the state and this map is total over it — exactly how
  // `idle`, the other unrendered state, is handled.
  o365_guidance: { words: '' },
  o365_waiting: { words: 'Waiting on IT', className: 'bg-warning text-warning-foreground' },
};

/** Slot states with no live connection row to reconnect/disconnect — their own body carries
 *  every affordance the expert needs, so the header menu is hidden entirely. */
const MENU_HIDDEN_STATES = new Set<CalendarSlotState>([
  'idle',
  'connecting',
  'attempt_failed',
  'o365_guidance',
  'o365_waiting',
]);

function formatLastSynced(lastSyncedAt: string | null): string {
  if (!lastSyncedAt) return 'Reading your calendars…';
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
 * BAL-397 §9.2 — ONE provider's card: header (icon, account email, status Badge, options menu)
 * plus a body chosen by `slotState`. `subCalendars[0]?.provider` is never read — `provider`
 * always comes from the prop (itself sourced from the connection row, never a sub-calendar).
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
  const { label, Icon } = PROVIDER_META[provider];
  const badge = STATUS_BADGE[slotState];
  const subLine =
    slotState === 'setting_up'
      ? 'Reading your calendars…'
      : formatLastSynced(connection?.lastSyncedAt ?? null);

  /**
   * The busy-calendars + target-calendar pair, rendered by BOTH `connected` and
   * `reconnect_needed`. Extracted so the ~14 identical lines exist once (SonarCloud's
   * duplication gate would otherwise see a clone in brand-new code) and, more importantly, so
   * `disabled` has exactly ONE place to land.
   *
   * ⚠ `disabled` IS THE REAL INERTNESS (BAL-397 fix round). `pointer-events-none` blocks the
   * mouse and nothing else, and `aria-disabled` on an ancestor `<div>` is advisory — it
   * disables no descendant. Under `reconnect_needed` the panels used to stay fully in the tab
   * order and fully operable, so a keyboard-only expert could tab into a visibly-dimmed row,
   * flip a Switch, and fire a mutation against a connection whose credentials are EXPIRED.
   * Threading `disabled` onto the `Switch` and the `SelectTrigger` themselves is what actually
   * removes them from the tab order and refuses the interaction.
   */
  const renderPanels = (disabled: boolean): React.JSX.Element | null => {
    if (!connection) return null;
    return (
      <>
        <CalendarBusyCalendarsPanel
          connection={connection}
          pending={pending}
          disabled={disabled}
          onToggle={onToggleBusy}
        />
        <div className="border-t">
          <CalendarTargetCalendarPanel
            connection={connection}
            provider={provider}
            pending={pending}
            disabled={disabled}
            onChange={onChangeTarget}
          />
        </div>
      </>
    );
  };

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex items-center gap-3 border-b px-5 py-4">
        <div className="bg-card border-border flex size-10 shrink-0 items-center justify-center rounded-xl border">
          <Icon size={21} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-semibold">
            {connection?.providerEmail ?? label}
          </p>
          <p className="text-muted-foreground mt-0.5 truncate text-xs">{subLine}</p>
        </div>
        {badge.words && (
          <Badge variant={badge.variant} className={badge.className}>
            <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
            {badge.words}
          </Badge>
        )}
        {!MENU_HIDDEN_STATES.has(slotState) && (
          <CalendarConnectionMenu
            provider={provider}
            slotState={slotState}
            onReconnect={() => onReconnect(provider)}
            onDisconnect={() => onDisconnect(provider)}
          />
        )}
      </div>

      {slotState === 'connected' && renderPanels(false)}

      {slotState === 'setting_up' && (
        <CalendarSyncPendingNotice
          provider={provider}
          onFixPermissions={() => onFixPermissions(provider)}
        />
      )}

      {slotState === 'reconnect_needed' && (
        <>
          <CalendarReconnectNotice onReconnect={() => onReconnect(provider)} />
          {connection && (
            <div aria-disabled="true" className={DIMMED_WRAPPER_CLASS}>
              {renderPanels(true)}
            </div>
          )}
        </>
      )}

      {slotState === 'connecting' && (
        <div className="flex flex-col items-start gap-3 px-5 py-4">
          <p className="text-muted-foreground text-sm leading-relaxed">
            Waiting for authorization — a {label} sign-in window should have opened. Finish there,
            then come back.
          </p>
          <div className="flex gap-2">
            <Button type="button" size="sm" className="gap-1.5" onClick={() => onConnect(provider)}>
              <Link2 className="h-3.5 w-3.5" aria-hidden="true" />
              Re-open window
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onCancelConnect(provider)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {slotState === 'attempt_failed' && (
        <div className="flex flex-col items-start gap-3 px-5 py-4">
          <p className="text-muted-foreground text-sm leading-relaxed">
            That sign-in didn&apos;t finish — nothing changed. Give it another go whenever
            you&apos;re ready.
          </p>
          <Button type="button" size="sm" className="gap-1.5" onClick={() => onConnect(provider)}>
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </Button>
        </div>
      )}

      {/* ⚠ NO `o365_guidance` BODY (BAL-397 fix round). The guidance is a Dialog, and this card
          no longer takes a slot for it — the placeholder body that used to live here ("Review
          what to expect in the dialog above") only ever rendered because the transient claimed
          a slot, which unmounted the hero and both provider cards behind the modal overlay. */}

      {slotState === 'o365_waiting' && (
        <CalendarO365WaitingNotice
          onTryAgain={() => onConnect(provider)}
          onCancel={() => onCancelConnect(provider)}
        />
      )}
    </Card>
  );
}
