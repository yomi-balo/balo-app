'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSessionId } from '@daily-co/daily-react';
import { toast } from 'sonner';
import { Check, Link2, Mail, ShieldCheck, UserPlus } from 'lucide-react';
import { MAX_LOBBY_QUEUE } from '@balo/shared/meetings';
import { MEETING_PANEL_EVENTS, track } from '@/lib/analytics';
import {
  buildGuestRoster,
  type GuestRoster,
  type GuestRosterRow,
} from '@/lib/meetings/guest-roster';
import { GUEST_ACTION_COPY } from '@/lib/meetings/guests-copy';
import { guestIdFromParticipantClaim } from '@/lib/meetings/present-guest-ids';
import type { MeetingGuestsPayload, MeetingPanelRegistration } from '@/lib/meetings/meeting-panels';
import { MeetingSidePanel } from './meeting-side-panel';
import { PeoplePanelRow, PresentParticipantRow } from './people-panel-row';
import { LobbyQueueRow } from './lobby-queue-row';
import { PanelErrorCard, PanelSkeletonRows } from './panel-states';
import { useGuestRosterPoll } from './use-guest-roster-poll';
import { useDailyIdentities } from './use-daily-identities';

/**
 * BAL-436 — the People panel: who is here, who is expected, and the host's admit/deny queue.
 *
 * ── ⚠⚠ THE QUEUE GATES ON `canHost` FROM THE SERVER, AND ON NOTHING ELSE ────────────────
 *
 * `canHost` is the api's per-actor `hasEngagementCapability(HOST_MEETINGS)` verdict for this
 * exact meeting, computed behind the tenancy gate that must run first, and it arrives on the
 * guests GET payload. **DO NOT re-derive it in this tier** even though a web engagement
 * resolver now exists (`lib/authz/engagement.ts`, opened by BAL-421): a second resolution in
 * the browser would be a second expression of one rule, and it would run WITHOUT
 * `authorizeMeetingParticipation` in front of it. `meeting-call-no-lens-gate.test.ts` fails
 * the build of anyone who tries.
 *
 * The design prototype gates its queue on a VIEW (`balo-in-meeting-ui.jsx:618`). **Take the
 * layout; do not take its gate** — that is the comparison ADR-1029 forbids.
 *
 * ── ⚠⚠ SEATS ARE NOT TILES, AND THIS PANEL SHOWS BOTH WITHOUT CONFLATING THEM ───────────
 *
 * "In the call · {n}" is a TILE count, derived from the live Daily roster. The seat figure —
 * the counter the server refuses invites on — appears in the top-bar chip and in one footer
 * line, and nowhere else. They routinely differ: an invited guest who has not joined holds a
 * seat but has no tile.
 *
 * ⚠⚠ **"ADD PEOPLE" IS NEVER DISABLED ON A FULL ROOM.** `listGuests`' docblock names that
 * exact regression: a client-side `count >= cap` gate reintroduces the invite lockout the
 * counter split exists to close, moved from the server to the client. The server answers
 * `409 participant_cap_reached` and this panel renders the sentence.
 *
 * ⚠ THE FOOTER STAYS USABLE WHILE THE ROSTER READ IS IN ITS ERROR STATE. A failed list read
 * must not remove a host's ability to invite somebody or copy the join link.
 */

/** ⚠ The `email`-channel contrast, at the bottom of the panel exactly as the reference has it. */
const CHANNEL_DISCLOSURE =
  'People you invite by email join straight away. Anyone using the link asks to be let in.';

/**
 * ⚠⚠ THE DISCLOSURE THAT SITS **ABOVE** THE QUEUE, SO IT IS READ BEFORE THE CLICK. A
 * `link`-channel row's name was typed by an anonymous visitor holding a forwarded URL; anyone
 * with the meeting URL can knock as anyone. This sentence plus the per-row badge IS the
 * mitigation — the buttons stay short and unambiguous.
 */
const QUEUE_DISCLOSURE =
  "These people used the meeting link. Balo hasn't checked who they are — admit them only if you're expecting them.";

const COPY_LINK_HELPER = 'Anyone using this link asks to be let in.';

