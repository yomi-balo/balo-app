'use client';

import { useState } from 'react';
import { MoreHorizontal, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CalendarDisconnectConfirm } from './calendar-disconnect-confirm';
import { PROVIDER_META } from '../_lib/calendar-providers';
import type { CalendarProvider } from '../_types/calendar';
import type { CalendarSlotState } from '../_lib/calendar-slot-state';

interface CalendarConnectionMenuProps {
  readonly provider: CalendarProvider;
  readonly slotState: CalendarSlotState;
  readonly onReconnect: () => void;
  readonly onDisconnect: () => void;
}

/**
 * BAL-397 §8 — the trigger is icon-only and MUST carry a provider-specific `aria-label`; the
 * prototype's generic "Calendar options" is ambiguous the moment two menus are on screen.
 * Mounts the `AlertDialog` confirm here too, so a caller only needs one component per card.
 */
export function CalendarConnectionMenu({
  provider,
  slotState,
  onReconnect,
  onDisconnect,
}: Readonly<CalendarConnectionMenuProps>): React.JSX.Element {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const { label } = PROVIDER_META[provider];
  // T18 — Reconnect is offered on BOTH reconnect_needed and connected (a healthy expert may
  // still want to force a fresh OAuth round trip).
  const showReconnect = slotState === 'reconnect_needed' || slotState === 'connected';

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* ⚠ 44×44, NOT 36×36 (BAL-397 fix round, UX WARNING). On a 375px viewport this is
              the ONLY route to Reconnect or Disconnect for this provider, and the plan asserted
              it sat "inside a min-h-11 row" — a row that never shipped with that class, so
              nothing padded the hit box up. `size-11` is Balo's 44px touch-target floor, the
              same one `calendar-sub-calendar-row.tsx` sets explicitly. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11 shrink-0 p-2.5"
            aria-label={`Options for ${label}`}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {showReconnect && (
            <DropdownMenuItem onSelect={onReconnect}>
              <RefreshCw aria-hidden="true" />
              Reconnect
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => setConfirmOpen(true)}
          >
            <X aria-hidden="true" />
            Disconnect
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CalendarDisconnectConfirm
        provider={provider}
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          setConfirmOpen(false);
          onDisconnect();
        }}
      />
    </>
  );
}
