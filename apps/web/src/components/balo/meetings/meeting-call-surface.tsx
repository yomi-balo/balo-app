'use client';

import { useEffect, useMemo } from 'react';
import { MEETING_CALL_EVENTS, track } from '@/lib/analytics';
import { validateGrant } from '@/lib/meetings/validate-grant';
import { JoinUnavailableNotice } from './join-notice-card';
import { MeetingFrame } from './meeting-frame';

/**
 * BAL-132 (Decision 12 / Addendum A2) → **BAL-435 — THE SEAM IS NOW THE CALL.**
 *
 * BAL-132 shipped a CREDENTIAL and this component was where that line was drawn. BAL-435 mounts
 * the real Daily Call-Object surface behind it. **The signature did not change and neither did
 * any of the three call sites** — the remaining prop names were simply added to the existing
 * destructure, exactly as that ticket's docblock said they would be.
 *
 * ── ⚠⚠ THE GRANT GATE RUNS **FIRST**, BEFORE THE VENDOR SDK EXISTS ──────────────────────────
 *
 * `validateGrant` runs here, at the seam, before the dynamic import resolves and before
 * `DailyProvider` mounts. That placement is deliberate and non-negotiable:
 *
 *   · All three mounts get it from ONE place, and TWO of them are ANONYMOUS PUBLIC ROUTES.
 *   · `join-api-client.ts` returns `parsed as T` — an unchecked cast — UPSTREAM of all three.
 *     This is the one point DOWNSTREAM of all three.
 *   · A per-call-site check is three chances to forget, on the surface where forgetting hands an
 *     unvalidated URL to a vendor SDK.
 *
 * ── ⚠ WHAT BAL-435 KEPT FROM THE ORIGINAL CONTRACT ──────────────────────────────────────────
 *
 *   · `token` IS A LIVE CREDENTIAL to a `privacy: 'private'` room. It is never logged, never an
 *     analytics property, never rendered, never in a URL. It reaches `daily.join()` and nothing
 *     else.
 *   · `isOwner` IS ALREADY DECIDED, SERVER-SIDE, per actor, from
 *     `hasEngagementCapability(HOST_MEETINGS)`. Host controls gate on THIS BOOLEAN — never on
 *     `activeMode`, a lens, or a role string (ADR-1029). `leave-control.tsx` is where that lands
 *     and `meeting-call-no-lens-gate.test.ts` is what holds it.
 *   · `participantId` IS THE DECISION-1 ENCODING (`u`/`g` + 32 hex). Passed to Daily verbatim.
 *   · `expiresAt` IS SCHEDULED END + 24h and `eject_at_token_exp` is FALSE — so expiry does NOT
 *     eject anyone. It is parsed for VALIDITY and then IGNORED. **There is no countdown.**
 *   · `headingRef` IS THE FOCUS TARGET, attached to the primary heading of EVERY state.
 *
 * ⚠⚠ THIS FILE IMPORTS **NOTHING** FROM `@daily-co`, VALUE OR TYPE. Two of the three mounts are
 * on the public `/join/*` routes; a static vendor import here would drag the whole Daily bundle
 * into the initial chunk of an emailed link opened on a phone. The boundary is
 * `meeting-frame-impl.tsx`, and an invariant test pins it.
 */
export interface MeetingCallSurfaceProps {
  /** The Daily room URL. ⚠ Admits nobody on its own — the room is private. */
  readonly roomUrl: string;
  /** ⚠ THE DAILY JWT. Never log, persist, or render this. */
  readonly token: string;
  /** The server's `host_meetings` verdict. ⚠ Gate host controls on THIS, never on a lens. */
  readonly isOwner: boolean;
  /** ISO 8601 — scheduled end + 24h. ⚠ Expiry does NOT eject; see the docblock. */
  readonly expiresAt: string;
  /** The Decision-1 encoding: `u`/`g` + 32 hex. Never a bare uuid. */
  readonly participantId: string;
  /**
   * ⚠⚠ THE FOCUS TARGET FOR THE **ADMITTED** TRANSITION — the one that matters most, and the
   * one that moved focus NOWHERE until this prop existed.
   *
   * Both join surfaces replace the entire card on every state change, which drops focus to
   * `<body>`: a keyboard or screen-reader user is silently returned to the top of the document
   * with no signal that anything happened. BAL-435 attaches it to whatever the frame renders as
   * the primary heading of the current state — the top bar's `<h1>` on the live stage, PreJoin's
   * "Ready to join?", the waiting stage's title, and both notice cards' `<h1>`.
   *
   * ⚠ THE OWNER FOCUSES IT; this component only forwards it. `tabIndex={-1}` on the heading is
   * what makes a non-interactive element focusable programmatically without joining the tab
   * order — do not "tidy" it away.
   */
  readonly headingRef?: React.Ref<HTMLHeadingElement>;
}

/**
 * ⚠ THE PARAMETER CARRIES ITS TYPE INLINE AS WELL AS VIA THE ALIAS. That looks redundant and is
 * not: `eslint-plugin-react`'s `prop-types` rule reads the PARAMETER's annotation, not the
 * variable's, so with the alias alone it reports "'headingRef' is missing in props validation" —
 * a warning, and `apps/web` lints with `--max-warnings 0`.
 */
type MeetingCallSurfaceComponent = (props: Readonly<MeetingCallSurfaceProps>) => React.JSX.Element;

export const MeetingCallSurface: MeetingCallSurfaceComponent = ({
  roomUrl,
  token,
  isOwner,
  expiresAt,
  participantId,
  headingRef,
}: Readonly<MeetingCallSurfaceProps>) => {
  const result = useMemo(
    () => validateGrant({ roomUrl, token, isOwner, expiresAt, participantId }),
    [roomUrl, token, isOwner, expiresAt, participantId]
  );

  const rejection = result.ok ? null : result.reason;
  useEffect(() => {
    if (rejection === null) return;
    /*
      ⚠⚠ OBSERVED BY ANALYTICS, **NOT** BY `log.error`. `@/lib/logging` is bare `pino` +
      `AsyncLocalStorage` and is NOT client-safe — it carries no `server-only` marker to stop the
      mistake, which is exactly why this is written down. The `reason` is one of six fixed codes
      that name WHICH CHECK FAILED and never the offending data, so it is safe by construction.
    */
    track(MEETING_CALL_EVENTS.GRANT_REJECTED, { reason: rejection });
  }, [rejection]);

  if (!result.ok) {
    /*
      ⚠ THE SHIPPED CARD, BYTE FOR BYTE. No parse error, no offending value, no "invalid room
      URL", no toast, no retry. That component is propless-apart-from-the-ref BY DESIGN and the
      type system enforces it — do not add a `reason` prop.
    */
    return <JoinUnavailableNotice headingRef={headingRef} />;
  }

  /*
    ⚠ NO SEPARATE LOADING BRANCH IS NEEDED HERE: `MeetingFrame` is `dynamic({ ssr: false })` and
    its `loading:` fallback IS the shipped "Connecting…" card — the same card this seam rendered
    for the whole of BAL-132.
  */
  return <MeetingFrame grant={result.grant} headingRef={headingRef} />;
};