export interface PeoplePanelProps {
  readonly panels: MeetingPanelRegistration;
  readonly onClose: () => void;
  /** Hoisted so the top-bar chip survives the panel closing. ⚠ SEATS, never a local count. */
  readonly onSeatsChange: (seats: { participantCount: number; participantCap: number }) => void;
  /**
   * ⚠ Omitted on both guest mounts — they have no route context and no panel.
   *
   * ⚠⚠ THE **EXACT SHAPE**, NEVER `Record<string, string>`. A `Record` index signature defeats
   * excess-property checking at every `{ ...meetingProps, … }` spread below, which is exactly
   * where the analytics event maps' PII guard is supposed to bite. A guest name or an address
   * added to this object would otherwise compile straight into a PostHog payload.
   */
  readonly meetingProps: Readonly<{ meeting_id?: string }>;
  /**
   * ⚠⚠ §16'S **ONE** POLITE LIVE REGION, OWNED BY THE FRAME. Admit / deny / invite outcomes and
   * a new arrival in the queue are announced through this.
   *
   * ⚠ IT IS NOT A DUPLICATE OF THE TOAST, IT IS THE OTHER HALF OF IT. Sonner is a VISUAL
   * affordance; on this surface it is the only feedback a mutation produces, so without a live
   * region a screen-reader user pressed Admit and heard nothing at all. This is also the region
   * the `aria-busy` ban exists to protect — a ban that, until now, protected nothing, because
   * the region it named did not reach this subtree.
   */
  readonly onAnnounce: (message: string) => void;
}

