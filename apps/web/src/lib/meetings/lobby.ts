/**
 * BAL-132 — the lobby's shared constants and copy.
 *
 * ⚠⚠ THEY LIVE HERE, IN A PLAIN MODULE, AND **NOT** IN A `'use server'` FILE. A Server Action
 * module may export ONLY async functions: `export const POLL_INTERVAL_MS = 5000` inside one
 * fails `next build` with "A 'use server' file can only export async functions" — while
 * `tsc --noEmit`, eslint and vitest ALL pass (memory
 * `reference_use_server_no_value_exports`). This module exists so that trap has nowhere to
 * spring.
 *
 * ⚠ PURE, AND NO `server-only`. The client component imports the intervals; the actions
 * import the copy. A `server-only` guard here would break the former.
 */

/**
 * How often the lobby asks "have I been let in yet?" — DECISION 7.
 *
 * ⚠ POLLING, NOT REAL-TIME, AND THAT IS AN EXPLICIT DECISION RATHER THAN A SHORTCUT. BAL-437
 * owns Ably, and **how a guest authenticates to Ably is STILL an unsolved problem** — BAL-445
 * solves the guest READ subject (`resolveMeetingGuestSubject`), not the Ably `clientId`. A
 * guest has no `user.id`, and the shipped `createConversationRealtimeTokenAction` sets
 * `clientId = user.id`. If a future ticket mints a guest Ably token, `MeetingGuestSubject.guest.id`
 * (`meeting_guests.id`) is the subject it should bind to — the same stable, revocable handle
 * this ticket's read actions already key their `guestId` logging on. The polling contract here
 * is unchanged either way: this endpoint stays the source of truth, so a future realtime push
 * can layer an invalidation on top of it without changing this contract.
 */
export const LOBBY_POLL_INTERVAL_MS = 5_000;

/**
 * The slower cadence after {@link LOBBY_POLL_BACKOFF_AFTER_MS}.
 *
 * ⚠ THE BACK-OFF IS NOT POLITENESS — IT IS WHAT KEEPS A PATIENT GUEST INSIDE THE RATE LIMIT.
 * `guest-join` allows 600 requests per IP per hour; at a flat 5s that window is exhausted in
 * 50 minutes, and the guest would start seeing failures while still legitimately waiting. At
 * 15s after the first two minutes, an hour of waiting costs ~260 requests.
 */
export const LOBBY_POLL_BACKOFF_INTERVAL_MS = 15_000;

/** When the poll slows down. Two minutes: long enough that a prompt admit still feels instant. */
export const LOBBY_POLL_BACKOFF_AFTER_MS = 120_000;

/**
 * How many CONSECUTIVE retryable poll failures the lobby tolerates before giving up.
 *
 * ⚠⚠ THE COUNTER EXISTS BECAUSE THE ALTERNATIVE IS A BACK-OFF THAT CANNOT RUN. Treating every
 * poll failure as terminal — which the first cut did — stops the scheduler on the first blip,
 * so the whole 5s→15s design (which exists to keep a guest inside the rate limit across a
 * ~35-minute wait) never survived a single dropped packet. A guest on a patchy phone
 * connection, which is THE primary context for a forwarded meeting link, would be shown "this
 * link isn't active" for a link that is perfectly fine.
 *
 * ⚠ BOUNDED RATHER THAN INFINITE, so a genuinely dead endpoint does not leave a tab polling
 * forever. Eight failures spans ~2 minutes at the slow cadence.
 */
export const LOBBY_MAX_CONSECUTIVE_POLL_FAILURES = 8;

/**
 * When the wait stops being "any second now", so the UI can acknowledge it and offer a way out.
 *
 * ⚠ NEITHER THE EXTRA LINE NOR THE EXIT DISCLOSES ANYTHING ABOUT THE MEETING — they are facts
 * about the VISITOR's own wait — so Decision 9's no-oracle rule is untouched.
 */
export const LOBBY_LONG_WAIT_AFTER_MS = 180_000;

