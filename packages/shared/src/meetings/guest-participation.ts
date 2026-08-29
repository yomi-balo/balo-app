/**
 * BAL-408 / ADR-1044 — the PURE core of the guest participation model.
 *
 * Four decisions live here rather than in `apps/api` or `apps/web`, because each is a RULE
 * that more than one layer must reach the same answer on, and because none of them needs
 * I/O:
 *
 *   · `selectPrimaryMeetingContext` — the `meetingId` → ONE context combining rule that
 *     ADR-1046 §3 never states and BAL-413 flag F1 defers to its first `meetingId`-shaped
 *     consumer. That is this ticket. **⚠ NEEDS RATIFICATION AS AN ADR-1046 AMENDMENT.**
 *     …plus its companion stability predicate, {@link findPrimaryMeetingContextRepoint}, which
 *     is what stops a writer moving the winner underneath an existing meeting, booked or not
 *     (BAL-469).
 *   · `presencePartyForGuest` — THE MONEY RULE. See its docblock; getting this wrong bills
 *     a client for a guest's time.
 *   · `guestMayReadMeeting` — the retrospective read predicate. BAL-408 RECORDS the grant;
 *     **BAL-445 CALLS THIS to ENFORCE it**, from `apps/web/src/lib/meetings/authorize-meeting-file-access.ts`.
 *   · `projectGuestForViewer` — counterparty concealment: names cross the party boundary,
 *     email addresses NEVER.
 *
 * PURE and dependency-free (no `@balo/db`, no `node:crypto`, no I/O) — the same rule the
 * rest of `@balo/shared/meetings` follows, so a client component can reach these without
 * the `@balo/db`-in-a-client-bundle footgun (memory `reference_balo_db_client_bundle_footgun`).
 */

// ── Vocabulary ────────────────────────────────────────────────────────────────────────

/**
 * The three `meeting_participant_party` labels, restated PURELY so this subpath never
 * value-imports `@balo/db`. `observer` exists for an attendee who is present but never
 * billable — see `presencePartyForGuest`.
 */
export type MeetingPresenceParty = 'expert' | 'client' | 'observer';

/**
 * The two sides a GUEST may sit on — the `meeting_guest_party_two_sided` CHECK in the type
 * system. Narrower than `MeetingPresenceParty` on purpose: a guest is always somebody's
 * colleague, never a Balo observer.
 */
export type MeetingGuestSide = Extract<MeetingPresenceParty, 'client' | 'expert'>;

/** What a guest may READ afterwards. Mirrors the `guest_access_scope` pgEnum. */
export type GuestAccessScopeLabel = 'meeting' | 'engagement';

/** Alongside (`guest`) or instead of the booker (`delegate`). Mirrors `meeting_participation_role`. */
export type MeetingParticipationRoleLabel = 'guest' | 'delegate';

/** The admit/deny lifecycle. Mirrors `meeting_guest_admission`. */
export type MeetingGuestAdmissionLabel = 'pre_admitted' | 'pending' | 'admitted' | 'denied';

/**
 * HOW the guest reached the meeting. Mirrors `meeting_guest_invite_channel`, restated purely
 * for the same reason every other label list here is — this subpath must never value-import
 * `@balo/db`.
 *
 * ⚠ THE TWO LABELS CARRY A TRUST DECISION, NOT JUST A PROVENANCE FACT (`enums.ts`):
 *   · `email` — somebody with rights NAMED this address, hence trust-by-default
 *     (`pre_admitted`) and a RESOLVED `party`.
 *   · `link`  — the link was forwarded or shared, hence the waiting-to-join queue
 *     (`pending`) and a `party` that is a PLACEHOLDER. See {@link presencePartyForGuest}.
 *
 * ⚠ PINNED AGAINST THE pgEnum, NOT TRUSTED. `apps/api`'s `authorize-meeting-participation.ts`
 * carries a two-way `AssertNever` (`AssertMeetingGuestInviteChannelsMatch`) against
 * `@balo/db`'s `MeetingGuestInviteChannel`, so a THIRD label added to the database fails
 * `pnpm --filter api typecheck` until it is given a meaning here — and, crucially, until
 * somebody decides which side of the money rule below it falls on.
 */
export type MeetingGuestInviteChannelLabel = 'email' | 'link';

// ── Product numbers ───────────────────────────────────────────────────────────────────

/**
 * BAL-408 (D8) — the participant ceiling, enforced APPLICATION-SIDE at INVITE time.
 *
 * ⚠ DELIBERATELY NOT PASSED TO DAILY as `properties.max_participants`, and the reason is
 * product rather than plumbing: the composer renders "{n} of 10" AT INVITE TIME, so the
 * product needs the 11th INVITE refused with a legible message — not the 11th JOIN refused
 * mid-call by an opaque vendor error nobody could see coming. Rooms are also provisioned
 * BEFORE any guest is invited, and changing an existing room's cap needs a PATCH nothing
 * supports, so a vendor-side cap would not even bind the meetings this feature operates on.
 * **Written hand-off to BAL-129 / BAL-132: pass `properties: { max_participants: 10 }` as
 * defense-in-depth when `RoomProvisioner`'s port is next touched.**
 *
 * ⚠ A PRODUCT NUMBER, NOT A SAFETY PROPERTY — the same status as the booking-window bounds,
 * and a natural early migration to `platform_config` when BAL-398 merges (⚠ that PR is NOT
 * merged; it is a typed const today). Two inviters at 9/10 can both pass the count and
 * commit an 11th. Do NOT add an advisory lock for a soft cap.
 */
