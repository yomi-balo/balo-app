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
 *   · `presencePartyForGuest` — THE MONEY RULE. See its docblock; getting this wrong bills
 *     a client for a guest's time.
 *   · `guestMayReadMeeting` — the retrospective read predicate. BAL-408 RECORDS the grant;
 *     **BAL-388 must call this to ENFORCE it.**
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
 * ⚠ THE WRITE IS BAL-134'S, AND THIS IS ITS CONTRACT. Every guest presence row must derive
 * `party` through this function — never from the guest row's own `party` column — and must
 * set `meeting_guest_id`, never `user_id`. The same assignment is written on
 * `meeting_presence`'s docblock. Both clock scenarios above are pinned as NUMBERS in
 * `index.test.ts` so this paragraph cannot drift from the behaviour.
 */
export function presencePartyForGuest(guestParty: MeetingGuestSide): MeetingPresenceParty {
  return guestParty === 'expert' ? 'observer' : guestParty;
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
 * ⚠ **BAL-408 RECORDS THE GRANT; IT DOES NOT ENFORCE THE READ.** Nothing in this PR calls
 * this function on a production path — the surfaces that would (the recap is BAL-388;
 * transcripts BAL-387 and action items BAL-391 ship inert) do not exist for a guest, and
 * there is no guest-authenticated read session anywhere. **BAL-388 MUST CALL THIS** rather
 * than re-derive the rule. It ships pure and tested for exactly that reason.
 */
export function guestMayReadMeeting(input: GuestMayReadMeetingInput): boolean {
  if (input.guestMeetingId === input.targetMeetingId) {
    return true;
  }
  return input.guestAccessScope === 'engagement' && input.targetSharesGuestEngagement;
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
  } as const;

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