export function PeoplePanel({
  panels,
  onClose,
  onSeatsChange,
  meetingProps,
  onAnnounce,
}: Readonly<PeoplePanelProps>): React.JSX.Element {
  const localSessionId = useLocalSessionId();
  const { identities, presentGuestIds, probes } = useDailyIdentities();
  const { payload, status, refetch } = useGuestRosterPoll({ panels, onSeatsChange });
  const [pendingGuestIds, setPendingGuestIds] = useState<ReadonlySet<string>>(new Set());

  const roster = useMemo<GuestRoster>(
    () =>
      buildGuestRoster({
        guests: payload?.guests ?? [],
        presentGuestIds,
        canHost: payload?.canHost ?? false,
        nowMs: Date.now(),
      }),
    [payload, presentGuestIds]
  );

  const markPending = useCallback((guestId: string, pending: boolean): void => {
    setPendingGuestIds((current) => {
      const next = new Set(current);
      if (pending) next.add(guestId);
      else next.delete(guestId);
      return next;
    });
  }, []);

  /**
   * ⚠⚠ EVERY OUTCOME IS BOTH TOASTED **AND** ANNOUNCED. Sonner is a visual affordance; on this
   * surface it was the only feedback a mutation produced, so a screen-reader user pressed Admit
   * and heard nothing. `onAnnounce` writes into the frame's ONE §16 polite region.
   *
   * ⚠ THE SAME SENTENCE IN BOTH, DELIBERATELY. Two wordings for one event is how a support
   * conversation ("it said X" / "no, it says Y") becomes unanswerable.
   */
  const report = useCallback(
    (kind: 'success' | 'info' | 'error', message: string): void => {
      toast[kind](message);
      onAnnounce(message);
    },
    [onAnnounce]
  );

  const onDecide = useCallback(
    (guestId: string, decision: 'admit' | 'deny', displayName: string): void => {
      markPending(guestId, true);
      panels
        .decideAdmission(guestId, decision)
        .then(async (result) => {
          if (result.success) {
            track(MEETING_PANEL_EVENTS.GUEST_DECIDED, { ...meetingProps, decision, outcome: 'ok' });
            // ⚠ NAMES THE PERSON. "They're in." is ambiguous the moment two people are waiting,
            // and it is the one line that confirms WHICH row the click landed on — which
            // matters most for the reader who cannot see the row disappear.
            report(
              'success',
              decision === 'admit'
                ? `${displayName} is in.`
                : `${displayName}'s request was declined.`
            );
          } else {
            track(MEETING_PANEL_EVENTS.GUEST_DECIDED, {
              ...meetingProps,
              decision,
              outcome: result.outcome,
            });
            // ⚠⚠ A RACE IS NOT A FAILURE. `already_decided` means the other host's decision
            // stands — the outcome this host wanted has happened either way, so it is an
            // INFORMATIONAL toast, never an error one.
            report(result.outcome === 'already_decided' ? 'info' : 'error', result.error);
          }
          // ⚠ REFETCH ON BOTH ARMS. After a race the local list is stale by definition, and
          // after a success the queue and the seat count have both moved.
          await refetch();
        })
        .finally(() => markPending(guestId, false));
    },
    [panels, markPending, refetch, meetingProps, report]
  );

  const onResend = useCallback(
    (guestId: string, displayName: string): void => {
      markPending(guestId, true);
      panels
        .resendLink(guestId)
        .then(async (result) => {
          track(MEETING_PANEL_EVENTS.LINK_RESENT, {
            ...meetingProps,
            outcome: result.success ? 'ok' : 'failed',
          });
          if (result.success) {
            report('success', `A fresh link is on its way to ${displayName}.`);
          } else {
            report('error', result.error);
          }
          await refetch();
        })
        .finally(() => markPending(guestId, false));
    },
    [panels, markPending, refetch, meetingProps, report]
  );

  useQueueArrivalAnnouncement(roster.waiting, onAnnounce, payload !== null);

  const tileCount = identities.length;

  /**
   * ⚠⚠ **THE `link` ROW KEEPS ITS BADGE AFTER IT WALKS IN.** `roster.inCall` carries the
   * `isUnverified` flag for every guest the live roster matched; this map is what lets the "In
   * the call" list render THAT row rather than a bare participant.
   *
   * An earlier version rendered every live participant as a `PresentParticipantRow` and never
   * read `roster.inCall` at all — so the UNVERIFIED badge disappeared the instant the stranger
   * arrived, i.e. exactly when a host is looking at the list to work out who is in the room.
   * The badge's only input is `inviteChannel === 'link'`, which is independent of presence,
   * of `party` and of `admission`; presence must not be able to clear it.
   */
  const inCallByGuestId = useMemo(() => {
    const byId = new Map<string, GuestRosterRow>();
    for (const row of roster.inCall) byId.set(row.guest.id, row);
    return byId;
  }, [roster.inCall]);

  return (
    <MeetingSidePanel
      title="People"
      count={tileCount}
      onClose={onClose}
      footer={
        <PeoplePanelFooter
          panels={panels}
          meetingProps={meetingProps}
          onInvited={refetch}
          seats={payload}
          report={report}
        />
      }
    >
      {probes}
      <div className="p-3">
        {status === 'loading' ? <PanelSkeletonRows /> : null}

        {status === 'error' ? (
          <PanelErrorCard
            title="We couldn't load who's here"
            body="The call itself is fine. You can still invite people or copy the join link below."
            onRetry={() => {
              void refetch();
            }}
          />
        ) : null}

        <PanelSection label={`In the call · ${tileCount}`}>
          {identities.map((identity) => {
            // ⚠ FAIL-CLOSED: `null` for anything this platform did not mint, and `null` for a
            // member's `'u'`-tagged id. An unmatched participant renders from Daily's own
            // `user_name` claim with NO roster linkage and NO row action.
            const guestId = guestIdFromParticipantClaim(identity.userId);
            const row = guestId === null ? undefined : inCallByGuestId.get(guestId);
            if (row !== undefined) {
              // ⚠⚠ THE ROSTER ROW, WHICH CARRIES `isUnverified`. Never a bare participant row:
              // that is what made the badge vanish on arrival.
              return <PeoplePanelRow key={identity.sessionId} row={row} />;
            }
            return (
              <PresentParticipantRow
                key={identity.sessionId}
                displayName={identity.userName ?? 'Guest'}
                isSelf={identity.sessionId === localSessionId}
              />
            );
          })}
        </PanelSection>

        {roster.waiting.length > 0 ? (
          <PanelSection
            label={`Waiting to join · ${roster.waiting.length}`}
            // ⚠⚠ PROSE ABOVE THE `<ul>`, NEVER INSIDE IT. A `<li>` holding a sentence makes AT
            // announce "list, 3 items" for two guests, so the count a screen-reader user hears
            // is wrong by however many explanatory lines the section carries.
            note={
              <>
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{QUEUE_DISCLOSURE}</span>
              </>
            }
            footNote={
              roster.waiting.length >= MAX_LOBBY_QUEUE ? (
                <span className="text-warning">{GUEST_ACTION_COPY.lobby_queue_full}</span>
              ) : undefined
            }
          >
            {roster.waiting.map((row) => (
              <LobbyQueueRow
                key={row.guest.id}
                row={row}
                onDecide={onDecide}
                isPending={pendingGuestIds.has(row.guest.id)}
              />
            ))}
          </PanelSection>
        ) : null}

        {roster.invited.length > 0 ? (
          <PanelSection label={`Invited · ${roster.invited.length}`}>
            {roster.invited.map((row) => (
              <PeoplePanelRow key={row.guest.id} row={row} />
            ))}
          </PanelSection>
        ) : null}

        {roster.notArrived.length > 0 ? (
          <PanelSection
            label={`Admitted · not yet arrived · ${roster.notArrived.length}`}
            footNote="Re-sending gives them a new link. This replaces the link they had."
          >
            {roster.notArrived.map((row) => (
              <PeoplePanelRow
                key={row.guest.id}
                row={row}
                isPending={pendingGuestIds.has(row.guest.id)}
                action={
                  row.canResendLink ? (
                    <ResendLinkButton
                      displayName={row.guest.displayName}
                      onClick={() => onResend(row.guest.id, row.guest.displayName)}
                    />
                  ) : undefined
                }
              />
            ))}
          </PanelSection>
        ) : null}

        <p className="text-muted-foreground mt-4 flex items-start gap-2 px-2 text-xs leading-relaxed">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{CHANNEL_DISCLOSURE}</span>
        </p>
      </div>
    </MeetingSidePanel>
  );
}