export const MAX_MEETING_PARTICIPANTS = 10;

/**
 * The seats already taken before any guest: the DELIVERING EXPERT + the BOOKING CLIENT
 * MEMBER.
 *
 * ⚠ A `delegate` is NOT netted out of this, even though it has replacement semantics — we
 * cannot know the booker will actually stay away, and over-counting refuses an invite while
 * under-counting overfills a call. Conservative on purpose; flagged in the plan (§14.6) as a
 * decision rather than an oversight.
 */
export const RESERVED_BASE_PARTICIPANTS = 2;

/**
 * BAL-132 — how many ANONYMOUS KNOCKS may sit in one meeting's admit/deny queue at once.
 *
 * ⚠⚠ A SEPARATE RESOURCE FROM {@link MAX_MEETING_PARTICIPANTS}, AND THE SEPARATION IS THE
 * WHOLE POINT. The lobby's first cut counted a `pending` knock against the PARTICIPANT cap,
 * on the same counter `inviteGuests` uses — so filling the queue from a forwarded URL also
 * took away the HOST's ability to invite anyone by email, permanently, with no way to clear
 * it (denying did not help; the denied row kept its seat). Seats in the room and slots in the
 * panel are now bounded independently:
 *
 *   · exceeding THIS refuses further KNOCKS and nothing else — invites are unaffected;
 *   · exceeding `MAX_MEETING_PARTICIPANTS` refuses further SEATS, which knocks never held.
 *
 * ⚠ SELF-CLEARING. A slot is freed by an admit, a DENY, a revoke, or `expires_at` passing —
 * so a host facing a flood has a working control, rather than a stuck meeting.
 *
 * ⚠ HIGHER THAN THE PARTICIPANT CAP ON PURPOSE. A host may legitimately deny several people
 * (wrong meeting, forwarded to the wrong team) and still admit a full room afterwards, so a
 * queue bound at 10 would be reachable in normal use.
 *
 * ⚠ A PRODUCT NUMBER, NOT A SAFETY PROPERTY — same status as the participant cap, same
 * unsynchronised-count caveat, and the same natural migration to `platform_config`.
 */
export const MAX_LOBBY_QUEUE = 25;

/**
 * How long a guest's join link outlives the meeting it was minted for: 7 days past
 * `meetings.scheduled_end`.
 *
 * The window is derived from the MEETING, never from the mint instant — which is why
 * `meeting_guests.expires_at` has NO SQL default (unlike `proposal_share_links` /
 * `review_invite_tokens`, whose `now() + 30 days` would be silently wrong for a call three
 * weeks out).
 *
 * ⚠ KNOWN LIMITATION — RESCHEDULE. A meeting moved more than this TTL past its ORIGINAL end
 * leaves already-issued links expiring BEFORE the call. **BAL-409 / BAL-410 / BAL-411 must
 * call `meetingGuestsRepository.extendExpiryForMeeting` inside their reschedule
 * transaction**; that method ships with zero production callers precisely so they need no
 * migration.
 */
export const GUEST_TOKEN_TTL_AFTER_END_MS = 7 * 24 * 60 * 60 * 1000;

// ── D3: the meetingId → ONE context combining rule ────────────────────────────────────

/**
 * ⚠⚠ THE COMBINING RULE ADR-1046 §3 NEVER STATED. BAL-413 flag F1 defers it, in writing, to
 * "the first `meetingId`-shaped consumer" and requires it to "be recorded as an ADR-1046
 * amendment when the first one lands". **THIS IS THAT RULE, AND THE AMENDMENT IS STILL
 * OUTSTANDING** (plan §14.1).
 *
 * PRECEDENCE, FAIL-CLOSED ON AMBIGUITY. Engagement-grain (100) beats request-grain (50);
 * `admin` (0) is never primary at all.
 *
 * ⚠ `any-of` WAS CONSIDERED AND REJECTED, for exactly the reason F1 gives: a meeting that
 * starts as a `project_discovery` and gains a SECOND context row for the engagement at
 * kickoff would, under `any-of`, let a LOSING discovery candidate keep host rights over the
 * kickoff meeting. Precedence fixes that directly — once the engagement context is attached
 * the discovery context is no longer primary. `all-of` was rejected because it would deny
 * the WINNER on that same meeting.
 *
 * ⚠ `admin` SCORES 0 AND IS DROPPED ENTIRELY, not merely out-ranked. An `admin` context has
 * no engagement and no delivering expert, so the engagement axis yields NO HOLDER for it;
 * Balo staff on an admin meeting are a PLATFORM-axis question (ADR-1035) and are out of
 * scope here. A meeting carrying ONLY `admin` contexts therefore resolves to `none`, which
 * the caller answers as `404` — never as "everyone may".
 */
