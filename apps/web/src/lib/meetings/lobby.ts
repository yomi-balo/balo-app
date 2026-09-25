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
/**
 * BAL-476 (R5 amended) — the HARD BOUND on the exit-reason probe.
 *
 * ⚠⚠ ONE ATTEMPT, NO POLL, NO BACK-OFF, NO RE-ARM. This is a TERMINAL transition, not a wait:
 * the card it selects offers no retry affordance of any kind (the same reasoning that gives
 * `MeetingEndedNotice` no rejoin control), which would make an unbounded spinner a dead end the
 * person can never leave. On abort the probe resolves to the VAGUER `access_ended` card, exactly
 * like every other inconclusive answer.
 */
export const GUEST_EXIT_PROBE_TIMEOUT_MS = 4_000;

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
 * "sign in" (a guest has no account). ⚠ CORRECTED BY BAL-442 — this docblock used to say "no
 * 'email me a new link' … an unauthenticated email-send primitive is an email-bomb amplifier
 * and an existence oracle — its own ticket." That ticket is BAL-442 and it has SHIPPED — on the
 * LOBBY's knock form (`app/join/m/[meetingId]/lobby-reentry.tsx`), never here. This shared card
 * still offers no CTA of its own: it is shared with `/join/[token]`, which has no `meetingId` in
 * scope and is structurally incapable of hosting the affordance, and it renders for a token that
 * never resolved, so there is nothing here to recover.
 */
export const JOIN_UNAVAILABLE_TITLE = "This link isn't active";

export const JOIN_UNAVAILABLE_BODY =
  'Links like this stop working after a while, and they can be replaced at any time. Whoever shared it with you can send a fresh one.';

/**
 * ⚠ THE ONE GUEST FAILURE THAT IS **NOT** COLLAPSED, AND WHY THAT IS SAFE (BAL-132 fix).
 *
 * A `503` on the guest poll means OUR OWN upstream could not mint — Daily is down, or
 * `DAILY_API_KEY` is missing. It is reachable ONLY after a ≥256-bit token has already resolved
 * AND the bearer was already admitted, so "retry in a moment" confirms nothing they did not
 * already know: they are a real, admitted guest of a real meeting. Rendering the uniform
 * dead-link card there is an outright lie that costs them the call.
 *
 * ⚠⚠ A `429` MUST STAY COLLAPSED ON THE GUEST POLL. It fires PRE-AUTHORIZATION, before any token
 * has resolved, so a distinct message would tell an anonymous scanner "you are being counted" —
 * a signal about the platform they must not get for free.
 *
 * ⚠⚠ BAL-581 — THIS IS ALSO THE MEMBER ROUTE'S RETRY CARD, for a transport failure or ANY 5xx
 * from a signed-in member's join (`MemberJoinFailureReason` = `'outage'`), not only a `503` on
 * the guest poll. Both readings are honest for the same reason: neither leaks anything about a
 * meeting the caller was not already authorized to reach.
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
 * BAL-581 — THE MEMBER ROUTE'S REFUSAL COPY. A signed-in member is never shown the guest
 * "whoever shared it" card: every reason below is safe to state because the api reaches each one
 * only AFTER authorization succeeded (`join-meeting.ts:31-42`); `unavailable` is the collapse for
 * everything else, member-worded. Here, not in the action, because a `'use server'` file may
 * export only async functions.
 *
 * ⚠⚠ EACH REASON BELOW IS DISTINGUISHED RATHER THAN COLLAPSED, because collapsing them would
 * cost a real member real information for no anonymity gain: `meeting_not_provisioned` and
 * `meeting_not_open_for_join` have been `409`s — unreachable before authorization — since
 * `ee5fce50` (BAL-132). `MemberJoinFailureReason`'s allowlist (`member-join-failure.ts`) is the
 * one place that decides what may be distinguished.
 */
export const MEMBER_JOIN_SETTING_UP_TITLE = "We're still setting up your call room";
export const MEMBER_JOIN_SETTING_UP_BODY =
  "This one's on us, not you — the call room for this meeting isn't ready yet, and our team has been alerted. We'll try again for you in a moment, or you can try again yourself.";
export const MEMBER_JOIN_NOT_OPEN_TITLE = "This meeting isn't open to join";
export const MEMBER_JOIN_NOT_OPEN_BODY =
  'It may have ended or been cancelled, or its time to join has passed. Your dashboard has the latest.';
export const MEMBER_JOIN_UNAVAILABLE_TITLE = "This meeting isn't available to join";
export const MEMBER_JOIN_UNAVAILABLE_BODY =
  'It may have moved, or you may no longer have access to it. Your dashboard shows the meetings you can join.';

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

/**
 * BAL-442 — the lobby's self-service RE-ENTRY affordance. ⚠ HERE, NOT IN THE `'use server'`
 * ACTION MODULE, for the same reason every other literal in this file is.
 */
