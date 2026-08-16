import { z } from 'zod';
import type {
  MeetingLifecycleStatus,
  MeetingViewerRole,
  MeetingWaitingPhase,
} from '@balo/shared/meetings';

/**
 * BAL-134 (§7.1) — **THE WIRE SHAPE OF `GET /meetings/:meetingId/state`, AND ITS PARSER.**
 *
 * ⚠⚠ **THE `phase` FIELD IS A LABEL THE SERVER COMPUTED. THE BROWSER NEVER COMPUTES A
 * THRESHOLD, AND NOTHING IN THIS MODULE — OR ANY MODULE BELOW IT — MAY START.** That is the
 * acceptance criterion verbatim ("all timing is server-authoritative; the client renders a
 * mirror"), and it is structural rather than stylistic: the five timers carry env overrides
 * (D8) that only `apps/api` reads, so a browser deriving `near` from a shipped default would
 * disagree with an overridden server, silently, and only in the environment that was
 * overridden. If you find yourself importing `NO_SHOW_FLOOR_MS` into `apps/web`, stop.
 *
 * ⚠ PURE AND CLIENT-SAFE — no `server-only`, no `@balo/db`, no `@/lib/logging`. It is imported
 * by the poll hook, which runs in the browser. The SERVER-ONLY half of this feature (the
 * Bearer-carrying fetch) lives in `meeting-lifecycle-client.ts`.
 *
 * ⚠⚠ THE PAYLOAD IS **PARSED, NOT CAST.** `meeting-lifecycle-client.ts` returns `parsed as T`
 * — an unchecked cast of an external JSON body, the same one `join-api-client.ts` carries and
 * the same one `validate-grant.ts` exists to answer. Two of the fields here drive a MONEY-
 * ADJACENT display (`clocks`, and the amber "counted" chip), so a malformed body must degrade
 * to "no mirror" rather than to `NaN` on a chip a participant reads mid-call.
 *
 * ⚠ IT CARRIES NO MONEY FIGURE, NO TOKEN, NO `roomUrl` AND NO `participantId`. The clocks are
 * DURATIONS. `MeetingClockSlot` renders elapsed time only; the BAL-403 precedent forbids a
 * live cost meter, and this payload could not feed one.
 */

/**
 * ⚠⚠ THE LITERALS ARE RESTATED HERE AND **DRIFT-GUARDED BELOW**, not imported as values.
 * `@balo/shared/meetings` exports them as TYPES only (they are hand-restated pgEnum labels),
 * and a Zod schema needs runtime values. The `AssertNever` pairs are what make the restatement
 * safe: a sixth `meeting_status` label — or a fifth waiting phase — fails `pnpm typecheck`
 * RIGHT HERE until it is given an arm in `resolveTopBarClock` and a string in `waiting-copy.ts`.
 */
const STATUS_LABELS = [
  'scheduled',
  'waiting_for_participants',
  'in_progress',
  'ended',
  'cancelled',
] as const;

const PHASE_LABELS = ['pre-start', 'running', 'near', 'settled'] as const;

const VIEWER_ROLE_LABELS = ['client', 'expert'] as const;

type AssertNever<T extends never> = T;
export type AssertMeetingStateLabelsMatch = [
  AssertNever<Exclude<MeetingLifecycleStatus, (typeof STATUS_LABELS)[number]>>,
  AssertNever<Exclude<(typeof STATUS_LABELS)[number], MeetingLifecycleStatus>>,
  AssertNever<Exclude<MeetingWaitingPhase, (typeof PHASE_LABELS)[number]>>,
  AssertNever<Exclude<(typeof PHASE_LABELS)[number], MeetingWaitingPhase>>,
  AssertNever<Exclude<MeetingViewerRole, (typeof VIEWER_ROLE_LABELS)[number]>>,
  AssertNever<Exclude<(typeof VIEWER_ROLE_LABELS)[number], MeetingViewerRole>>,
];

/** An ISO 8601 instant, or `null`. ⚠ `Date.parse` rather than a regex — S5852 and correctness. */
const isoInstant = z.string().refine((value) => Number.isFinite(Date.parse(value)));

