'use client';

import type { CallKind } from '@balo/shared/notifications';
import { ChevronLeft, Loader2, MessageSquare, Receipt } from 'lucide-react';
import type { SlotDurationMinutes } from '@balo/shared/availability';
import { Button } from '@/components/ui/button';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import { StaleSlotBanner } from '../booking-error-panels';
import { GuestInviteComposer, type GuestDraft } from '../guest-invite-composer';

export interface ConfirmIntroCallSlot {
  startIso: string;
  endIso: string;
  durationMinutes: SlotDurationMinutes;
}

export interface StepConfirmIntroCallProps {
  slot: ConfirmIntroCallSlot;
  viewerTimezone: string;
  requestTitle: string;
  onChangeTime: () => void;

  guests: readonly GuestDraft[];
  onGuestsChange: (guests: readonly GuestDraft[]) => void;
  viewerEmailDomain: string | null;
  clientCompanyName: string | null;

  staleSlot: boolean;
  /** `call` once this expert is the one the request chose — drops "intro" from the copy. */
  callKind: CallKind;

  submitting: boolean;
  onBack: () => void;
  onSubmit: () => void;
}

/**
 * BAL-283 — the intro-call confirm step (design §Step 2). A NARROWER SIBLING of `StepConfirm`,
 * not a reuse of it: `StepConfirm` structurally carries `BillingLine` / `CaseChoiceSection` /
 * `CompanyPicker` as unconditional children, so stripping those via optional props would leave
 * a component that is 80% dead branches for this entry (plan §12.1).
 *
 * ⚠⚠ NO `BillingLine`, NO `CancellationLine`, NO `CaseChoiceSection`, NO `CompanyPicker` — a
 * direct pin on "no money, ever, on this surface" (Ruling 2). The single reassurance line
 * below sits in `BillingLine`'s visual slot (same treatment, same icon-row pattern) and says
 * something genuinely different: it names no rate and frames no money. BAL-614 records the
 * owner's amendment of Ruling 2's icon: it is `Receipt`, as on the booking flow, because
 * `Sparkles` read as an AI feature.
 */
export function StepConfirmIntroCall({
  slot,
  viewerTimezone,
  requestTitle,
  onChangeTime,
  guests,
  onGuestsChange,
  viewerEmailDomain,
  clientCompanyName,
  staleSlot,
  callKind,
  submitting,
  onBack,
  onSubmit,
}: Readonly<StepConfirmIntroCallProps>): React.JSX.Element {
  const noun = callKind === 'call' ? 'Call' : 'Intro call';
  return (
    <div className="space-y-5 p-6">
      {staleSlot && <StaleSlotBanner onChooseNewTime={onChangeTime} />}

      <div className="border-border bg-muted/30 flex items-center justify-between rounded-xl border p-4">
        <div>
          <p className="text-foreground text-sm font-semibold">
            <LocalDateTime
              iso={slot.startIso}
              variant="day-month-time-range"
              durationMinutes={slot.durationMinutes}
              timeZone={viewerTimezone}
              showLength={false}
            />
          </p>
          <p className="text-muted-foreground text-xs">
            {noun} · {slot.durationMinutes} min
          </p>
        </div>
        <button
          type="button"
          onClick={onChangeTime}
          className="text-primary focus-visible:ring-ring rounded-md text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          Change
        </button>
      </div>

      <div className="border-border bg-muted/20 flex items-center gap-2 rounded-lg border p-3">
        <MessageSquare className="text-muted-foreground h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <p className="text-muted-foreground text-xs">
          {noun} for &ldquo;{requestTitle}&rdquo;
        </p>
      </div>

      {/* D7 — guests ARE allowed on the intro call (owner amendment); routes through the
          SAME BAL-408 composer BAL-400 already uses, no second invite path.

          ⚠ BOTH OVERRIDES ARE RULING-2 / PRE-ENGAGEMENT PINS, NOT COSMETICS (round-1 C3/C4):
          · `showPricingNote={false}` — the composer's default counter reads "guests don't
            change what you pay", which put money framing on the one surface whose own docblock
            pins "no money, ever". It was also a non-sequitur: there is nothing to pay.
          · `accessScope="call"` — the composer's default copy promises a same-domain colleague
            "this whole case, including consultations held before today". An intro call is
            PRE-ENGAGEMENT: there is no case and no prior consultation, so that copy was
            factually false on the common path. Note the irony this closes — this component
            rejected `StepConfirm` precisely because it structurally carries
            `CaseChoiceSection`, then reintroduced case chrome through the guest composer. */}
      <GuestInviteComposer
        guests={guests}
        onChange={onGuestsChange}
        otherParticipantCount={2}
        viewerEmailDomain={viewerEmailDomain}
        clientCompanyName={clientCompanyName}
        accessScope="call"
        showPricingNote={false}
      />

      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <Receipt className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        Free — no charge, no commitment.
      </div>

      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={submitting}>
          <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Back
        </Button>
        <Button type="button" className="flex-1" onClick={onSubmit} disabled={submitting}>
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Booking…
            </>
          ) : (
            'Confirm & book call'
          )}
        </Button>
      </div>
    </div>
  );
}
