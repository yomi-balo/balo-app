'use client';

import { useCallback, useState } from 'react';
import { ChevronUp, PhoneOff } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { MEETING_TOOLBAR_MOBILE_MAX_PX } from '@/lib/meetings/meeting-breakpoints';
import { MeetingConfirmDialog, MeetingMenu, MeetingMenuItem } from './meeting-overlay';

/**
 * BAL-435 — **THE `:169` FIX.** Leaving and ending are two different acts, and only one of them
 * is gated.
 *
 * ── ⚠⚠ WHAT WAS WRONG IN THE PROTOTYPE ──────────────────────────────────────────────────────
 *
 * `balo-in-meeting-ui.jsx:169` renders `{lens === 'expert' ? 'End' : 'Leave'}`. Two defects, and
 * the second is worse than the first:
 *
 *   1. **THE GATE IS A LENS.** Ending a call for everyone is a `host_meetings` act (ADR-1046 §2
 *      names "end call" explicitly), so it resolves on the SERVER's per-actor verdict.
 *      `activeMode` is a view toggle and is NEVER an authorization input (ADR-1029).
 *   2. **IT CONFLATES LEAVING WITH ENDING.** Even with a correct gate, a host's only exit would
 *      end everyone's call — a one-tap, irreversible, other-people-affecting act with no
 *      confirmation. A host stepping out to take a phone call would hang up on their client.
 *
 * ── ⚠⚠ THE GATE ─────────────────────────────────────────────────────────────────────────────
 *
 * **EVERYTHING BELOW RESOLVES ON THE `isOwner` BOOLEAN FROM THE VALIDATED GRANT.** No lens, no
 * `activeMode`, no role string, no `platformRole`, no re-derivation anywhere.
 * `meeting-call-no-lens-gate.test.ts` greps this subtree for those tokens, and
 * `leave-control.test.tsx` asserts "End" is ABSENT FROM THE DOM — not disabled, not hidden —
 * for a non-owner. A disabled control tells somebody that a power exists and is being withheld;
 * an absent one is simply not part of their call.
 *
 * ⚠ `isOwner` CAN BE TRUE FOR AN AGENCY `owner`/`admin` WHO IS NOT THE DELIVERING EXPERT — so no
 * copy here may say "your call" or "your client".
 *
 * ── ⚠⚠ THE HOST CONTROL HAS TWO SHAPES, AND THE MOBILE ONE IS A TARGET-SIZE RULE ────────────
 *
 * Desktop: a split control — "Leave" plus a 32px chevron segment. **Mobile: the whole button
 * opens the Sheet**, because a 32px chevron welded to a 46px destructive button fails the 44px
 * minimum the rest of this feature honours scrupulously, and a near-miss on a phone lands on
 * Leave (the safe failure) or on End (the unsafe one). §12.2 anticipated exactly this.
 *
 * ⚠ `useIsMobile` IS CORRECT HERE because this is BEHAVIOUR, not visibility — and the menu it
 * chooses does not render until someone taps, well after the effect has run, so the SSR-safe
 * `false` first render is never seen.
 *
 * ── ⚠ THE HONEST LIMIT OF "END FOR EVERYONE", AND WHY THE COPY DOES NOT OVER-PROMISE ────────
 *
 * The client-side host action is `updateParticipants({ '*': { eject: true } })`. Per the
 * `daily-co` skill's own trap list, **eject alone does not revoke a token** — a disconnected
 * participant holding a live token can rejoin. `ban: true` / `DELETE /rooms/:name` is a REST
 * call and belongs to **BAL-444** (BAL-436 DECLINED it: server-side vendor work in `apps/api`
 * governed by the `daily-co` skill, not UI). So ruling **R7** drops the
 * "and it can't be undone" clause: it would be false as built. Do not restore it, and do not
 * replace it with "anyone with the link can rejoin" — that advertises the gap and reads as a
 * half-working destructive control.
 */

export interface LeaveControlProps {
  /** ⚠⚠ THE SERVER'S `host_meetings` VERDICT. The ONLY input to the host branch. */
  readonly isOwner: boolean;
  /** "case" / "project" / … — from `back-to-context.ts`'s single table. */
  readonly contextNoun: string;
  /** ⚠ The case-only reassurance line: a case is a money surface. */
  readonly isCase: boolean;
  readonly onLeave: () => void;
  readonly onEndForEveryone: () => void;
  readonly isEnding: boolean;
}