/**
 * Announce somebody NEW arriving in the admit/deny queue.
 *
 * ── ⚠⚠ THIS IS THE ONE ANNOUNCEMENT NOTHING ELSE PRODUCES ───────────────────────────────
 *
 * Every other message on this panel follows a click the person made, so they know something
 * happened. A knock is the opposite: it arrives on a POLL, up to 10 seconds after the fact,
 * with no visual motion beyond a row appearing in a list that may be scrolled out of view. A
 * sighted host glances at the panel; a screen-reader user gets nothing at all unless it is
 * announced.
 *
 * ⚠ IT FIRES ON **NEW IDS**, NOT ON A LENGTH CHANGE. A length comparison misses the case where
 * one person is admitted and another knocks between two ticks (net zero), and it fires
 * spuriously when the queue merely re-orders.
 *
 * ⚠ IT IS SILENT ON THE FIRST TICK. Opening the panel onto an existing queue is not an
 * arrival, and announcing "three people are waiting" over the panel's own opening focus
 * announcement is two things talking at once.
 *
 * ⚠ IT NAMES THE PERSON ONLY WHEN EXACTLY ONE ARRIVED. Reading four self-declared names in a
 * row is worse than a count, and a burst is usually the case where the count is the point.
 */
function useQueueArrivalAnnouncement(
  waiting: readonly GuestRosterRow[],
  onAnnounce: (message: string) => void,
  hasLoaded: boolean
): void {
  const seenRef = useRef<ReadonlySet<string> | null>(null);

  useEffect(() => {
    // ⚠⚠ NOTHING IS SEEDED UNTIL THE FIRST READ RESOLVES. Before it does, `waiting` is `[]`
    // simply because there is no payload yet — seeding from that empty list would make the
    // first successful response look like everybody arriving at once, announcing the existing
    // queue over the panel's own opening focus.
    if (!hasLoaded) return;

    const currentIds = new Set(waiting.map((row) => row.guest.id));
    const seen = seenRef.current;
    seenRef.current = currentIds;
    if (seen === null) return;

    const arrived = waiting.filter((row) => !seen.has(row.guest.id));
    const [first] = arrived;
    if (first === undefined) return;

    onAnnounce(
      arrived.length === 1
        ? `${first.guest.displayName} is waiting to join.`
        : `${arrived.length} more people are waiting to join.`
    );
  }, [waiting, onAnnounce, hasLoaded]);
}

/**
 * One labelled group. ⚠ A `<ul>` so a screen reader is told how many rows are in it.
 *
 * ⚠⚠ **PROSE GOES IN `note` / `footNote`, NEVER IN `children`.** Anything inside the `<ul>` has
 * to be an `<li>`, and an `<li>` holding a sentence is COUNTED: a queue with two guests and one
 * disclosure line announces "list, 3 items". The count is the one thing the list role exists to
 * convey, so a decorative row silently corrupts it. These two slots sit outside the `<ul>`
 * precisely so the section can explain itself without lying about its size.
 */