/**
 * Where the lobby token is mirrored so a reload resumes the poll.
 *
 * ⚠⚠ `sessionStorage`, **NEVER** `localStorage`. The credential must not outlive the tab, for
 * the same reason `/join/[token]` mints no cookie: a store that survives the session would
 * keep a live queue place — and, after an admit, a live room credential — on a shared or
 * public machine long after the person walked away.
 */
export const LOBBY_TOKEN_STORAGE_KEY = 'balo.lobby-token';

/**
 * Where the WAIT'S START INSTANT is mirrored, beside the token.
 *
 * ⚠ WITHOUT IT THE BACK-OFF RESETS ON EVERY RELOAD, so a guest who refreshes a few times over
 * a long wait silently reverts to the fast 5s cadence — exactly the budget the back-off exists
 * to protect. It is a timestamp, not a credential: same store, so the pair dies together, but
 * nothing is disclosed by it.
 */
export const LOBBY_WAIT_STARTED_STORAGE_KEY = 'balo.lobby-waiting-since';

/**
 * ⚠⚠ ONE STRING FOR EVERY WAY EITHER JOIN SURFACE CAN FAIL, AND NOT ONE BYTE OF DIFFERENCE
 * BETWEEN THEM.
 *
 * A cancelled meeting, an ended meeting, a full room, a denied knock, a revoked token, an
 * unknown token, a meeting id that never existed — all of them render THIS. Differentiating any
 * one would make the page an oracle: "that meeting is real but was cancelled", "you were
 * denied", "the room is full" are each a fact about a meeting the visitor may simply have
 * guessed the id of.
 *
 * ⚠⚠ `JOIN_`, NOT `LOBBY_`, AND THE RENAME IS LOAD-BEARING. **BOTH** surfaces import these now:
 * `/join/m/[meetingId]`'s `LobbyUnavailable` and `/join/[token]`'s `LinkNotActive`. The lobby's
 * docblock used to CLAIM the copy was shared "so it cannot drift from `/join/[token]`'s
 * sibling" while that sibling hardcoded its own literals and imported nothing — and the two
 * bodies had ALREADY drifted ("Invitation links…" vs "Meeting links…"). A route-neutral name is
 * what makes the claim true rather than aspirational.
 *
 * ⚠ THE BODY MUST READ CORRECTLY FOR **BOTH** AUDIENCES. An invited guest was emailed a link; a
 * lobby visitor was forwarded one by somebody nobody recorded. So it says "shared it with you",
 * never "invited you" — which would be false for half the readers.
 *
 * ⚠⚠ AND IT NAMES **NO DOMAIN OBJECT AT ALL** — not the meeting, not the company, the agency,
 * the date or the inviter, and not even the WORD "meeting". `link-not-active.test.tsx` pins that
 * (it asserts the text matches neither `/\bmeeting\b/` nor `/\bcall\b/`), and the reason is that
 * this card renders for tokens and ids that never resolved to ANYTHING: naming what the link
 * would have been for is itself a small disclosure, and it is free to avoid.
 *
 * ⚠ IT STILL POINTS AT A REAL NEXT STEP, and that step is a HUMAN one. There is deliberately no
 * "sign in" (a guest has no account) and no "email me a new link" (an unauthenticated email-send
 * primitive is an email-bomb amplifier and an existence oracle — its own ticket).
 */
export const JOIN_UNAVAILABLE_TITLE = "This link isn't active";

export const JOIN_UNAVAILABLE_BODY =
  'Links like this stop working after a while, and they can be replaced at any time. Whoever shared it with you can send a fresh one.';

/**
 * ⚠ THE ONE FAILURE THAT IS **NOT** COLLAPSED, AND WHY THAT IS SAFE (BAL-132 fix).
 *
 * A `503` on the guest poll means OUR OWN upstream could not mint — Daily is down, or
 * `DAILY_API_KEY` is missing. It is reachable ONLY after a ≥256-bit token has already resolved
 * AND the bearer was already admitted, so "retry in a moment" confirms nothing they did not
 * already know: they are a real, admitted guest of a real meeting. Rendering the uniform
 * dead-link card there is an outright lie that costs them the call.
 *
 * ⚠⚠ A `429` MUST STAY COLLAPSED. It fires PRE-AUTHORIZATION, before any token has resolved, so
 * a distinct message would tell an anonymous scanner "you are being counted" — a signal about
 * the platform they must not get for free.
 */