const stateSchema = z.object({
  status: z.enum(STATUS_LABELS),
  /**
   * ⚠ A FREE STRING, DELIBERATELY. `meeting_outcome` is BAL-412's enum to grow and nothing in
   * this UI branches on it — it is carried so a future surface has it without another round
   * trip. Narrowing it here would make an outcome BAL-412 adds fail the whole parse and blank
   * a live participant's mirror.
   */
  outcome: z.string().nullable(),
  endedBy: z.string().nullable(),
  viewerRole: z.enum(VIEWER_ROLE_LABELS),
  /** ⚠⚠ SERVER-COMPUTED. See the module docblock. */
  phase: z.enum(PHASE_LABELS),
  clocks: z.object({
    expertPresentMs: z.number().finite().nonnegative(),
    billableMs: z.number().finite().nonnegative(),
    expertFirstJoinedAt: isoInstant.nullable(),
    billableStartedAt: isoInstant.nullable(),
  }),
  /**
   * The instant the clocks were measured at.
   *
   * ⚠ LOAD-BEARING FOR THE BROWSER'S TICKER, not decoration: `MeetingClockSlot` interpolates
   * between polls and DRIFT-CORRECTS against this, which is what lets the mirror look live
   * without ever being an input to settlement.
   */
  asOf: isoInstant,

  // ── ⚠⚠ THE TWO FIELDS BELOW ARE **OPTIONAL ON THE WIRE, ON PURPOSE** ────────────────────
  //
  // ⚠⚠ **THE PRODUCER EXISTS. DO NOT "TIGHTEN" THESE TO REQUIRED.** `apps/api` now sends both
  // (`services/meetings/meeting-state.ts`), so it is tempting to read `.optional()` here as
  // leftover laziness from before the api caught up. It is not. It is a DEPLOYMENT-SKEW GUARD,
  // and it is load-bearing permanently, because apps/web (Vercel) and apps/api (Railway) deploy
  // INDEPENDENTLY — there is no release that lands them together.
  //
  // Making either REQUIRED means a web deploy landing ahead of the api's fails the WHOLE
  // `safeParse`, which degrades to `snapshot === null` — no phase, no chip, NO MIRROR AT ALL, for
  // every participant in every live call until the api catches up. The blast radius of the strict
  // version is "every live call goes dark"; the blast radius of the lenient version is "one
  // sentence names no number for one deploy window". That is not a close call.
  //
  // ⚠ THE CONSUMERS ALREADY HANDLE ABSENCE EXPLICITLY, which is what makes this safe rather than
  // sloppy: both degrade to `null` at the boundary below — a THIRD answer, never a falsy default.
  // See `waiting-copy.ts`'s `floorPhrase` (re-words the sentence to name no number) and
  // `top-bar-clock.ts`'s `isExpertPresent` (documented skew fallback).

  /**
   * The no-show floor in whole minutes, as the SERVER resolved it from the env-overridable
   * timers (D8).
   *
   * ⚠ ABSENT ⇒ THE COPY NAMES NO NUMBER. It must never fall back to a shipped `15`: that is a
   * hard-coded threshold in the browser bundle wearing an interpolation, and it drifts silently
   * from a server running `MEETING_NO_SHOW_FLOOR_MINUTES`.
   */
  noShowFloorMinutes: z.number().int().positive().optional(),

  /**
   * The server's presence observation. `expertOpen` is `summarisePresence(...).expertOpen` — an
   * expert interval that is **OPEN RIGHT NOW**, not "an expert joined at some point".
   *
   * ⚠ THE DISTINCTION IS THE WHOLE POINT. An expert whose interval closed (network drop, tab
   * killed, laptop lid) has a frozen `expertPresentMs` server-side; gating the amber chip on
   * "ever joined" leaves a TICKING counted duration on their screen against a server clock that
   * stopped — over-stating credited time in the one place this ticket exists to make honest.
   */
  presence: z.object({ expertOpen: z.boolean() }).optional(),
});

/** The body exactly as the api sends it — instants still ISO strings. */
export type MeetingStateWire = z.infer<typeof stateSchema>;

