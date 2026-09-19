'use client';

import { useCallback, useState } from 'react';
import { MEETING_PANEL_EVENTS, track, type MeetingPanelRemovalState } from '@/lib/analytics';
import type { GuestRosterState } from '@/lib/meetings/guest-roster';
import type { MeetingMemberPanelRegistration } from '@/lib/meetings/meeting-panels';
import { MeetingConfirmDialog } from './meeting-overlay';

/**
 * BAL-476 (R3) — the People panel's Remove flow: confirm → revoke → toast → refetch.
 *
 * ⚠ EXTRACTED FROM `PeoplePanel` FOR SonarCloud's COGNITIVE-COMPLEXITY CEILING OF 15, which that
 * component is already at its extraction limit against (`PeoplePanelFooter` exists for exactly
 * this reason). The repo's precedent is to extract, never to disable the rule.
 */

/** Which copy variant a row earns. ⚠ `waiting` is absent — see {@link removalStateFor}. */
export interface PendingGuestRemoval {
  readonly guestId: string;
  readonly displayName: string;
  readonly state: MeetingPanelRemovalState;
  /**
   * ⚠⚠ THE INVITE CHANNEL, AND IT PICKS THE COPY — `GuestRosterRow.isUnverified` is exactly
   * `inviteChannel === 'link'`, so it is the channel the row already carries rather than a second
   * derivation. `true` ⇒ a lobby visitor who KNOCKED with a forwarded meeting URL.
   *
   * ⚠ IT IS LOAD-BEARING FOR HONESTY, NOT FOR STYLE. `removeGuest` sends a `link` row NEITHER the
   * removal email NOR the `METHOD:CANCEL` — its address is self-declared and Balo never verified
   * it — so the email-row copy's "We'll let them know by email, and the event will come off their
   * calendar" would be three claims the server deliberately does not honour, on the very path the
   * host-gated link rule opened up. It also says "invite", and a lobby visitor never had one.
   */
  readonly isUnverified: boolean;
}

/**
 * ⚠⚠ `waiting` ⇒ `null`, AND THAT IS A PRODUCT RULE, NOT A GAP. A lobby row offers Deny and only
 * Deny: Deny already produces the identical practical outcome (they never get in), and one
 * control reads better on that row than two destructively-styled ones with overlapping meaning.
 *
 * ⚠ CORRECTED (BAL-476, fix round 2): an earlier version justified this by saying Remove was
 * "gated on same-party membership alone", so offering it would let a non-host achieve what Deny
 * reserves for hosts. That hole is now CLOSED SERVER-SIDE — a `link` row's removal requires
 * `host_meetings`, exactly as Deny does, because a lobby row's `party` is a placeholder no rule
 * may derive entitlement from. The section still offers only Deny, but now for a UX reason rather
 * than as the (UI-only, and therefore never sufficient) fix for an authorization gap.
 */
export function removalStateFor(state: GuestRosterState): MeetingPanelRemovalState | null {
  return state === 'waiting' ? null : state;
}

/**
 * The copy variants, keyed by (channel × state) through tables rather than nested ternaries.
 *
 * ⚠ SAY WHAT ACTUALLY HAPPENS, PER STATE **AND PER CHANNEL**. "Remove" means something materially
 * different for somebody mid-call versus somebody who never joined — and something different again
 * for an EMAIL invitee versus a LOBBY VISITOR, because the server treats them differently: an
 * email row gets a removal email and a `METHOD:CANCEL`; a `link` row gets NEITHER, and never had
 * an "invite" to withdraw in the first place. One sentence for all of them would be dishonest in
 * at least one direction.
 *
 * ⚠ GENDER-NEUTRAL THROUGHOUT — name plus "they/them", never a pronoun guess. ⚠ NO ADVERSARIAL
 * FRAMING ("kick", "boot", "ban") even though `ban: true` is the literal Daily parameter
 * underneath: the reader is a colleague doing an administrative task. ⚠ NOTHING ABOUT THE
 * REMAINING PARTY — per R2 nobody else is told anything and no one else's calendar copy is
 * reissued, so the dialog must not imply otherwise. ⚠ AND NOTHING SOFTENED INTO AMBIGUITY: every
 * variant names the real consequences and says plainly that it cannot be undone.
 */
