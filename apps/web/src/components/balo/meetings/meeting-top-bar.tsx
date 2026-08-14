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
}

const TITLE_CLASSES = 'text-foreground truncate text-sm font-semibold outline-none';

export function MeetingTopBar({
  headingRef,
  isPrimaryHeading,
  clock,
  network,
  roster,
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
          ⚠⚠ A NON-INTERACTIVE `<span>`, NOT A BUTTON, AND THAT IS THE SLOT RULE. The People panel
          is BAL-436's; an unregistered slot renders NOTHING interactive rather than a disabled
          control that says "this exists and is being withheld from you".

          ⚠⚠ AND WITH NO COUNT THE WHOLE CHIP IS **ABSENT**, not a lone glyph. §7.5's "the badge
          renders nothing" was written about a TRANSIENT fetch failure beside a live button; the
          seat count is BAL-436's and is `null` on every render today, so what shipped was a
          permanent, numberless, unclickable `Users` icon — a decoration that reads as a control
          that broke. An unavailable count is not a count, and an unregistered slot is not a chip.
        */}
        {roster === null ? null : (
          <span
            data-testid="meeting-roster"
            className="text-muted-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
          >
            <Users className="h-[18px] w-[18px]" aria-hidden="true" />
            <span className="tabular-nums" aria-hidden="true">
              {roster.participantCount} of {roster.participantCap}
            </span>
            {/*
              ⚠⚠ AN `sr-only` STRING, **NOT** AN `aria-label` ON THE `<span>`. `aria-label` on a
              generic element with no role is PROHIBITED (axe `aria-prohibited-attr`) and is
              simply IGNORED by assistive tech — so the accessible name this bar is supposed to
              expose was reaching nobody. The sibling network chip above already states the
              pattern. When BAL-436 makes this a real `<button>`, `aria-label` becomes legal
              again — but the sr-only string is just as correct there.
            */}
            <span className="sr-only">
              {`People — ${roster.participantCount} of ${roster.participantCap} seats`}
            </span>
          </span>
        )}
      </div>
    </header>
  );
}
