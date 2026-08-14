'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParticipantIds, useParticipantProperty } from '@daily-co/daily-react';
import { presentGuestIdsFrom } from '@/lib/meetings/present-guest-ids';

/**
 * BAL-436 — **WHO IS IN THE ROOM RIGHT NOW**, read off the LIVE Daily roster and decoded
 * through the Decision-1 `user_id` encoding.
 *
 * ── ⚠⚠ WHY THE LIVE ROSTER AND NOT `meeting_presence` ────────────────────────────────────
 *
 * `meeting_presence` is a durable BILLING / OBSERVATION record with zero production writers
 * today, written by a server-side webhook with unavoidable lag. The panel's question is "is
 * this person in the room RIGHT NOW", which is the call object's own state — no lag, no round
 * trip. Using a billing table to answer a liveness question would be the wrong coupling even
 * after BAL-134 lands. See `present-guest-ids.ts` for the full argument and the hand-off.
 *
 * ── ⚠⚠ WHY THIS NEEDS PROBE COMPONENTS AT ALL ────────────────────────────────────────────
 *
 * `useParticipantProperty` is a HOOK taking ONE session id, so it cannot be called in a loop
 * over a list whose length changes. The repo already solved the RENDERING half of this
 * (`OverflowAvatar` is its own component so each avatar can subscribe for itself); this solves
 * the LIFTING half, which the panels need because roster classification (`in_call` vs
 * `not_arrived`) depends on the WHOLE set rather than on one row.
 *
 * Each probe renders `null` and reports its own participant's claims upward. The reducer
 * writes only when a value actually CHANGED, so the pair converges on the first frame after a
 * join or a leave and is idle thereafter — that guard is what stops it spinning.
 *
 * ── ⚠⚠ FAIL-CLOSED, AND THE CONSEQUENCE RUNS THE SAFE WAY ────────────────────────────────
 *
 * `presentGuestIdsFrom` drops anything this platform did not mint — a bare uuid, uppercase
 * hex, a vendor id, an anonymous participant. So an unrecognised person is rendered from their
 * Daily `user_name` with NO roster linkage and NO row action, rather than being matched to the
 * wrong `meeting_guests` row. It is impossible for this to report somebody as present who is
 * not.
 *
 * ⚠ THE LOCAL PARTICIPANT IS INCLUDED — which is why the People panel is never wholly empty.
 */

/** What one live participant tells us about themselves, as Daily reports it. */
export interface DailyIdentity {
  readonly sessionId: string;
  /** The SERVER-MINTED `user_id` claim, or `null` when Daily has not reported one yet. */
  readonly userId: string | null;
  /**
   * The SERVER-MINTED `user_name` claim.
   *
   * ⚠ NOT A CLIENT-SUPPLIED NAME. `meeting-frame-impl.tsx` sends no `userName` on join
   * precisely so the token's claim stays authoritative — a client-supplied name on a private
   * room is the impersonation surface PreJoin refuses.
   */
  readonly userName: string | null;
}

interface IdentityRecord {
  readonly userId: string | null;
  readonly userName: string | null;
}

export interface DailyIdentities {
  /** In `joined_at` order, exactly as Daily sorts it. */
  readonly identities: readonly DailyIdentity[];
  /** `meeting_guests.id` values decoded out of the live roster. ⚠ Fail-closed by construction. */
  readonly presentGuestIds: ReadonlySet<string>;
  /** ⚠ RENDER THIS. Each child is a `null`-rendering subscription for one participant. */
  readonly probes: React.JSX.Element;
}

export function useDailyIdentities(): DailyIdentities {
  // ⚠ SORTED BY `joined_at` BY DAILY ITSELF — the same call the stage makes, so the panel's
  // order and the tile order cannot disagree.
  const sessionIds = useParticipantIds({ sort: 'joined_at' });
  const [claims, setClaims] = useState<Record<string, IdentityRecord>>({});

  const onResolve = useCallback((sessionId: string, next: IdentityRecord): void => {
    setClaims((current) => {
      const previous = current[sessionId];
      if (previous !== undefined && previous.userId === next.userId) {
        if (previous.userName === next.userName) {
          // ⚠ THE CONVERGENCE GUARD. Without it every probe's effect would write a fresh
          // object identity on every render and the pair would spin.
          return current;
        }
      }
      return { ...current, [sessionId]: next };
    });
  }, []);

  const identities = useMemo<DailyIdentity[]>(
    () =>
      sessionIds.map((sessionId) => ({
        sessionId,
        userId: claims[sessionId]?.userId ?? null,
        userName: claims[sessionId]?.userName ?? null,
      })),
    [sessionIds, claims]
  );

  const presentGuestIds = useMemo(
    () =>
      presentGuestIdsFrom(
        identities.flatMap((identity) => (identity.userId === null ? [] : [identity.userId]))
      ),
    [identities]
  );

  const probes = useMemo(
    () => (
      <>
        {/* ⚠ KEYED BY SESSION ID, never by array index (SonarCloud S6479). */}
        {sessionIds.map((sessionId) => (
          <ParticipantIdentityProbe key={sessionId} sessionId={sessionId} onResolve={onResolve} />
        ))}
      </>
    ),
    [sessionIds, onResolve]
  );

  return { identities, presentGuestIds, probes };
}

/**
 * One participant's subscription. Renders NOTHING.
 *
 * ⚠ TWO SINGLE-PATH SUBSCRIPTIONS, not one array call — the array overload's return type is a
 * mapped tuple that widens to `unknown` under this repo's inference settings, and `unknown`
 * here would mean casting, which CLAUDE.md forbids and which would hide a real shape change.
 * `participant-tile.tsx` states the same reason for the same choice.
 *
 * ⚠ IT REPORTS IN AN EFFECT, NOT DURING RENDER. Calling a parent's setter during render is a
 * React warning and, under StrictMode's double invocation, a double write.
 */
function ParticipantIdentityProbe({
  sessionId,
  onResolve,
}: Readonly<{
  sessionId: string;
  onResolve: (sessionId: string, record: IdentityRecord) => void;
}>): null {
  const userId = useParticipantProperty(sessionId, 'user_id');
  const userName = useParticipantProperty(sessionId, 'user_name');

  const resolvedUserId = typeof userId === 'string' && userId.length > 0 ? userId : null;
  const resolvedUserName = typeof userName === 'string' && userName.length > 0 ? userName : null;

  useEffect(() => {
    onResolve(sessionId, { userId: resolvedUserId, userName: resolvedUserName });
  }, [sessionId, resolvedUserId, resolvedUserName, onResolve]);

  return null;
}