interface RemovalCopy {
  readonly title: (displayName: string) => string;
  readonly body: (displayName: string) => string;
  readonly confirmLabel: string;
  readonly pendingLabel: string;
  readonly success: (displayName: string) => string;
}

const IN_CALL_COPY: RemovalCopy = {
  title: (name) => `Remove ${name} from this call?`,
  body: (name) =>
    `${name} will be disconnected right away and won't be able to rejoin with this invite. We'll let them know by email, and the event will come off their calendar. This can't be undone.`,
  confirmLabel: 'Remove from call',
  pendingLabel: 'Removing…',
  success: (name) => `${name} has been removed from the call.`,
};

const NOT_JOINED_COPY: RemovalCopy = {
  title: (name) => `Withdraw ${name}'s invite?`,
  body: (name) =>
    `${name} hasn't joined yet, so there's nothing to disconnect — but their invite link will stop working right away. We'll let them know by email, and the event will come off their calendar. This can't be undone.`,
  confirmLabel: 'Withdraw invite',
  pendingLabel: 'Withdrawing…',
  success: (name) => `${name}'s invite has been withdrawn.`,
};

/**
 * ⚠⚠ THE LOBBY-VISITOR VARIANTS, AND WHAT THEY DELIBERATELY DO **NOT** SAY.
 *
 * No "we'll let them know by email" — `removeGuest` sends a `link` row no removal email, because
 * its address was typed by an anonymous visitor and Balo never verified it. No "the event will
 * come off their calendar" — it sends no `METHOD:CANCEL` either, for the same reason. And no
 * "invite": a lobby visitor was never invited, they knocked with a forwarded meeting URL, so
 * "withdraw their invite" would name a thing that never existed.
 *
 * ⚠ WHAT THEY DO SAY IS THE PART THE HOST HAS TO ACT ON: nobody is going to tell this person, so
 * if they should know, the host has to. That is the opposite of softening — it is the fact the
 * email variants make unnecessary and this one makes unavoidable.
 *
 * ⚠ "THAT LINK WON'T LET THEM BACK IN" IS SCOPED ON PURPOSE, exactly as the email variants scope
 * theirs to "with this invite". Removal revokes the credential and bans the Daily participant id,
 * but it also soft-deletes the row — which frees its slot in the live-guest index, so the same
 * person could knock again with a fresh row and a fresh participant id. Claiming they can never
 * return would be the one overclaim in this dialog.
 */
const LINK_IN_CALL_COPY: RemovalCopy = {
  title: (name) => `Remove ${name} from this call?`,
  body: (name) =>
    `${name} joined using the meeting link. They'll be disconnected right away, and that link won't let them back in. We won't email them, so tell them yourself if they should know. This can't be undone.`,
  confirmLabel: 'Remove from call',
  pendingLabel: 'Removing…',
  success: (name) => `${name} has been removed from the call.`,
};

const LINK_NOT_JOINED_COPY: RemovalCopy = {
  title: (name) => `Remove ${name}?`,
  body: (name) =>
    `${name} asked to join using the meeting link and hasn't arrived yet. Removing them means that link won't let them in. We won't email them, so tell them yourself if they should know. This can't be undone.`,
  confirmLabel: 'Remove',
  pendingLabel: 'Removing…',
  success: (name) => `${name} has been removed.`,
};

/** The EMAIL-invitee variants — unchanged, and the server still honours every claim in them. */
export const REMOVAL_COPY: Readonly<Record<MeetingPanelRemovalState, RemovalCopy>> = {
  in_call: IN_CALL_COPY,
  invited: NOT_JOINED_COPY,
  not_arrived: NOT_JOINED_COPY,
};

