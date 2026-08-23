'use client';

import { useState } from 'react';
import { Video } from 'lucide-react';
import { useExpertAvailability } from '@/components/availability/use-expert-availability';
import { SLOT_DURATION_LADDER, type SlotDurationMinutes } from '@balo/shared/availability';
import { BookingFlowDialog, type BookingFlowExpert, type PresetSlot } from '@/components/booking';

const QUICK_PICK_WINDOW_DAYS = 7;
const QUICK_PICK_COUNT = 3;

/** The longest allowed duration that still fits inside `maxDuration`, or `null` if none does. */
function bestDurationFor(maxDuration: number): SlotDurationMinutes | null {
  const fitting = SLOT_DURATION_LADDER.filter((d) => d <= maxDuration);
  return fitting.length === 0 ? null : (fitting[fitting.length - 1] ?? null);
}

function formatPill(iso: string): string {
  const date = new Date(iso);
  const day = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date);
  const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(
    date
  );
  return `${day} ${time}`;
}

export interface CaseSlotQuickPickProps {
  engagementId: string;
  caseTitle: string;
  consultationCount: number;
  openedAtIso: string;
  expertProfileId: string;
  expert: BookingFlowExpert;
  /**
   * UX-2 (BAL-400 round 2) — the viewer's own SESSION-derived email domain (never case-view
   * PII; `load-case.ts` deliberately excludes `users.email`), so the guest-invite composer's
   * "same company as you" disclosure is honest from this entry point too. `null` when unknown.
   */
  viewerEmailDomain: string | null;
}

/**
 * BAL-400 (D4a entry point 3) — the case-surface "next available slot" strip that
 * `case-party-card.tsx:88-91` explicitly did NOT build (no slot endpoint existed at the time).
 * BAL-236 has since shipped the public availability endpoint, so this reuses ITS DATA HOOK
 * (`useExpertAvailability`, the same fetch state machine `ExpertAvailabilityCalendar` embeds)
 * for a compact 3-pill strip — NOT a fork of the calendar UI itself, which stays untouched and
 * embedded, as shipped, inside `BookingFlowDialog`'s own Step 1.
 *
 * Tapping any pill jumps straight to the confirm step with the case FIXED — the case-choice
 * section is absent from the tree entirely, not defaulted or collapsed (D4a).
 *
 * Silently renders nothing when there is no ready availability (`not_configured`, empty
 * window, unreachable, error) — the party card's "Book with {expert} again" button is the
 * always-present fallback action, so hiding this convenience shortcut here is not the
 * "hide the whole section" anti-pattern the balo-ui-skill warns against.
 */
export function CaseSlotQuickPick({
  engagementId,
  caseTitle,
  consultationCount,
  openedAtIso,
  expertProfileId,
  expert,
  viewerEmailDomain,
}: Readonly<CaseSlotQuickPickProps>): React.JSX.Element | null {
  const { view } = useExpertAvailability(expertProfileId, QUICK_PICK_WINDOW_DAYS);
  const [presetSlot, setPresetSlot] = useState<PresetSlot | null>(null);

  if (view.kind !== 'ready') {
    return null;
  }

  const pills = view.slots
    .map((slot) => {
      const duration = bestDurationFor(slot.maxDuration);
      return duration === null ? null : { start: slot.start, duration };
    })
    .filter((s): s is { start: string; duration: SlotDurationMinutes } => s !== null)
    .slice(0, QUICK_PICK_COUNT);

  if (pills.length === 0) {
    return null;
  }

  return (
    <>
      <div className="mt-3">
        <p className="text-muted-foreground mb-1.5 text-xs font-medium">Book the next call</p>
        <div className="flex flex-wrap gap-1.5">
          {pills.map((pill) => (
            <button
              key={pill.start}
              type="button"
              onClick={() => {
                const start = new Date(pill.start);
                const end = new Date(start.getTime() + pill.duration * 60_000);
                setPresetSlot({
                  startIso: start.toISOString(),
                  endIso: end.toISOString(),
                  durationMinutes: pill.duration,
                });
              }}
              className="border-border bg-card hover:border-primary/40 hover:bg-primary/5 focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <Video className="text-muted-foreground h-3 w-3" aria-hidden="true" />
              {formatPill(pill.start)}
            </button>
          ))}
        </div>
      </div>
      {presetSlot !== null && (
        <BookingFlowDialog
          open
          onClose={() => setPresetSlot(null)}
          expert={expert}
          source="case_quick_pick"
          entry={{
            mode: 'fixed_case',
            fixedCase: {
              engagementId,
              title: caseTitle,
              consultationCount,
              openedAtIso,
            },
            presetSlot,
          }}
          viewerEmailDomain={viewerEmailDomain}
          onMessage={() => setPresetSlot(null)}
        />
      )}
    </>
  );
}
