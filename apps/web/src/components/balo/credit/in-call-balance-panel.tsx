'use client';

import { useEffect, useRef } from 'react';
import type { DrawdownState } from '@balo/shared/credit';
import { track, SESSION_EVENTS } from '@/lib/analytics';
import { MeetingSidePanel } from '@/components/balo/meetings/meeting-side-panel';
import { PanelErrorCard, PanelRetryButton } from '@/components/balo/meetings/panel-states';
import type { DrawdownPollStatus } from '@/lib/meetings/use-drawdown-poll';
import { InSessionPanel } from './in-session-panel';

/**
 * BAL-403 — the fourth in-call side-panel slot: `'balance'`. Wraps the shared
 * `MeetingSidePanel` shell around `InSessionPanel variant="embedded"` — BAL-378's component,
 * unmodified in its rendering logic, only additively parameterised.
 *
 * ── ⚠⚠ THIS IS THE ONE FILE IN THE FEATURE THAT READS `DrawdownState['lens']` ────────────────
 *
 * `meeting-call-no-lens-gate.test.ts` bans the substring `lens` in every file under
 * `components/balo/meetings`, `app/(call)/**` and the allow-listed slice of `lib/meetings` —
 * because on THIS surface a lens has never been a legitimate input, view or otherwise. It is
 * legitimate here: `state.lens` is presentational copy selection ("your team's balance" vs
 * "your balance"), already resolved server-side by `get-drawdown-state.ts`'s membership gate
 * plus capability branch. The client renders the server's verdict and nothing else — this file
 * adds no `hasCapability` / `roleHasCapability` / `hasEngagementCapability` / `activeMode` read
 * anywhere. That is why this component lives beside `in-session-panel.tsx`, in
 * `components/balo/credit/`, OUTSIDE every scanned tree, rather than in `components/balo/
 * meetings/` where the rest of the call surface lives — the same resolution BAL-437 reached for
 * `chat-panel-list.tsx` (see its docblock): avoid the token, never exempt a file.
 *
 * ── ⚠⚠ THE CONDITIONAL FUNDING NOTICE SCOPES — DOES NOT REVERSE — THE PROTOTYPE'S DECISION ───
 *
 * `balo-in-meeting-ui.jsx`'s "Baked-in decisions / drift fixes" section states, verbatim:
 * "Elapsed-time only in-call (no live cost meter)." Reviewed and approved to proceed
 * (Yomi, 2026-08-16): a `healthy` session adds NOTHING to the chrome — no slot button beyond an
 * inert one, no badge, no auto-open, no countdown — so for the entire healthy duration of every
 * call this surface stays byte-for-byte what the prototype specifies. What is genuinely new is
 * a state-driven notice that appears ONLY when the member must act to keep the call funded, via
 * the auto-open ladder in `drawdown-auto-open.ts`: healthy is silent, and the panel never shows
 * a cost — `SessionMeter` renders runway or fill-toward-ceiling, never a charge, and the money
 * fields (`expertRate*`, `baloFeeBps`, `expertAccruedMinor`, `stripePaymentIntentId`) are
 * structurally absent from the payload (`findForClientView`).
 *
 * ⚠⚠ G4 (second review round) — CORRECTING A NOW-FALSE CLAIM. This used to say "SHIPS INERT.
 * `panels.balance` is `null` for every meeting today (nothing opens a credit session)… this
 * component simply never mounts until that changes." BAL-466 is that change: `panels.balance`
 * is non-null, and this component DOES mount, for a `case` consultation once its client has
 * been admitted — see `meeting-panels.ts`'s `MeetingPanelId` docblock. `null` (no mount) remains
 * correct for every non-`case` meeting and for a Case with no admitted client.
 *
 * ── ⚠⚠ FIX ROUND 1 (C2) — THE ERROR CARD'S RECOVERY INSTRUCTION IS NOW TRUE ────────────────────
 *
 * The card used to say "close this and reopen it to try again" — but reopening retries nothing:
 * `stoppedRef` / the failure counter live in `useDrawdownPoll`, owned by `MeetingFrameInner` for
 * the whole call, and are only cleared by the `[enabled]` mount effect, which never re-fires
 * mid-call. `onRetry` (threaded from `useDrawdownPoll`'s `retry()`) makes the instruction
 * literally true instead: the shared `PanelErrorCard` renders a real "Try again" button that
 * re-arms the poll and fetches immediately — the first polled panel source able to offer one.
 *
 * ── ⚠⚠ FIX ROUND 1 (W5) — `autoOpened` WITHHOLDS FOCUS AND FALLS BACK TO THE LIVE REGION ───────
 *
 * Forwarded verbatim to `MeetingSidePanel`. The ladder that can open this panel is a background
 * poll, not a click, so the frame itself is what announces the auto-open through its own polite
 * live region — see `meeting-frame-impl.tsx`'s `useDrawdownBalanceSlot`.
 *
 * ── ⚠⚠ FIX ROUND 2 (R2) — A FOURTH ARM: `state === null && status === 'ready'` IS NOT LOADING ──
 *
 * Round 1's `isLoading = state === null && status !== 'error'` routed EVERY denial (via
 * `use-drawdown-poll.ts`'s W1 arm, which sets `state: null; status: 'ready'` and stops) into the
 * skeleton — permanently, since the poll has already stopped and no further answer is coming. A
 * screen-reader user got a landmark named "Balance" with empty `textContent`, forever. The same
 * shape is reachable with no gate disagreement at all: the session is cancelled or soft-deleted
 * between the RSC's read and the first poll. The skeleton now gates on `status === 'loading'`
 * ONLY, and `state === null && status === 'ready'` renders an explicit terminal card with no
 * retry control — the poll correctly stopped, and there is nothing more to fetch.
 *
 * ── ⚠⚠ FIX ROUND 2 (R4) — THE DEGRADED FOOTNOTE NOW OFFERS THE SAME RECOVERY C2 SHIPPED ────────
 *
 * The failure-CAP arm (`use-drawdown-poll.ts`'s `DRAWDOWN_MAX_CONSECUTIVE_POLL_FAILURES`) keeps
 * `state` and renders this footnote — `PanelErrorCard` never mounts here, because it requires
 * `state === null`. That left the cap arm with no way back, verbatim the defect C2 shipped a fix
 * for elsewhere: `retry()` already re-arms and re-fetches correctly (proved in
 * `use-drawdown-poll.test.ts`), it was simply unreachable from THIS arm. The footnote now carries
 * its own `PanelRetryButton` wired to the same `onRetry`.
 */

