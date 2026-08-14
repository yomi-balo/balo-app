'use client';

import { Signal, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMeetingRoute } from '@/lib/meetings/meeting-route-context';
import { MeetingClockSlot, type MeetingClockState } from './meeting-clock-slot';

/**
 * BAL-435 — the call frame's top bar: title · clock · network · roster.
 *
 * ⚠⚠ THE `<h1>` CARRIES `headingRef` AND `tabIndex={-1}`. It is the primary heading of the LIVE
 * STAGE state, and BAL-132 added that prop precisely so the "you're in" transition announces
 * itself. Exactly one `<h1>` per state — the frame must never render two.
 *
 * ⚠ THE TITLE COMES FROM THE ROUTE CONTEXT, and `'In the call'` is the neutral fallback both
 * guest mounts get. It is NEVER an analytics property.
 */

export type MeetingNetworkQuality = 'strong' | 'unstable';

export interface MeetingRoster {
  /**
   * ⚠⚠ A **SEAT** COUNT, FROM THE GUESTS ENDPOINT — the reserved pair plus pre-admitted and
   * admitted guests, deliberately EXCLUDING waiting knocks. It is NOT the tile count, and the
   * two routinely differ (an invited guest who has not joined still holds a seat). Never
   * conflate them: the People panel (BAL-436) is where the difference is spelled out.
   */
  readonly participantCount: number;
  readonly participantCap: number;
}

export interface MeetingTopBarProps {
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
  /**
   * ⚠⚠ `false` WHEN THE **STAGE** OWNS THE PRIMARY HEADING — i.e. the waiting state, whose own
   * title is the heading of that state.
   *
   * Withholding `headingRef` is NOT sufficient on its own: the bar would still emit a SECOND
   * `<h1>`, and "exactly one `<h1>` per state" is the rule, not "exactly one focused heading".
   * Two `<h1>`s give a screen-reader user two competing answers to "what is this screen", which
   * is precisely the confusion `headingRef` exists to prevent.
   */
  readonly isPrimaryHeading: boolean;
  readonly clock: MeetingClockState;
  readonly network: MeetingNetworkQuality;
  /** ⚠ `null` ⇒ THE BADGE RENDERS NOTHING. An unavailable count is not a count — never a zero. */
  readonly roster: MeetingRoster | null;
  /**
   * BAL-436 — supplied ONLY when the People slot is registered.
   *
   * ⚠ ITS PRESENCE IS WHAT PROMOTES THE CHIP FROM A `<span>` TO A `<button>`. An unregistered
   * slot renders a plain, non-interactive chip rather than a disabled control — the slot rule.
   * On both GUEST mounts `roster` is `null` anyway, so the whole chip is absent there,
   * structurally.
   */
  readonly onOpenPeople?: () => void;
}

const TITLE_CLASSES = 'text-foreground truncate text-sm font-semibold outline-none';

export function MeetingTopBar({
  headingRef,
  isPrimaryHeading,
  clock,
  network,
  roster,
  onOpenPeople,
}: Readonly<MeetingTopBarProps>): React.JSX.Element {
  const { title } = useMeetingRoute();
  const label = title ?? 'In the call';

  return (
    <header className="border-border flex h-13 shrink-0 items-center justify-between border-b px-4">
      <div className="flex min-w-0 items-center gap-3">
        {isPrimaryHeading ? (
          <h1 ref={headingRef} tabIndex={-1} className={TITLE_CLASSES}>
            {label}
          </h1>
        ) : (
          /* ⚠ THE STAGE OWNS THE `<h1>` IN THIS STATE. The title is still shown — it is simply
             not claiming to be the heading of a screen it does not describe. */
          <p className={TITLE_CLASSES}>{label}</p>
        )}
        <MeetingClockSlot state={clock} />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <span
          className={cn(
            'flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs',
            network === 'strong' ? 'text-muted-foreground' : 'text-warning'
          )}
        >
          <Signal
            className={cn('h-[15px] w-[15px]', network === 'strong' ? 'text-success' : '')}
            aria-hidden="true"
          />
          {/* ⚠ The label is hidden on the narrowest screens; the accessible name below carries it. */}
          <span className="hidden sm:inline">{network === 'strong' ? 'Strong' : 'Unstable'}</span>
          <span className="sr-only">
            {network === 'strong' ? 'Connection strong' : 'Connection unstable'}
          </span>
        </span>

        {/*
          ⚠⚠ WITH NO COUNT THE WHOLE CHIP IS **ABSENT**, not a lone glyph, and that is unchanged
          by BAL-436. §7.5's "the badge renders nothing" was written about a TRANSIENT fetch
          failure beside a live button; a permanent, numberless `Users` icon is a decoration that
          reads as a control that broke. An unavailable count is not a count.

          ⚠⚠ BAL-436 REGISTERED THE PEOPLE SLOT, so when `onOpenPeople` is supplied the chip is a
          REAL `<button>` that toggles the panel. Without it — an unregistered slot — it stays a
          plain `<span>`: the slot rule is "absent or real", never a disabled control saying
          "this exists and is being withheld from you".

          ⚠⚠ THE `sr-only` STRING STAYS ON BOTH ARMS. `aria-label` becomes legal on the button
          form, but swapping would be a needless regression risk and the sr-only string is just
          as correct there — the sibling network chip states the same pattern. On the SPAN form
          `aria-label` would be PROHIBITED outright (axe `aria-prohibited-attr`, a generic
          element with no role), which is why it was never used here.
        */}
        {roster === null ? null : <RosterChip roster={roster} onOpenPeople={onOpenPeople} />}
      </div>
    </header>
  );
}

const CHIP_CLASSES = 'text-muted-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs';

/**
 * The seat chip — a `<button>` when the People slot is registered, a `<span>` when it is not.
 *
 * ⚠ EXTRACTED so the two arms share one body and one accessible name. Two inline copies would
 * be the shape a copy edit drifts through.
 */
function RosterChip({
  roster,
  onOpenPeople,
}: Readonly<{ roster: MeetingRoster; onOpenPeople?: () => void }>): React.JSX.Element {
  const body = (
    <>
      <Users className="h-[18px] w-[18px]" aria-hidden="true" />
      <span className="tabular-nums" aria-hidden="true">
        {roster.participantCount} of {roster.participantCap}
      </span>
      <span className="sr-only">
        {`People — ${roster.participantCount} of ${roster.participantCap} seats`}
      </span>
    </>
  );

  if (onOpenPeople === undefined) {
    return (
      <span data-testid="meeting-roster" className={CHIP_CLASSES}>
        {body}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="meeting-roster"
      onClick={onOpenPeople}
      className={cn(
        CHIP_CLASSES,
        // ⚠⚠ 44px, NOT 36px. Every other control on this surface is `min-h-11` / `h-11`, and
        // this one is a real toggle on a live call — reached mid-conversation, often one-handed
        // on a phone. `min-h-9` made the ONE control that opens People the smallest target in
        // the frame. The visual chip stays compact; the hit area does not.
        'hover:text-foreground hover:bg-muted/60 focus-visible:ring-ring min-h-11 transition-colors focus-visible:ring-2 focus-visible:outline-none'
      )}
    >
      {body}
    </button>
  );
}