export const JOIN_TEMPORARILY_UNAVAILABLE_TITLE = "We couldn't connect you just now";

export const JOIN_TEMPORARILY_UNAVAILABLE_BODY =
  "This is on our side, not yours — the call room didn't answer. Give it a moment and try again.";

/**
 * ── ⚠⚠ THE WAITING COPY, SHARED — THE SECOND HALF OF THE JOB THE FAILURE COPY STARTED ─────
 *
 * The failure literals above were hoisted here because the two join surfaces had ALREADY
 * drifted while a docblock claimed they could not. The WAITING copy was left duplicated in
 * `lobby-client.tsx` and `join-control.tsx` — two byte-identical literals in two files, which
 * is the same latent drift, one screen over. Both now render `JoinWaitingCard`, which reads
 * these.
 *
 * ⚠ THE COPY MUST READ CORRECTLY FOR **BOTH** AUDIENCES, exactly as the failure body must: an
 * anonymous visitor who was forwarded a link, and an invited guest a host moved back into the
 * queue. So it says "the host" and "you'll join automatically", never "your invitation" — and
 * it names NO domain object, for the same no-oracle reason.
 *
 * ⚠ THE LONG-WAIT LINE IS A FACT ABOUT THE **WAIT**, NEVER ABOUT THE MEETING. "They may not be
 * at their desk yet" is a statement about a generic host's day, not about this host, this
 * company or this call — which is what keeps Decision 9 intact while still acknowledging that
 * nothing is happening.
 */
export const JOIN_WAITING_TITLE = 'Waiting for someone to let you in';

export const JOIN_WAITING_BODY =
  "We've told the host you're here. You'll join automatically as soon as they let you in — no need to refresh.";

export const JOIN_LONG_WAIT_BODY =
  'This is taking a little longer than usual. They may not be at their desk yet — you can keep waiting, or come back to this link later.';

/**
 * BAL-435 — the MEMBER join action's two distinguishable failures, hoisted so the action and its
 * caller cannot disagree about which one happened.
 *
 * ⚠⚠ THEY ARE HERE, NOT IN `join-as-member.ts`, FOR THE REASON THIS WHOLE MODULE EXISTS: a
 * `'use server'` file may export ONLY async functions, so `export const MEMBER_JOIN_… = '…'`
 * there would fail `next build` while `tsc`, eslint and vitest all pass.
 *
 * ⚠ THE ACTION'S FAILURE COPY IS OTHERWISE INTENTIONALLY COARSE — the api collapses "no such
 * meeting", "not your party" and "no capability" into ONE literal, so this layer cannot and must
 * not try to say more. The only two it distinguishes are facts about the CALLER's own state (a
 * signed-out session) or a genuine upstream outage.
 */
export const MEMBER_JOIN_SIGNED_OUT_ERROR = 'Please sign in and try again.';

/** ⚠ A **503**: the call room did not answer. Retryable — the caller schedules another attempt. */
export const MEMBER_JOIN_OUTAGE_ERROR =
  "We couldn't set up your call room just now. Please try again in a moment.";

/** ⚠ THE COLLAPSE. Everything else, byte for byte, so nothing can be inferred from the wording. */
export const MEMBER_JOIN_UNAVAILABLE_ERROR = "This meeting isn't available to join.";

/**
 * BAL-445 — ⚠ ONE STRING FOR EVERY WAY A GUEST'S IN-CALL READ CAN FAIL: a revoked token, an
 * expired one, a meeting outside their recorded grant, a cancelled meeting, a meeting id they
 * guessed, a throttle, a repository throw. Same no-oracle rule as {@link JOIN_UNAVAILABLE_TITLE}
 * — a guest read must not become an oracle a member read is not. It names no domain object and
 * points at a human next step. It is here, not in an `app/join/_actions/*.ts` module, for the
 * same reason every other literal in this file is: a `'use server'` file may export only async
 * functions.
 */
export const GUEST_READ_UNAVAILABLE_ERROR =
  "This isn't available to you. Whoever shared the link with you can help.";