export interface InCallBalancePanelProps {
  /** ⚠ `null` ⇒ loading (no successful poll yet) or the poll degraded with nothing to show. */
  readonly state: DrawdownState | null;
  /** Travels with `state`; `null` whenever `state` is. */
  readonly sessionId: string | null;
  readonly status: DrawdownPollStatus;
  readonly onClose: () => void;
  /** BAL-403 fix round 1 (C2) — `useDrawdownPoll`'s `retry()`, wired to the error card. */
  readonly onRetry: () => void;
  /** BAL-403 fix round 1 (W5) — `true` ⇒ the ladder opened this mount, not a click. */
  readonly autoOpened: boolean;
}

export function InCallBalancePanel({
  state,
  sessionId,
  status,
  onClose,
  onRetry,
  autoOpened,
}: Readonly<InCallBalancePanelProps>): React.JSX.Element {
  /**
   * `in_session_panel_viewed` — an IMPRESSION, fired once per DRAWER MOUNT (the panel unmounts
   * on close, so this is correctly per-open — unlike `InSessionPanel`'s own two lifecycle
   * events, which this drawer suppresses in the embedded variant precisely because THIS is their
   * in-call replacement). ⚠ Guarded so it fires only once real data exists — the loading flash
   * before the first poll lands is not an impression of anything.
   */
  const viewedTrackedRef = useRef(false);
  useEffect(() => {
    if (viewedTrackedRef.current || state === null || sessionId === null) return;
    viewedTrackedRef.current = true;
    track(SESSION_EVENTS.IN_SESSION_PANEL_VIEWED, {
      session_id: sessionId,
      lens: state.lens,
      state: state.key,
    });
  }, [state, sessionId]);

  // ⚠⚠ R2 — `status === 'loading'`, NOT `!== 'error'`. The old condition swallowed the
  // `state === null && status === 'ready'` shape (a denial, or a vanished session) into the
  // skeleton forever — see the module docblock.
  const isLoading = state === null && status === 'loading';
  const hasFailed = state === null && status === 'error';
  // ⚠⚠ R2 — the FOURTH arm: the poll got a real answer, it was "nothing to show", and it has
  // already stopped. Not loading, not an error — there is nothing more coming.
  const isVanished = state === null && status === 'ready';

  return (
    <MeetingSidePanel title="Balance" onClose={onClose} autoOpened={autoOpened}>
      <div className="p-3">
        {isLoading ? <BalancePanelSkeleton /> : null}

        {hasFailed ? (
          <PanelErrorCard
            title="We couldn't check your balance"
            body="The call itself is fine — try again to check it now."
            onRetry={onRetry}
          />
        ) : null}

        {isVanished ? <BalanceUnavailableCard /> : null}

        {state !== null && sessionId !== null ? (
          <>
            <InSessionPanel variant="embedded" state={state} sessionId={sessionId} />
            {status === 'error' ? (
              <div className="mt-3 flex flex-col items-start gap-2 px-0.5">
                <p className="text-muted-foreground text-xs leading-relaxed">
                  We&apos;re having trouble refreshing this — showing the last balance we had.
                </p>
                {/* ⚠⚠ R4 — the cap arm's recovery affordance. See the module docblock. */}
                <PanelRetryButton onRetry={onRetry} />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </MeetingSidePanel>
  );
}

/**
 * BAL-403 fix round 2 (R2) — the `state === null && status === 'ready'` terminal card. Never a
 * retry: the poll already stopped correctly (a success, not a failure), and there is nothing
 * more to fetch.
 */
function BalanceUnavailableCard(): React.JSX.Element {
  return (
    <div
      className="border-border bg-muted/30 m-2 flex flex-col gap-2 rounded-xl border p-3"
      data-testid="balance-panel-unavailable"
    >
      <p className="text-foreground text-sm font-medium">
        This call isn&apos;t drawing from a balance
      </p>
      <p className="text-muted-foreground text-xs leading-relaxed">
        There&apos;s nothing more to check here right now.
      </p>
    </div>
  );
}

/** Decoration only — hidden from assistive tech, matching `PanelSkeletonRows`' posture. */
function BalancePanelSkeleton(): React.JSX.Element {
  return (
    <div
      className="flex flex-col gap-3 rounded-2xl bg-slate-900 p-4"
      aria-hidden="true"
      data-testid="balance-panel-skeleton"
    >
      <div className="h-3 w-2/5 animate-pulse rounded bg-white/15 motion-reduce:animate-none" />
      <div className="h-1.5 w-full animate-pulse rounded-full bg-white/10 motion-reduce:animate-none" />
    </div>
  );
}