/**
 * ⚠ `invited` IS UNREACHABLE FOR A LINK ROW TODAY and is present only to keep the `Record` total:
 * `claimLobbyPlace` writes `pending` and `decideAdmission` moves it to `admitted`, so a lobby row
 * is never `pre_admitted`. Totality by type means a future writer cannot land here with no copy.
 */
export const LINK_REMOVAL_COPY: Readonly<Record<MeetingPanelRemovalState, RemovalCopy>> = {
  in_call: LINK_IN_CALL_COPY,
  invited: LINK_NOT_JOINED_COPY,
  not_arrived: LINK_NOT_JOINED_COPY,
};

/** ⚠ THE ONE SELECTOR. Never a second `isUnverified ? … : …` at a render site. */
export function removalCopyFor(pending: PendingGuestRemoval): RemovalCopy {
  return pending.isUnverified ? LINK_REMOVAL_COPY[pending.state] : REMOVAL_COPY[pending.state];
}

export interface UseGuestRemovalInput {
  readonly panels: MeetingMemberPanelRegistration;
  readonly markPending: (guestId: string, pending: boolean) => void;
  readonly refetch: () => Promise<void>;
  /** ⚠ Toast **and** the frame's one live region, in one call. */
  readonly report: (kind: 'success' | 'info' | 'error', message: string) => void;
  /** ⚠ THE EXACT SHAPE — never a `Record`. */
  readonly meetingProps: Readonly<{ meeting_id?: string }>;
}

export interface UseGuestRemovalResult {
  readonly requestRemoval: (pending: PendingGuestRemoval) => void;
  /** Render exactly once per panel — the FOURTH caller of `MeetingConfirmDialog`, never a copy. */
  readonly confirmDialog: React.JSX.Element | null;
}

export function useGuestRemoval(input: UseGuestRemovalInput): UseGuestRemovalResult {
  const { panels, markPending, refetch, report, meetingProps } = input;
  const [pendingRemoval, setPendingRemoval] = useState<PendingGuestRemoval | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);

  const requestRemoval = useCallback((pending: PendingGuestRemoval): void => {
    setPendingRemoval(pending);
  }, []);

  const onOpenChange = useCallback((open: boolean): void => {
    if (!open) setPendingRemoval(null);
  }, []);

  const onConfirm = useCallback((): void => {
    if (pendingRemoval === null) return;
    const { guestId, displayName, state } = pendingRemoval;
    const copy = removalCopyFor(pendingRemoval);

    setIsRemoving(true);
    markPending(guestId, true);
    panels
      .removeGuest(guestId)
      .then(async (result) => {
        track(MEETING_PANEL_EVENTS.GUEST_REMOVED, {
          ...meetingProps,
          state,
          outcome: result.success ? 'ok' : 'failed',
        });
        if (result.success) {
          report('success', copy.success(displayName));
          // ⚠⚠ ONLY A SUCCESS CLOSES THE DIALOG — the `endForEveryone` precedent. A failure keeps
          // the person's place, with the toast on top and the button reset.
          setPendingRemoval(null);
        } else {
          report('error', result.error);
        }
        // ⚠ REFETCH ON BOTH ARMS. After a lost race the local list is stale by definition, which
        // is what converges two removers onto the same roster within one poll cycle.
        await refetch();
      })
      .finally(() => {
        setIsRemoving(false);
        markPending(guestId, false);
      });
  }, [pendingRemoval, panels, markPending, refetch, report, meetingProps]);

  if (pendingRemoval === null) {
    return { requestRemoval, confirmDialog: null };
  }

  const copy = removalCopyFor(pendingRemoval);
  return {
    requestRemoval,
    confirmDialog: (
      <MeetingConfirmDialog
        open
        onOpenChange={onOpenChange}
        title={copy.title(pendingRemoval.displayName)}
        body={copy.body(pendingRemoval.displayName)}
        confirmLabel={copy.confirmLabel}
        pendingLabel={copy.pendingLabel}
        isPending={isRemoving}
        onConfirm={onConfirm}
      />
    ),
  };
}