function PanelSection({
  label,
  children,
  note,
  footNote,
}: Readonly<{
  label: string;
  children: React.ReactNode;
  /** Rendered ABOVE the list — the disclosure a host must read before acting. */
  note?: React.ReactNode;
  /** Rendered BELOW the list — a consequence note or a queue-full warning. */
  footNote?: React.ReactNode;
}>): React.JSX.Element {
  return (
    <section className="mb-1">
      <h3 className="text-muted-foreground px-2 pt-3 pb-1 text-xs font-medium tracking-wide uppercase">
        {label}
      </h3>
      {note === undefined ? null : (
        <p className="text-muted-foreground flex items-start gap-2 px-2 pb-2 text-xs leading-relaxed">
          {note}
        </p>
      )}
      <ul className="list-none">{children}</ul>
      {footNote === undefined ? null : (
        <p className="text-muted-foreground px-2 pt-1 text-xs leading-relaxed">{footNote}</p>
      )}
    </section>
  );
}

function ResendLinkButton({
  displayName,
  onClick,
}: Readonly<{ displayName: string; onClick: () => void }>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      // ⚠ THE ACCESSIBLE NAME CARRIES THE PERSON; the visible label stays short for a 360px
      // panel. Same split as the queue's Admit / Deny pair.
      aria-label={`Re-send the join link to ${displayName}`}
      className="text-primary hover:bg-primary/10 focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center rounded-lg px-2.5 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
    >
      Re-send link
    </button>
  );
}

/**
 * "Add people" plus "Copy join link".
 *
 * ⚠ EXTRACTED SO `PeoplePanel`'s OWN BODY STAYS UNDER SonarCloud's COGNITIVE-COMPLEXITY LIMIT
 * of 15 — the repo's precedent is to extract, never to disable the rule (`FrameStage` was
 * split out of `MeetingFrameInner` for exactly this).
 */