export const MEETING_CONTEXT_PRECEDENCE = {
  // ── Engagement grain: the context names an `engagements.id`. ──
  case: 100,
  project_kickoff: 100,
  package_session: 100,
  retainer_checkin: 100,
  // ── Request grain: the context names a `project_requests.id` /
  //    `request_expert_relationships.id`. Real, but out-ranked by an engagement. ──
  request_interaction: 50,
  project_discovery: 50,
  // ── No holder on this axis. ──
  admin: 0,
} as const;

/**
 * The seven `meeting_context_type` labels, DERIVED from the precedence map so the map is
 * total by construction.
 *
 * ⚠ THIS IS A RESTATEMENT OF A pgEnum IN A PACKAGE THAT CANNOT IMPORT IT, and it is pinned
 * rather than trusted: `apps/api`'s `authorize-meeting-participation.ts` carries a two-way
 * `AssertNever` against `@balo/db`'s `MeetingContextType`, so an EIGHTH label added to the
 * database fails `pnpm --filter api typecheck` until it is given a precedence here.
 */
export type MeetingContextTypeLabel = keyof typeof MEETING_CONTEXT_PRECEDENCE;

/**
 * The six context types that CAN have a holder on the engagement axis — everything except
 * `admin`.
 *
 * ⚠ IT EXISTS SO `selectPrimaryMeetingContext`'s RESULT IS NARROWER THAN ITS ARGUMENT. The
 * rule drops `admin` (precedence 0), so a primary context can never be an admin one — and
 * saying that in the TYPE is what lets the caller's `switch` over the six be exhaustive with
 * a `never` default. Typing the result as a union that still admitted `admin` made that arm
 * reachable in the type system but dead at runtime, i.e. unprovable dead code that
 * SonarCloud counts as uncovered changed lines.
 *
 * ⚠ THERE IS DELIBERATELY NO EXPORTED `MeetingContextSubject` UNION HERE. One existed and
 * had no caller: every consumer takes {@link PrimaryMeetingContext} (the narrowed winner),
 * and the `admin`-with-null-id arm it modelled is precisely the shape this rule refuses to
 * produce. `apps/api`'s `EngagementHostSubject` remains the type that models both arms, at
 * the seam that genuinely has to accept both.
 */
export type MeetingContextTypeWithHolder = Exclude<MeetingContextTypeLabel, 'admin'>;

/**
 * The winner of the precedence rule: a context type that can have a holder, plus its
 * NON-NULL id. Structurally assignable to `apps/api`'s `EngagementHostSubject` — which is
 * deliberate, so this result goes straight into `hasEngagementCapability`'s third argument
 * without a cast or a re-shape.
 */
export interface PrimaryMeetingContext {
  readonly contextType: MeetingContextTypeWithHolder;
  readonly contextId: string;
}

/** What a `meeting_contexts` row looks like to this rule — nothing else is read. */
export interface MeetingContextRowLike {
  readonly contextType: MeetingContextTypeLabel;
  readonly contextId: string | null;
}

export type SelectPrimaryMeetingContextResult =
  | { readonly ok: true; readonly context: PrimaryMeetingContext }
  | { readonly ok: false; readonly reason: 'none' | 'ambiguous' };

/**
 * Reduce a meeting's context rows to the ONE that governs it, or say why it cannot be done.
 *
 *   · `none`      — no context carries a holder (empty, `admin`-only, or every row
 *                   malformed). The caller answers `404`.
 *   · `ambiguous` — two or more DISTINCT subjects tie at the top precedence tier. The
 *                   caller answers `409 meeting_context_ambiguous`. FAIL-CLOSED: picking one
 *                   arbitrarily would hand host rights to whichever row sorted first.
 *
 * ⚠ AMBIGUITY IS JUDGED ON THE TOP TIER ONLY. A `case` alongside a `project_discovery` is
 * NOT ambiguous — that is precisely the shape precedence exists to resolve. Two `case`
 * contexts on one meeting IS.
 *
 * ⚠ EXACT DUPLICATES ARE NOT AMBIGUOUS. `meeting_context_unique_idx` is unique on the
 * triple `(meeting_id, context_type, context_id)` so the database cannot produce them, but
 * de-duplicating by identity rather than counting rows means a caller that concatenated two
 * reads gets the right answer instead of a spurious `409`.
 *
 * ⚠ A NON-`admin` ROW WITH A NULL `context_id` IS DROPPED, NOT PROMOTED. The DB CHECK makes
 * it unrepresentable; if one ever appears it is a corrupt row, and a corrupt row must not
 * become a subject that `resolveHostContext` would then query. Dropping every row this way
 * yields `none`, which denies — the fail-closed direction.
 */
