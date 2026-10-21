'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Video } from 'lucide-react';
import { useExpertAvailability } from '@/components/availability/use-expert-availability';
import { SLOT_DURATION_LADDER, type SlotDurationMinutes } from '@balo/shared/availability';
import type { BookingSource } from '@/lib/analytics';
import { BookingFlowDialog, type BookingFlowExpert, type PresetSlot } from '@/components/booking';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';

const QUICK_PICK_WINDOW_DAYS = 7;
const QUICK_PICK_COUNT = 3;
const NO_REQUEST: FollowUpRequest = { seq: 0, source: 'book_again' };

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

/** An external ask to open the dialog on its calendar, tagged with the CTA that raised it. */
export interface FollowUpRequest {
  /** Bumped per ask; `0` means nothing has been requested. */
  seq: number;
  source: Extract<BookingSource, 'book_again' | 'case_nudge'>;
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
   * `false` while the expert has paused new work — the dialog's case dropdown then offers open
   * cases only. Separate from `expert.availableForWork`, which stays `true` here so the strip
   * reads `existing_work` slots (see `case-party-card.tsx`).
   */
  newCaseAllowed: boolean;
  /** The dialog's product picker, for when the client switches to "Start a new case". */
  productsTaxonomy?: ProductTaxonomy;
  /**
   * Raised by the case surface when a follow-up CTA elsewhere on the page (the party card's
   * "Book again", the nudge's "Book a consultation") asks this strip to open the booking dialog
   * on its calendar, case fixed. Its `source` attributes the dialog's `FLOW_OPENED` event.
   */
  openRequest?: FollowUpRequest;
}

/**
 * BAL-400 (D4a entry point 3) — the case-surface "next available slot" strip that
 * `case-party-card.tsx:88-91` explicitly did NOT build (no slot endpoint existed at the time).
 * BAL-236 has since shipped the public availability endpoint, so this reuses ITS DATA HOOK
 * (`useExpertAvailability`, the same fetch state machine `ExpertAvailabilityCalendar` embeds)
 * for a compact 3-pill strip — NOT a fork of the calendar UI itself, which stays untouched and
 * embedded, as shipped, inside `BookingFlowDialog`'s own Step 1.
 *
 * Tapping any pill jumps straight to the confirm step with this case preselected. The dialog
 * loads the client's other open cases behind it, so its case dropdown can still switch case or
 * start a new one — a booking started inside a case defaults to that case, it does not lock it.
 *
 * The pill strip silently renders nothing when there is no ready availability
 * (`not_configured`, empty window, unreachable, error) — the party card's "Book with {expert}
 * again" button is still there, so hiding this convenience shortcut is not the "hide the whole
 * section" anti-pattern the balo-ui-skill warns against. That button routes through THIS
 * component's dialog (`openRequest`), opened on Step 1's calendar, which owns its own empty and
 * error states — so the dialog renders whether or not the strip does.
 */
export function CaseSlotQuickPick({
  engagementId,
  caseTitle,
  consultationCount,
  openedAtIso,
  expertProfileId,
  expert,
  viewerEmailDomain,
  newCaseAllowed,
  productsTaxonomy,
  openRequest = NO_REQUEST,
}: Readonly<CaseSlotQuickPickProps>): React.JSX.Element {
  const { view, reload } = useExpertAvailability(
    expertProfileId,
    QUICK_PICK_WINDOW_DAYS,
    // A follow-up on an open case is existing work, so a paused expert still has real slots.
    'existing_work'
  );
  const [dialog, setDialog] = useState<{
    presetSlot: PresetSlot | null;
    source: BookingSource;
  } | null>(null);
  const router = useRouter();

  /**
   * The dialog opens over a server-rendered surface (pills, and the party-card / nudge CTAs),
   * so the refresh is what makes the new booking visible. `BookingFlowDialogProps` has no
   * success callback, so this fires on any close; refreshing after an abandoned booking is
   * harmless.
   */
  const handleDialogClose = useCallback((): void => {
    setDialog(null);
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

  // Answers each external "book a follow-up" request once, by opening the dialog on its calendar.
  const handledRequestRef = useRef(0);
  useEffect(() => {
    if (openRequest.seq === 0 || handledRequestRef.current === openRequest.seq) return;
    handledRequestRef.current = openRequest.seq;
    setDialog({ presetSlot: null, source: openRequest.source });
  }, [openRequest]);

  return (
    <>
      {pills.length > 0 && (
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
                  setDialog({
                    presetSlot: {
                      startIso: start.toISOString(),
                      endIso: end.toISOString(),
                      durationMinutes: pill.duration,
                    },
                    source: 'case_quick_pick',
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
      )}
      {dialog !== null && (
        <BookingFlowDialog
          open
          onClose={handleDialogClose}
          expert={expert}
          source={dialog.source}
          entry={{
            mode: 'fixed_case',
            fixedCase: {
              engagementId,
              title: caseTitle,
              consultationCount,
              openedAtIso,
            },
            presetSlot: dialog.presetSlot,
            newCaseAllowed,
          }}
          viewerEmailDomain={viewerEmailDomain}
          productsTaxonomy={productsTaxonomy}
          onMessage={() => setDialog(null)}
          scope="existing_work"
        />
      )}
    </>
  );
}
