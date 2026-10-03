'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Video } from 'lucide-react';
import { toast } from 'sonner';
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
  /**
   * A counter the case surface bumps when a follow-up CTA elsewhere on the page (the party
   * card's "Book again", the nudge's "Book a consultation") asks this strip to open the booking
   * dialog on the next available slot. `0` means nothing has been requested.
   */
  openRequest?: number;
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
  openRequest = 0,
}: Readonly<CaseSlotQuickPickProps>): React.JSX.Element | null {
  const { view, reload } = useExpertAvailability(
    expertProfileId,
    QUICK_PICK_WINDOW_DAYS,
    // A follow-up on an open case is existing work, so a paused expert still has real slots.
    'existing_work'
  );
  const [presetSlot, setPresetSlot] = useState<PresetSlot | null>(null);
  const router = useRouter();

  /**
   * This is the only booking entry point that does not leave the page — the nudge and the party
   * card are `<Link>`s out to the expert profile, so they return through a fresh server render.
   * Here the dialog opens over a server-rendered surface, so the refresh is what makes the new
   * booking visible. `BookingFlowDialogProps` has no success callback, so this fires on any
   * close; refreshing after an abandoned booking is harmless.
   */
  const handleDialogClose = useCallback((): void => {
    setPresetSlot(null);
    router.refresh();
    // `router.refresh()` re-runs server components only; these slots come from a client hook
    // with its own fetch, so it needs telling separately or it keeps offering the booked slot.
    reload();
  }, [router, reload]);

  const pills =
    view.kind === 'ready'
      ? view.slots
          .map((slot) => {
            const duration = bestDurationFor(slot.maxDuration);
            return duration === null ? null : { start: slot.start, duration };
          })
          .filter((s): s is { start: string; duration: SlotDurationMinutes } => s !== null)
          .slice(0, QUICK_PICK_COUNT)
      : [];

  // Answers an external "book a follow-up" request once, on the first slot, as soon as the
  // availability read settles. No slot to offer is said out loud rather than swallowed.
  const handledRequestRef = useRef(0);
  const [firstPill] = pills;
  useEffect(() => {
    if (openRequest === 0 || handledRequestRef.current === openRequest) return;
    if (view.kind === 'loading') return;
    handledRequestRef.current = openRequest;
    if (firstPill === undefined) {
      toast.info(`${expert.firstName ?? 'This expert'} has no open times right now.`);
      return;
    }
    const start = new Date(firstPill.start);
    setPresetSlot({
      startIso: start.toISOString(),
      endIso: new Date(start.getTime() + firstPill.duration * 60_000).toISOString(),
      durationMinutes: firstPill.duration,
    });
  }, [openRequest, view.kind, firstPill, expert.firstName]);

  if (view.kind !== 'ready') {
    return null;
  }

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
          onClose={handleDialogClose}
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
          scope="existing_work"
        />
      )}
    </>
  );
}