export function selectPrimaryMeetingContext(
  contexts: readonly MeetingContextRowLike[]
): SelectPrimaryMeetingContextResult {
  const candidates: PrimaryMeetingContext[] = [];
  for (const row of contexts) {
    // `admin` scores 0 — no holder on this axis, so it can never be primary. Narrowing by
    // the LABEL (rather than by the score) is what proves to the type system that everything
    // reaching `candidates` is a `MeetingContextTypeWithHolder`.
    if (row.contextType === 'admin') continue;
    // Defensive: the CHECK makes this unrepresentable. Drop, never promote.
    if (row.contextId === null) continue;
    candidates.push({ contextType: row.contextType, contextId: row.contextId });
  }

  if (candidates.length === 0) {
    return { ok: false, reason: 'none' };
  }

  let topScore = 0;
  for (const candidate of candidates) {
    const score = MEETING_CONTEXT_PRECEDENCE[candidate.contextType];
    if (score > topScore) topScore = score;
  }

  const winners = candidates.filter(
    (candidate) => MEETING_CONTEXT_PRECEDENCE[candidate.contextType] === topScore
  );

  // De-duplicate by IDENTITY, not by row count — see the exact-duplicates note above.
  const distinct = new Map<string, PrimaryMeetingContext>();
  for (const winner of winners) {
    distinct.set(`${winner.contextType}:${winner.contextId}`, winner);
  }
  if (distinct.size > 1) {
    return { ok: false, reason: 'ambiguous' };
  }

  const [primary] = [...distinct.values()];
  // `distinct.size === 1` above guarantees this, but `noUncheckedIndexedAccess` is on and
  // the house rule is to narrow by destructure + guard, never with `!`.
  if (primary === undefined) {
    return { ok: false, reason: 'none' };
  }
  return { ok: true, context: primary };
}

/**
 * ⚠⚠ THE PRIMARY-CONTEXT STABILITY PREDICATE (BAL-469). A writer may make a meeting's
 * primary context go from `none`/`ambiguous` to `ok` (ESTABLISHING), and it may make it go
 * from `ok` to `ambiguous` (DISSOLVING). It may NEVER make it go from `ok` context P to `ok`
 * context Q where Q differs from P — that is a REPOINT, and `meetingContextsRepository.attach`
 * refuses it.
 *
 * ⚠ `ambiguous` AND `none` ARE DELIBERATELY NOT REPOINTS, ON EITHER SIDE — BUT NOT BECAUSE
 * EVERY CONSUMER FAILS CLOSED ON THEM. THAT IS NOT TRUE, AND IT IS NOT THE REASON. The
 * accurate claim is narrower: no consumer of {@link selectPrimaryMeetingContext} GRANTS MORE
 * on `ambiguous` than it would on `ok` — which is sufficient to make establishing/dissolving
 * safe, without needing every consumer to deny outright.
 *
 * The seven AUTHORIZATION gates really do fail closed on a non-`ok` result:
 * `resolveClientCompaniesForMeetings` omits the meeting, `authorizeMeetingParticipation`
 * denies `ambiguous_context`, `joinMeeting` denies `context_ambiguous`, and so on for meeting
 * files, recap access and the chat anchor.
 *
 * ⚠⚠ THE NAMED EXCEPTION. `deliveringExpertProfileIdForMeeting`
 * (`apps/api/src/services/meetings/delivering-party.ts`) does NOT deny on `ambiguous` — it
 * folds it into the same `null` its own docblock defines as "this meeting has no delivering
 * identity", which is a WRONG FACT, not a denial. That composes into `partyForUser`
 * (`apps/api/src/services/meetings/presence-writer.ts`), a BILLING INPUT: on an ambiguous
 * meeting BOTH its arms miss (the participation gate denies; the delivering-expert fallback
 * reads the same ambiguity-blind `null`), so every authenticated participant — delivering
 * expert included — is recorded `party: 'observer'`. That silently arms the missed-call sweep
 * and the missed-call settlement path on a meeting where people are actually present.
 * `apps/api/src/jobs/meeting-lifecycle-sweep.ts`'s `contextType: 'unknown'` dimension is a
 * second, lower-stakes non-denying consumer (it still arms its alert; only the label degrades).
 *
 * ⚠ THIS MEANS AMBIGUITY ON A **BOOKED** MEETING IS A REAL AVAILABILITY HAZARD, PRE-EXISTING
 * AND **NOT CLOSED BY BAL-469**. `attach` could always produce `ambiguous`; this ticket does
 * not change that it can, only refuses a REPOINT. Closing the billing-input exception is the
 * delivering-party ambiguity follow-up, BAL-471 — which must land before whatever ticket gives
 * `attach` its first production caller. ⚠ NOT BAL-410 OR BAL-411: both have SHIPPED and neither
 * calls `attach` or `detach` (cancel flips `meetings.status` and leaves the context rows alone).
 *
 * ⚠ THIS IS WHY, ACROSS A SINGLE `attach` CALL, `meetingContextsRepository.attach` CANNOT
 * CHANGE THE COMPANY A MEETING NAMES. The company a meeting resolves to is a pure function of
 * its primary context (`selectPrimaryMeetingContext` → `resolveContextOwner`), and `attach`
 * writes none of the tables that function reads. So refusing a repoint of the CONTEXT is
 * sufficient to refuse a repoint of the COMPANY for that one call, without this predicate — or
 * `attach` — ever reading a company row. `detach` is a SEPARATE writer of `meeting_contexts`
 * and is NOT guarded by this predicate at all — see `detach`'s own docblock in
 * `packages/db/src/repositories/meeting-contexts.ts` for the two sequences (a bare detach of
 * the current winner, and an attach-to-ambiguous followed by a detach of the original winner)
 * that reach the exact company flip a single `attach` refuses. Also: this predicate secures
 * the ANCHOR, not MEMBERSHIP — `listMeetingsForContext` matches any live context row
 * regardless of tier, so an `attach` that only ESTABLISHES or DISSOLVES can still hand the
 * attacker a read of a victim meeting's join credentials through a lower-tier context they
 * legitimately own underneath the victim's primary; that is the caller's `hasCapability`
 * obligation, not something this predicate closes.
 *
 * ⚠ IT READS {@link MEETING_CONTEXT_PRECEDENCE} ONLY THROUGH {@link selectPrimaryMeetingContext},
 * NEVER BY COMPARING TIERS ITSELF. A raw tier comparison gives the wrong answer for an
 * `admin`-only meeting establishing its first real context: `admin` scores 0 and is dropped
 * from the candidate set entirely (never scored, never returned), so `none → ok` would look
 * like a tier RAISE under a bare "did the top tier increase?" test — which is exactly the
 * establishing case this predicate must allow. Going through the real selection function is
 * what keeps `none`/`ambiguous` handled identically here and at every other call site.
 */