/** The parsed mirror the UI renders. ⚠ Instants are `Date`s; durations are milliseconds. */
export interface MeetingStateSnapshot {
  readonly status: MeetingLifecycleStatus;
  readonly outcome: string | null;
  readonly endedBy: string | null;
  /** ⚠ THE GATE'S OWN VERDICT about which side the viewer is on — never a lens. */
  readonly viewerRole: MeetingViewerRole;
  readonly phase: MeetingWaitingPhase;
  readonly clocks: {
    readonly expertPresentMs: number;
    readonly billableMs: number;
    readonly expertFirstJoinedAt: Date | null;
    readonly billableStartedAt: Date | null;
  };
  readonly asOf: Date;
  /**
   * ⚠ `null` ⇒ **THE SERVER DID NOT SAY**, which is a third answer and not a `false`. Consumers
   * must decide explicitly what an unanswered question means for their surface rather than
   * letting `undefined` collapse into a falsy branch.
   */
  readonly noShowFloorMinutes: number | null;
  /** ⚠ `null` ⇒ the server did not say. See {@link noShowFloorMinutes}. */
  readonly expertPresenceOpen: boolean | null;
}

/** `null` for anything that is not a well-formed state body. ⚠ Never throws, never coerces. */
export function parseMeetingState(raw: unknown): MeetingStateSnapshot | null {
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const { clocks, noShowFloorMinutes, presence, ...rest } = parsed.data;
  return {
    ...rest,
    clocks: {
      expertPresentMs: clocks.expertPresentMs,
      billableMs: clocks.billableMs,
      expertFirstJoinedAt: toDate(clocks.expertFirstJoinedAt),
      billableStartedAt: toDate(clocks.billableStartedAt),
    },
    asOf: new Date(parsed.data.asOf),
    // ⚠ `undefined` → `null` AT THE BOUNDARY, so nothing downstream has to know that the wire
    // spells "not sent" differently from "not known".
    noShowFloorMinutes: noShowFloorMinutes ?? null,
    expertPresenceOpen: presence?.expertOpen ?? null,
  };
}

function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/**
 * ⚠ `retryable` IS PART OF THE CONTRACT, exactly as it is on the guests read. The poll keeps
 * its schedule on a transport blip and stops on a verdict; collapsing the two makes a dropped
 * packet look like a dead meeting to a participant mid-call.
 */
export type GetMeetingStateResult =
  | { readonly success: true; readonly state: MeetingStateWire }
  | { readonly success: false; readonly retryable: boolean; readonly retryAfterSeconds?: number };

/**
 * The end action's answer.
 *
 * ⚠⚠ `alreadyEnded` IS A **SUCCESS**, NOT AN ERROR (D10). Two `canEndMeeting` holders can press
 * the button in the same instant; the server's transition is a compare-and-set and the loser
 * gets `200 { alreadyEnded: true }`. Surfacing that as a failure would put a red toast on the
 * one control that must always work, for a race that resolved correctly.
 */
export type EndMeetingResult =
  | { readonly success: true; readonly alreadyEnded: boolean }
  | { readonly success: false; readonly error: string };

/**
 * The one string a failed end shows the person pressing the button.
 *
 * ⚠ IT SAYS WHAT IS TRUE — the call is still running — rather than naming a cause. The api
 * collapses "no such meeting", "not your party" and "no authority" into ONE literal precisely
 * so a UI cannot start branching on prose, and a person on a live call needs to know whether
 * they are still in it, not which of three server rules declined.
 */
export const END_MEETING_FAILED_COPY = "We couldn't end the call — everyone is still connected.";

/**
 * BAL-134 — the ERROR state of the four this surface owes, and the one that was missing.
 *
 * ⚠⚠ IT SAYS WHAT STOPPED AND WHAT DID NOT. The poll giving up does **not** mean the call ended:
 * the person is still connected, still on the call, and only the *status* line has stopped
 * advancing. Saying "disconnected" would be false and frightening on a live call; saying nothing
 * leaves an expert waiting for a "you're free to leave" that can no longer arrive.
 *
 * ⚠ QUIET BY CONSTRUCTION — no toast, no modal, no colour alarm. It is the `JoinRetryNotice`
 * posture: state the degradation, keep the affordance live, get out of the way.
 */
export const MEETING_STATE_STALLED_COPY = "Live status paused — you're still connected.";

/** The label on the manual retry beside {@link MEETING_STATE_STALLED_COPY}. */
export const MEETING_STATE_RETRY_LABEL = 'Refresh status';