function PeoplePanelFooter({
  panels,
  meetingProps,
  onInvited,
  seats,
  report,
}: Readonly<{
  panels: MeetingPanelRegistration;
  /** ⚠ THE EXACT SHAPE — see `PeoplePanelProps.meetingProps` for why never a `Record`. */
  meetingProps: Readonly<{ meeting_id?: string }>;
  onInvited: () => Promise<void>;
  seats: MeetingGuestsPayload | null;
  /** ⚠ Toast **and** the frame's one §16 live region, in one call. */
  report: (kind: 'success' | 'info' | 'error', message: string) => void;
}>): React.JSX.Element {
  const [isAdding, setIsAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * ⚠ FOCUS RETURNS TO "ADD PEOPLE" ON CANCEL. Collapsing the composer unmounts the element
   * focus is sitting on, and a keyboard user is then dropped back to `<body>` — at the top of
   * a live call, with the whole panel to tab through again. The same rule the panel shell
   * follows for its own opener.
   */
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const closeComposer = useCallback((): void => {
    setIsAdding(false);
    setEmail('');
    // ⚠ IN A MICROTASK, NOT INLINE: the button does not exist until React commits the collapse.
    globalThis.queueMicrotask(() => addButtonRef.current?.focus());
  }, []);

  const submit = useCallback((): void => {
    const trimmed = email.trim();
    if (trimmed.length === 0 || isSending) return;
    setIsSending(true);
    panels
      .inviteGuests([trimmed])
      .then((result) => {
        if (result.success) {
          track(MEETING_PANEL_EVENTS.GUESTS_INVITED, {
            ...meetingProps,
            outcome: 'ok',
            guest_count: result.invitedCount,
          });
          report('success', `Invite sent to ${trimmed}.`);
          closeComposer();
          return onInvited();
        }
        track(MEETING_PANEL_EVENTS.GUESTS_INVITED, {
          ...meetingProps,
          outcome: result.outcome,
          guest_count: 1,
        });
        // ⚠⚠ "They're already on the list." IS A DEAD END ON ITS OWN — it is the answer a host
        // gets when somebody says "I never received the invite", and it names no next step. The
        // panel's own re-send affordance is server-restricted to `link`+`admitted` rows, so it
        // can never appear beside an email invitee. Until BAL-442 opens a guest-side path, the
        // honest instruction is the one a host can actually carry out.
        report(
          'error',
          result.outcome === 'already_invited'
            ? `${result.error} If they never got it, forward them the join link below — they'll ask to be let in.`
            : result.error
        );
        return undefined;
      })
      .finally(() => setIsSending(false));
  }, [email, isSending, panels, meetingProps, onInvited, report, closeComposer]);

  const onCopy = useCallback((): void => {
    track(MEETING_PANEL_EVENTS.JOIN_LINK_COPIED, { ...meetingProps });
    // ⚠ THE URL IS BARE AND TOKENLESS — built server-side from APP_URL. The raw guest token
    // never comes back from the api and this UI never builds a link.
    const write = globalThis.navigator?.clipboard?.writeText(panels.joinLinkUrl);
    if (write === undefined) {
      report('error', "We couldn't copy the link. You can select it from the address bar instead.");
      return;
    }
    write
      .then(() => {
        setCopied(true);
        if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => setCopied(false), 1600);
        report('success', 'Join link copied.');
      })
      .catch(() => {
        report('error', "We couldn't copy the link. Try again in a moment.");
      });
  }, [panels.joinLinkUrl, meetingProps, report]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'Enter') submit();
    },
    [submit]
  );

  return (
    <div className="flex flex-col gap-2">
      {isAdding ? (
        <div className="bg-muted/40 border-border flex flex-col gap-2 rounded-xl border p-2.5">
          <div className="flex items-center gap-2">
            <Mail className="text-muted-foreground h-[15px] w-[15px] shrink-0" aria-hidden="true" />
            {/* ⚠ A REAL `<label>` BOUND BY `htmlFor` — visually hidden, not absent. */}
            <label htmlFor="meeting-invite-email" className="sr-only">
              Email address to invite
            </label>
            <input
              id="meeting-invite-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Enter an email address"
              /*
                ⚠ AUTOFOCUS IS CORRECT HERE AND NOWHERE NEARBY. It is not a page-load autofocus
                (the usual reason the attribute is a smell) — the field only exists because the
                person just pressed "Add people", so focus is following an explicit intent. The
                alternative is a keyboard user pressing a button and then hunting for the field
                it revealed, mid-call. Focus is returned to "Add people" on cancel; see
                `closeComposer`.

                ⚠ NO `eslint-disable` HERE: `jsx-a11y/no-autofocus` is NOT configured in this
                repo, and a disable comment for an unknown rule is itself a warning under
                `--max-warnings 0`.
              */
              autoFocus
              className="text-foreground placeholder:text-muted-foreground min-h-11 flex-1 bg-transparent text-sm outline-none"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={closeComposer}
              className="text-muted-foreground hover:bg-muted focus-visible:ring-ring min-h-11 flex-1 rounded-lg text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              className="bg-primary text-primary-foreground focus-visible:ring-ring min-h-11 flex-1 rounded-lg text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:opacity-70"
              disabled={isSending || email.trim().length === 0}
            >
              {isSending ? 'Sending…' : 'Send invite'}
            </button>
          </div>
        </div>
      ) : (
        <button
          ref={addButtonRef}
          type="button"
          onClick={() => setIsAdding(true)}
          className="bg-primary text-primary-foreground focus-visible:ring-ring flex min-h-11 w-full items-center justify-center gap-2 rounded-xl text-sm font-medium transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none"
        >
          <UserPlus className="h-4 w-4" aria-hidden="true" />
          Add people
        </button>
      )}

      <button
        type="button"
        onClick={onCopy}
        className="border-border text-foreground hover:bg-muted/60 focus-visible:ring-ring flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        {copied ? (
          <Check className="text-success h-4 w-4" aria-hidden="true" />
        ) : (
          <Link2 className="h-4 w-4" aria-hidden="true" />
        )}
        {copied ? 'Link copied' : 'Copy join link'}
      </button>
      <p className="text-muted-foreground px-1 text-xs leading-relaxed">{COPY_LINK_HELPER}</p>
      {/*
        ⚠⚠ THE SEAT LINE, AND THE **ONLY** PLACE IN THE PANEL BODY A SEAT NUMBER APPEARS. It is
        the server's counter — the one it refuses invites on — and it deliberately differs from
        the "In the call" tile count above. Absent rather than zero when unknown.
      */}
      {seats === null ? null : (
        <p className="text-muted-foreground px-1 text-xs tabular-nums">
          {seats.participantCount} of {seats.participantCap} seats taken
        </p>
      )}
    </div>
  );
}