export function findPrimaryMeetingContextRepoint(
  before: readonly MeetingContextRowLike[],
  after: readonly MeetingContextRowLike[]
): { readonly from: PrimaryMeetingContext; readonly to: PrimaryMeetingContext } | null {
  const beforeResult = selectPrimaryMeetingContext(before);
  const afterResult = selectPrimaryMeetingContext(after);
  if (!beforeResult.ok || !afterResult.ok) {
    return null;
  }
  const { context: from } = beforeResult;
  const { context: to } = afterResult;
  if (from.contextType === to.contextType && from.contextId === to.contextId) {
    return null;
  }
  return { from, to };
}

// ── D7: THE MONEY RULE ────────────────────────────────────────────────────────────────

/**
 * ⚠⚠ THE MONEY RULE. The `meeting_presence.party` a GUEST row maps to.
 *
 *   client → client        (the client party is genuinely represented)
 *   expert → **observer**  (present, but NEVER on the billable clock)
 *
 * WHY AN EXPERT-SIDE GUEST MUST NOT BE `'expert'`, in numbers rather than in principle.
 * `computeMeetingClocks` derives `expertPresentMs` — and ANCHORS `billableMs` — from
 * `party='expert'` rows as GAP-INCLUSIVE SPANS: the FIRST expert-party join opens the clock
 * and the LAST expert-party presence closes it. So on a 60-minute call where an agency
 * colleague sits in 0→60 while the DELIVERING expert is present only 10→20:
 *
 *   · written as `'expert'`  → expertPresentMs = 60 min, and the billable span is anchored
 *                              on the GUEST. **The client is billed for a guest's time.**
 *   · written as `'observer'`→ expertPresentMs = 10 min, billable = the real overlap.
 *
 * The first outcome directly violates the AC "billing unaffected — per-minute of expert
 * time, never per-seat". `observer` was declared for exactly this class of attendee and is
 * excluded from BOTH sides of the billable intersection by construction.
 *
 * A CLIENT-side guest DOES map to `client`, and that is not an oversight: the client party
 * is really in the room, so the billable intersection should legitimately continue if the
 * booker drops but their colleague stays.
 *
 * ── THE SECOND ARM: A `link`-CHANNEL GUEST IS **ALWAYS** AN OBSERVER (BAL-132) ───────────
 *
 * ⚠⚠ A SELF-CLAIMED LOBBY VISITOR'S `party` IS A PLACEHOLDER, NOT A RESOLVED SIDE, SO IT
 * MUST NEVER ANCHOR MONEY. `meeting_guests.party` is NOT NULL and CHECK-narrowed to
 * `client | expert`, and a bare meeting URL carries NO sharer identity — there is no
 * server-side signal for which side a knock is on. BAL-132's `claimLobbyPlace` therefore
 * writes `client` because the column demands *a* value, not because anybody resolved one.
 *
 * Left unhandled, that placeholder is a REAL over-billing path and not a theoretical one:
 * `computeMeetingClocks` anchors `billableMs` on the first instant an `expert` row and a
 * `client` row overlap. An expert-side colleague who was forwarded the link, knocked, and
 * was admitted would be stored `party='client'` — so on a 60-minute call where the real
 * client left at minute 10, that person sitting in the room to minute 60 keeps the billable
 * span open to 60. **The client company is billed for the expert's own colleague's time.**
 * Mapping the whole `link` channel to `observer` closes it by construction: `observer` is
 * excluded from BOTH sides of the billable intersection.
 *
 * ⚠ THE CHANNEL ARGUMENT IS **NON-OPTIONAL**, AND THAT IS THE ENFORCEMENT — NOT THE
 * DOCBLOCK. An optional parameter defaulting to the old one-argument behaviour would let
 * BAL-134's writer call this and receive a silently WRONG answer, which is precisely the
 * failure this exists to prevent; the whole point of putting the rule in the shared pure
 * function is that the writer cannot MISS it. An input object rather than a positional pair
 * so the two same-shaped string arguments can never be transposed at a call site.
 *
 * ⚠ AN `email`-CHANNEL ROW IS UNAFFECTED. Its `party` WAS resolved — server-side, from the
 * inviter's own authorized side (`authorizeMeetingParticipation`) — so the original rule
 * still governs it exactly as before, including the deliberate `client → client` arm.
 *
 * ⚠ THE ORDER OF THE TWO ARMS IS IRRELEVANT TO THE ANSWER AND DELIBERATE FOR READING: both
 * `link` arms yield `observer`, so `link` + `expert` is `observer` either way. The channel
 * is tested FIRST because it is the stronger statement — "we never resolved a side at all"
 * dominates "the side we resolved was the expert's".
 *
 * ⚠⚠ THE SECOND CHANNEL-FIRST RULE IN THIS MODULE IS {@link projectGuestForViewer}'s `link`
 * ARM (BAL-436), AND THE TWO SHOULD BE READ TOGETHER. Both start from the same premise — a
 * `link` row's `party` is a NOT-NULL PLACEHOLDER, not a resolved side — and both refuse to
 * derive anything from it: this one refuses to derive MONEY, that one refuses to derive
 * SAME-PARTY ENTITLEMENT. Adding a third label to `MeetingGuestInviteChannelLabel` means
 * deciding which side of BOTH rules it falls on.
 *
 * ⚠ THE WRITE IS BAL-134'S, AND THIS IS ITS CONTRACT. Every guest presence row must derive
 * `party` through this function — never from the guest row's own `party` column — and must
 * set `meeting_guest_id`, never `user_id`. The same assignment is written on
 * `meeting_presence`'s docblock. All THREE clock scenarios above are pinned as NUMBERS in
 * `index.test.ts` so this paragraph cannot drift from the behaviour.
 */