const LEAVE_BUTTON_CLASSES =
  'bg-destructive text-destructive-foreground focus-visible:ring-ring inline-flex h-12 shrink-0 items-center gap-2 rounded-2xl px-[18px] text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none';

export function LeaveControl({
  isOwner,
  contextNoun,
  isCase,
  onLeave,
  onEndForEveryone,
  isEnding,
}: Readonly<LeaveControlProps>): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const isMobile = useIsMobile(MEETING_TOOLBAR_MOBILE_MAX_PX);

  const handleLeaveFromMenu = useCallback((): void => {
    setMenuOpen(false);
    onLeave();
  }, [onLeave]);

  const handleEndFromMenu = useCallback((): void => {
    setMenuOpen(false);
    setConfirmOpen(true);
  }, []);

  if (!isOwner) {
    /*
      ⚠⚠ ONE PLAIN BUTTON, AND "End" APPEARS **NOWHERE IN THIS BRANCH'S DOM**. Not as a disabled
      item, not as `hidden` markup, not as an `aria-label`. Leaving is reversible — BAL-389
      offers "Rejoin" — so there is no confirmation either.
    */
    return (
      <button type="button" onClick={onLeave} className={LEAVE_BUTTON_CLASSES}>
        <PhoneOff className="h-[18px] w-[18px]" aria-hidden="true" />
        Leave
      </button>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-stretch">
        {/*
          ⚠ ON MOBILE THE WHOLE BUTTON IS THE MENU TRIGGER — see the docblock. The bar button
          therefore does NOT leave directly there; "Leave the call" is the menu's first and
          default item, so leaving is still one tap plus one, and neither tap is a 32px target.
        */}
        {isMobile ? null : (
          <>
            <button
              type="button"
              onClick={onLeave}
              className={`${LEAVE_BUTTON_CLASSES} rounded-r-none pr-3`}
            >
              <PhoneOff className="h-[18px] w-[18px]" aria-hidden="true" />
              Leave
            </button>
            {/* ⚠ A HAIRLINE DIVIDER, SAME FILL — one control, two affordances. */}
            <span className="bg-destructive-foreground/25 my-2 w-px" aria-hidden="true" />
          </>
        )}
        <MeetingMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          label="Leaving options"
          trigger={
            <button
              type="button"
              aria-label={isMobile ? 'Leave' : 'Leaving options'}
              aria-haspopup="menu"
              className={
                isMobile
                  ? LEAVE_BUTTON_CLASSES
                  : `${LEAVE_BUTTON_CLASSES} w-8 justify-center rounded-l-none px-0`
              }
            >
              {isMobile ? <PhoneOff className="h-[18px] w-[18px]" aria-hidden="true" /> : null}
              {isMobile ? 'Leave' : null}
              <ChevronUp className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>
          }
        >
          <MeetingMenuItem icon={PhoneOff} label="Leave the call" onSelect={handleLeaveFromMenu} />
          <MeetingMenuItem
            icon={PhoneOff}
            label="End the call for everyone"
            destructive
            onSelect={handleEndFromMenu}
          />
        </MeetingMenu>
      </div>

      {/*
        ⚠ THE CONFIRM IS NOT CLOSED BY ITS OWN ACTION, AND THAT IS DELIBERATE: `onConfirm`
        `preventDefault()`s so `Ending…` is visible while the eject and the leave run, and the act
        is TERMINAL — the frame latches its ended state and replaces the whole toolbar (and this
        dialog with it). Cancel and Esc close it the ordinary way.
      */}
      <MeetingConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="End the call for everyone?"
        confirmLabel="End for everyone"
        pendingLabel="Ending…"
        isPending={isEnding}
        onConfirm={onEndForEveryone}
        body={
          <>
            {/* ⚠ R7: NO "and it can't be undone". See the module docblock. */}
            <p>
              Everyone still here will be disconnected. Nothing is lost — the recap, notes and files
              all stay with the {contextNoun}.
            </p>
            {/* ⚠ CASE ONLY. A case is a money surface, and the unspoken fear at this button is
                "does ending early cost me?". */}
            {isCase ? <p>Time already counted isn&apos;t affected.</p> : null}
          </>
        }
      />
    </>
  );
}
