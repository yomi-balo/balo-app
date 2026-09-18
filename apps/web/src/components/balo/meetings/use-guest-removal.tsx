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

/** Which copy variant a row's state earns. ⚠ `waiting` is absent — see {@link removalStateFor}. */
export interface PendingGuestRemoval {
  readonly guestId: string;
  readonly displayName: string;
  readonly state: MeetingPanelRemovalState;
}

/**
 * ⚠⚠ `waiting` ⇒ `null`, AND THAT IS A PRODUCT RULE, NOT A GAP. A lobby row offers Deny and only
 * Deny: Deny already produces the identical practical outcome (they never get in) and IS
 * host-gated (`host_meetings`), whereas Remove is gated on same-party membership alone. Offering
 * both would let a non-host achieve through Remove exactly what Deny reserves for hosts.
 */
export function removalStateFor(state: GuestRosterState): MeetingPanelRemovalState | null {
  return state === 'waiting' ? null : state;
}

/**
 * The two copy variants, keyed by state through one table rather than a ternary.
 *
 * ⚠ SAY WHAT ACTUALLY HAPPENS, PER STATE. "Remove" means something materially different for
 * somebody mid-call versus somebody who never joined, and one sentence for both would be
 * dishonest in one direction or the other. Both variants name the three real consequences
 * (disconnect-or-not, the link dies, the calendar entry is withdrawn) rather than hiding behind
 * "this action cannot be undone".
 *
 * ⚠ GENDER-NEUTRAL THROUGHOUT — name plus "they/them", never a pronoun guess. ⚠ NO ADVERSARIAL
 * FRAMING ("kick", "boot", "ban") even though `ban: true` is the literal Daily parameter
 * underneath: the reader is a colleague doing an administrative task. ⚠ NOTHING ABOUT THE
 * REMAINING PARTY — per R2 nobody else is told anything and no one else's calendar copy is
 * reissued, so the dialog must not imply otherwise.
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

export const REMOVAL_COPY: Readonly<Record<MeetingPanelRemovalState, RemovalCopy>> = {
  in_call: IN_CALL_COPY,
  invited: NOT_JOINED_COPY,
  not_arrived: NOT_JOINED_COPY,
};

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
    const copy = REMOVAL_COPY[state];

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

  const copy = REMOVAL_COPY[pendingRemoval.state];
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