export function presencePartyForGuest(
  guest: Readonly<{
    /**
     * ⚠ AS STORED on `meeting_guests.party` — which, on a `link` row, is a placeholder the
     * function below deliberately ignores.
     */
    party: MeetingGuestSide;
    /** ⚠ AS STORED on `meeting_guests.invite_channel`. NEVER taken from request input. */
    inviteChannel: MeetingGuestInviteChannelLabel;
  }>
): MeetingPresenceParty {
  if (guest.inviteChannel === 'link') {
    return 'observer';
  }
  return guest.party === 'expert' ? 'observer' : guest.party;
}

// ── D6: the recorded grant's read predicate (BAL-388 enforces) ────────────────────────

export interface GuestMayReadMeetingInput {
  /** The grant AS RECORDED at invite time — never re-derived from `party_domains`. */
  readonly guestAccessScope: GuestAccessScopeLabel;
  /** The meeting the guest was invited to (`meeting_guests.meeting_id`). */
  readonly guestMeetingId: string;
  /** The meeting whose artefacts are being read. */
  readonly targetMeetingId: string;
  /**
   * Whether the target meeting shares the guest's ENGAGEMENT envelope. The CALLER resolves
   * this (via `meeting_contexts`); this predicate deliberately does no I/O.
   */
  readonly targetSharesGuestEngagement: boolean;
}

/**
 * May a guest read `targetMeetingId`'s artefacts, given the scope recorded on their row?
 *
 *   `meeting`    → only the one meeting they were invited to.
 *   `engagement` → that meeting, OR any meeting in the same engagement envelope.
 *
 * ⚠ **RETROSPECTIVE: THERE IS NO DATE COMPARISON ANYWHERE IN HERE, AND THAT IS THE
 * DECISION.** An `engagement`-scoped guest reads consultations held BEFORE they were
 * invited. That is why the invite UI carries an explicit disclosure sentence and why the
 * scope is computed once at invite time and STORED — informed consent is the whole
 * mitigation, so a later `party_domains` change must not silently widen or narrow a grant
 * the inviter agreed to in different terms. Adding a `>= invitedAt` clause here would
 * quietly break the grant the disclosure promised.
 *
 * ⚠ **BAL-408 RECORDED THE GRANT; BAL-445 ENFORCES THE READ.** This function is called from
 * `authorizeMeetingFileAccess`'s guest arm (`apps/web/src/lib/meetings/authorize-meeting-file-access.ts`)
 * for meeting files, and its conversation-grain sibling `resolveGuestConversationScope` is
 * called from `meeting-chat-anchor.ts` for in-call chat. **BAL-439 enforces the recap read
 * through that SAME guest arm** — its `resolve-guest-recap-access.ts` gate composes
 * `authorizeMeetingFileAccess` rather than calling this predicate directly, so "who may read
 * this meeting" still has exactly one definition. Transcripts (BAL-387) stay closed to a
 * guest — this is where that closure stays recorded. Callers supply the subject; they must
 * NOT re-derive this rule.
 */
export function guestMayReadMeeting(input: GuestMayReadMeetingInput): boolean {
  if (input.guestMeetingId === input.targetMeetingId) {
    return true;
  }
  return input.guestAccessScope === 'engagement' && input.targetSharesGuestEngagement;
}