export const LOBBY_REENTRY_TRIGGER_LABEL = 'Already asked to join? Email me my link';

export const LOBBY_REENTRY_HELPER =
  "We'll send a fresh link to the address you used — and only to that address.";

export const LOBBY_REENTRY_EMAIL_LABEL = 'The email you used';

export const LOBBY_REENTRY_SUBMIT_LABEL = 'Email me my link';

export const LOBBY_REENTRY_SUBMITTING_LABEL = 'Sending…';

/**
 * ⚠⚠ THE NEUTRAL CONFIRMATION, AND IT IS THE WHOLE PRIVACY PROPERTY IN ONE SENTENCE. It renders
 * IDENTICALLY whether a row matched or not — there is deliberately no "we couldn't find an
 * invitation for that address", because that sentence IS the oracle. It is conditional in
 * grammar ("if there's…") so it is never a lie in either direction.
 */
export const LOBBY_REENTRY_NEUTRAL_MESSAGE =
  "If there's an active invitation for that address, we've sent a new link. It can take a minute to arrive.";

export const LOBBY_REENTRY_INVALID_INPUT_ERROR = 'Please enter the email address you used.';

/**
 * BAL-442 fix round (F1) — the TRANSPORT-FAILURE copy, and it is deliberately a DIFFERENT
 * literal from {@link LOBBY_REENTRY_NEUTRAL_MESSAGE}.
 *
 * ⚠⚠ ORCHESTRATOR RULING — two review gates proposed different fixes for the `.catch()` arm
 * rendering the NEUTRAL (success) sentence on a dropped connection. UX proposed a dedicated new
 * constant; technical review proposed reusing `JOIN_UNAVAILABLE_TITLE`. This constant is the
 * ruling: `JOIN_UNAVAILABLE_TITLE` is the DELIBERATELY-COLLAPSED literal for outcomes where the
 * ANONYMITY OF A MEETING is at stake — see its own docblock. A transport failure (the request
 * may never have reached the server) discloses NOTHING about any meeting, so there is no
 * anonymity reason to collapse it, and telling the visitor plainly that nothing was sent — so
 * they know to retry rather than wait for an email that is never coming — is strictly better for
 * the exact persona this ticket exists to serve.
 *
 * ⚠ Never {@link LOBBY_REENTRY_NEUTRAL_MESSAGE} in the catch arm. That sentence is an
 * AFFIRMATIVE claim ("we've sent a new link") that is false here — the request may not have
 * reached the server at all.
 */
export const LOBBY_REENTRY_TRANSPORT_ERROR = "We couldn't reach Balo just now. Please try again.";

/**
 * BAL-442 fix round (R-2) — the copy for a SERVER REFUSAL on the re-entry route: a `429` from
 * any of the three caller-keyed windows, a `503` when the recipient window's Redis is
 * unreachable, or the (structurally unreachable) `400`.
 *
 * ⚠⚠ IT REPLACES {@link JOIN_UNAVAILABLE_TITLE} ON THIS PATH, BY THE SAME REASONING THAT
 * PRODUCED {@link LOBBY_REENTRY_TRANSPORT_ERROR}. `JOIN_UNAVAILABLE_TITLE` is collapsed to
 * protect THE ANONYMITY OF A MEETING — see its own docblock — and **not one of the statuses
 * above is about a meeting.** `POST /meetings/:meetingId/lobby/reentry` answers `202` with the
 * neutral sentence for EVERY meeting-related outcome there is (no such meeting, cancelled,
 * ended, no matching row, recipient budget exhausted, even a throw); its own docblock states
 * there is no `404` and no `409` on it, ever. So a refusal that reaches this branch is a fact
 * about OUR side or about the caller's own request rate, where there is nothing to protect —
 * and "this link isn't active" is simply FALSE there. It sends a guest off to chase a fresh
 * link from whoever shared the meeting when all they had to do was wait a minute.
 *
 * ⚠⚠ ONE LITERAL FOR ALL THREE STATUSES, AND THAT IS WHAT KEEPS THE `429` SAFE. The earlier
 * docblock's concern was real — copy that said "you are being rate limited" would tell an
 * anonymous scanner they are being counted. This says nothing of the sort, and a `429`, a
 * `503` and a `400` are BYTE-IDENTICAL to the caller, so the window's existence is still not
 * disclosed. ⚠ DO NOT SPLIT THIS BY STATUS.
 *
 * ⚠ SEPARATE FROM {@link LOBBY_REENTRY_TRANSPORT_ERROR} because the two are different facts:
 * that one means the request may never have arrived, this one means it arrived and was
 * refused. Both are honest, and both point at the same next step.
 */
export const LOBBY_REENTRY_RETRY_LATER_ERROR =
  "We couldn't send that just now. Give it a little while and try again.";