/**
 * BAL-445 fix-round-1 (F1) — is this guest HOLDING A SEAT, as opposed to merely having
 * KNOCKED? `pending` is a lobby knock, not a grant: `claimLobbyPlace`
 * (`apps/api/src/services/meetings/join-meeting.ts`) is DELIBERATELY UNAUTHENTICATED and
 * mints a live `meeting_guests` row with `admission: 'pending'` for anyone holding only a
 * forwarded `/join/m/{meetingId}` URL. `meetingGuestsRepository.findLiveByTokenHash` resolves
 * `pending` rows on purpose — the `/join/[token]` landing and `pollGuestAdmissionAction` both
 * legitimately need to render the waiting card for a not-yet-admitted guest — but a READ must
 * answer a stricter question than "does a live row exist": `meeting-guests.ts`'s own words are
 * *"`admission IN ('pre_admitted','admitted')` is the positive form of the rule … Waiting is
 * not holding, and being refused is not holding."*
 *
 * ⚠ THIS IS THE SHARED PURE FORM OF `apps/api`'s `ADMITTED_STATES`
 * (`join-meeting.ts:195,862`, `new Set(['pre_admitted', 'admitted'])`), which gates the Daily
 * meeting-token mint (entry to the room). This function gates READS instead (files, in-call
 * chat) from `apps/web`, which never calls into `apps/api`'s service layer. Two call sites,
 * one rule, restated here because R6 forbids sharing code across the `apps/api`/`apps/web`
 * boundary for this domain — do not write a THIRD expression of "admitted" anywhere else.
 */
export function guestIsAdmittedForRead(admission: MeetingGuestAdmissionLabel): boolean {
  return admission === 'pre_admitted' || admission === 'admitted';
}

// ── §8: counterparty concealment ──────────────────────────────────────────────────────

/** A live guest row, reduced to what a roster read may consider. */
export interface GuestForProjection {
  readonly id: string;
  readonly email: string;
  readonly emailDomain: string | null;
  readonly name: string | null;
  readonly party: MeetingGuestSide;
  readonly participationRole: MeetingParticipationRoleLabel;
  readonly accessScope: GuestAccessScopeLabel;
  readonly admission: MeetingGuestAdmissionLabel;
  /** ⚠ AS STORED on `meeting_guests.invite_channel`. NEVER taken from request input. */
  readonly inviteChannel: MeetingGuestInviteChannelLabel;
  /** `meeting_guests.admission_decided_at` — non-null only on a decided row. */
  readonly admissionDecidedAt: Date | null;
}

/**
 * What a viewer of a given party is allowed to see about one guest.
 *
 * ⚠ THE CROSS-PARTY FIELDS ARE **OPTIONAL BY ABSENCE**, never `null`. See
 * `projectGuestForViewer`.
 */
export interface GuestForViewer {
  readonly id: string;
  /** ⚠ SAME-PARTY ONLY. Absent — not null — on a cross-party projection. */
  readonly email?: string;
  /** ⚠ SAME-PARTY ONLY. A domain is a de-anonymiser; it travels with the address. */
  readonly emailDomain?: string;
  /** Names cross the boundary. */
  readonly name: string | null;
  /** Always safe: what to render when `name` is null. See the `'Guest'` note below. */
  readonly displayName: string;
  readonly party: MeetingGuestSide;
  readonly participationRole: MeetingParticipationRoleLabel;
  readonly admission: MeetingGuestAdmissionLabel;
  /** ⚠ SAME-PARTY ONLY. `engagement` encodes a DOMAIN MATCH — a fact about the address. */
  readonly accessScope?: GuestAccessScopeLabel;
  /**
   * BAL-436 — HOW the row was created. ⚠ PRESENT FOR **EVERY** VIEWER OF EVERY ROW, and that
   * is argued rather than assumed.
   *
   * The projection rule conceals FACTS ABOUT THE ADDRESS — the address itself, its domain,
   * and `accessScope` (which is a predicate over that domain). `invite_channel` is a fact
   * about PROVENANCE: somebody with rights named an address (`email`), or somebody arrived
   * holding the link (`link`). It reveals no address, no domain and no predicate over one.
   * The same discriminator is already published to PostHog on `guest_admitted` /
   * `guest_denied` for the identical reason.
   *
   * ⚠ IT IS THE **ONLY** INPUT TO A CONSUMER'S "UNVERIFIED" TREATMENT, AND IT MUST NOT BE
   * DERIVED FROM `admission` INSTEAD. Today the mapping happens to be 1:1 (`pre_admitted` ⇔
   * `email`) only because exactly two writers exist. BAL-134's trust-by-default work could
   * legitimately route an email invitee through the queue, at which point the derivation
   * would silently invert — the badge would vanish from the rows that need it and appear on
   * rows that do not. A security affordance must not rest on a coincidence of the writer set.
   */
  readonly inviteChannel: MeetingGuestInviteChannelLabel;
  /**
   * BAL-436 — when a host decided this row, ISO 8601.
   *
   * ⚠ OMITTED (not `null`) WHEN THE COLUMN IS NULL, matching this interface's own
   * optional-by-absence rule. It is non-null only on a row a host has actually decided on,
   * and it exists so a consumer can time a grace period against a SERVER instant rather than
   * a client clock that restarts on every panel open and every tab reload.
   */
  readonly admissionDecidedAt?: string;
}

/**
 * ⚠⚠ THE PROJECTION RULE: **NAMES CROSS THE PARTY BOUNDARY. EMAIL ADDRESSES NEVER.**
 *
 * A client member may see that the expert brought a colleague called Sam; they may not
 * learn Sam's address, Sam's employer's mail domain, or whether Sam's address matched a
 * registered domain. The reverse holds identically.
 *
 * ⚠ CROSS-PARTY FIELDS ARE **OMITTED, NOT NULLED**, and the distinction is load-bearing
 * rather than stylistic. `JSON.stringify` drops an absent key entirely, so the wire payload
 * carries no `"email": null` for a future client to render as an empty placeholder, no
 * column to leave visible-but-blank, and no shape that invites `guest.email ?? '—'`. The
 * tests assert KEY ABSENCE (`'email' in projected === false`), never `=== null`.
 *
 * ⚠ `displayName` FALLS BACK TO THE LITERAL `'Guest'` ACROSS THE BOUNDARY — never to
 * `email.split('@')[0]`, which is the obvious convenience and which leaks the local part of
 * the very address this rule exists to conceal. Same-party viewers get the address as the
 * fallback, which is what they can already see.
 *
 * ⚠ `accessScope` IS CONCEALED FOR A NON-OBVIOUS REASON, so it is stated: it is not
 * sensitive in itself, but `engagement` is set IFF the address matched one of the client
 * company's registered `party_domains`. Publishing it cross-party is publishing a predicate
 * over the hidden address.
 *
 * ── ⚠⚠ BAL-436 — THE `link` CHANNEL SHORT-CIRCUITS THE PARTY RULE, AND IT GOES FIRST ───────
 *
 * See the arm's own comment below. It is a NARROWING of ADR-1044's counterparty-concealment
 * rule (strictly LESS data crosses than before) plus one provenance field, and it mirrors
 * {@link presencePartyForGuest}'s channel-first ordering for the same stated reason.
 */
export function projectGuestForViewer(
  guest: GuestForProjection,
  viewerParty: MeetingGuestSide
): GuestForViewer {
  const base = {
    id: guest.id,
    name: guest.name,
    party: guest.party,
    participationRole: guest.participationRole,
    admission: guest.admission,
    inviteChannel: guest.inviteChannel,
    // Absent rather than null when the column is null — the same optional-by-absence rule the
    // cross-party fields follow. A key that is present always means "here is a real value".
    ...(guest.admissionDecidedAt === null
      ? {}
      : { admissionDecidedAt: guest.admissionDecidedAt.toISOString() }),
  } as const;

  /*
    ⚠⚠ THE `link` CHANNEL SHORT-CIRCUITS THE PARTY RULE, FOR THE SAME ONE REASON THE MONEY
    RULE DOES (see `presencePartyForGuest`): a `link` row's `party` is a NOT-NULL PLACEHOLDER,
    not a resolved side. `claimLobbyPlace` writes `client` because the column demands *a*
    value, not because anybody resolved one — so SAME-PARTY ENTITLEMENT, which is DERIVED from
    a resolved side, is meaningless on this row. The entitled set is therefore EMPTY: `email`,
    `emailDomain` and `accessScope` are omitted for EVERY viewer, and `displayName` NEVER
    falls back to the address.

    Three concrete defects this closes, all reachable on `main` before BAL-436:
      1. A CLIENT-side host viewing an anonymous knocker who typed no name rendered
         `displayName` EQUAL TO THE SELF-DECLARED ADDRESS — presenting an unverified,
         attacker-chosen string as the person's name, on the very surface where a host decides
         whether to let a stranger into a live call.
      2. An EXPERT-side host viewing the SAME row fell to the cross-party arm and saw
         `'Guest'`. Two hosts of one meeting saw two different identities for one stranger.
      3. An unrelated CLIENT-side member — not a host at all — read that stranger's typed
         address, purely because the placeholder happened to match their side.

    ⚠ WITHHOLDING THE ADDRESS COSTS THE HOST NOTHING REAL. It is exactly as attacker-chosen as
    the name, so showing it does not raise confidence honestly — it MANUFACTURES confidence,
    which is the social-engineering vector this arm exists to remove. The host decides on the
    self-declared NAME plus the consumer's UNVERIFIED framing, which is what "a decision about
    a stranger at the door" actually is.

    ⚠ AN `email`-CHANNEL ROW IS UNTOUCHED. Its `party` WAS resolved server-side from the
    inviter's own authorized side (`authorizeMeetingParticipation`), so the original rule still
    governs it byte for byte, including the same-party `email` / `emailDomain` / `accessScope`
    fields and the address fallback on `displayName`.
  */
  if (guest.inviteChannel === 'link') {
    return { ...base, displayName: guest.name ?? 'Guest' };
  }

  if (guest.party !== viewerParty) {
    return { ...base, displayName: guest.name ?? 'Guest' };
  }

  return {
    ...base,
    email: guest.email,
    // Absent rather than null when the column is null, so the key's presence always means
    // "you are entitled to this and here it is".
    ...(guest.emailDomain === null ? {} : { emailDomain: guest.emailDomain }),
    displayName: guest.name ?? guest.email,
    accessScope: guest.accessScope,
  };
}
