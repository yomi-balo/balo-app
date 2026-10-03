/**
 * BAL-400 — `bookConsultationAction`'s wire types. Kept in a SIBLING, non-`'use server'`
 * module because `book-consultation.ts` is `'use server'`, and a `'use server'` module may
 * export ONLY async functions (memory `reference_use_server_no_value_exports`) — a `export
 * type`/`export interface` compiles clean under tsc/eslint/vitest and fails ONLY `next build`,
 * and only once it is reached from the client graph.
 */

export interface BookConsultationInput {
  expertProfileId: string;
  slot: {
    startIso: string;
    endIso: string;
    durationMinutes: 15 | 30 | 45 | 60;
  };
  /** Client-minted `crypto.randomUUID()`, stable across "Try again" retries (Decision 1). */
  bookingNonce: string;
  guests: ReadonlyArray<{ email: string; name?: string }>;
  caseChoice:
    | {
        kind: 'new';
        title: string;
        descriptionHtml: string;
        productIds: readonly string[];
        /** Only meaningful when the actor has >1 eligible company (Decision 5). */
        companyId?: string;
      }
    | { kind: 'existing'; engagementId: string };
}

/** Which hop failed — surfaces which panel the wrapper renders. */
export type BookingStage = 'validation' | 'company' | 'case' | 'funding' | 'meeting';

export type BookingFailureCode =
  | 'invalid_request'
  | 'company_selection_required'
  | 'company_not_eligible'
  | 'no_eligible_company'
  | 'case_not_available'
  | 'slot_unavailable'
  | 'rate_limited'
  | 'idempotency_key_conflict'
  /**
   * BAL-478 — the paying company has neither an active payment mandate nor enough available
   * credit to cover this consultation, AND the booker holds MANAGE_BILLING, so they can fix it
   * themselves at `/settings/billing`.
   *
   * ⚠ NOT AN ERROR AND NOT A REJECTION. Nothing was written (the gate runs before the only
   * write) and nothing is wrong with the slot, the case or the session. The panel must read as
   * a solvable setup step.
   */
  | 'funding_setup_required'
  /**
   * BAL-478 — the same condition, for a booker who does NOT hold MANAGE_BILLING (the ordinary
   * case: booking needs CONSUME_CREDITS, adding a card needs MANAGE_BILLING).
   *
   * ⚠ ITS OWN CODE SO THE PANEL NEVER OFFERS A DEAD-END CTA (R6). `/settings/billing` would
   * refuse this actor. The panel instead states that the company's billing admins were told —
   * which is TRUE by construction: `enforceBookingFunding` publishes
   * `booking.funding_blocked` at the moment it determines the zero-arm, before returning.
   */
  | 'funding_admins_notified'
  /**
   * BAL-474 (D6.1) — the paying company has an open receivable (its soft account hold), which
   * refuses a NEW Case booking until a top-up clears it, AND the booker holds MANAGE_BILLING, so
   * they can top up themselves. Mirrors `funding_setup_required`: nothing is wrong with the slot,
   * the case or the session, and the panel reads as a solvable step. Consultations already booked
   * are unaffected. The failure's `balance` names the figure and the company.
   */
  | 'hold_top_up_required'
  /**
   * BAL-474 (D6.1) — the same hold, for a booker who does NOT hold MANAGE_BILLING. Mirrors
   * `funding_admins_notified`: its own code so the panel never offers a dead-end Top-up, and its
   * promise ("your billing admins have been notified") is kept by `enforceBookingFunding`, which
   * publishes `booking.funding_blocked` before it returns.
   */
  | 'hold_admins_notified'
  /**
   * BAL-474 (D6.5) — a company WITHOUT an active mandate cannot book past its credit once its
   * planned consultations are set aside, AND the booker holds MANAGE_BILLING. A check-time soft
   * reservation, not a ledger hold: the balance still shows in full. The failure's `balance`
   * carries the figure and the COUNT of planned consultations.
   */
  | 'reserved_top_up_required'
  /** BAL-474 (D6.5) — the same reservation refusal, for a booker without MANAGE_BILLING. */
  | 'reserved_admins_notified'
  /**
   * The viewer's WorkOS credential is dead — not a refusal of the booking itself.
   *
   * ⚠ Its own code so it can never be reported as a slot problem: nothing is wrong with the
   * slot, and a "Try again" would re-send the same dead token. Account suspension/deletion also
   * arrives as a 401 and is deliberately not folded in (see `isExpiredCredentialFailure`).
   */
  | 'session_expired'
  /**
   * A staff member is impersonating this account and tried to book on its behalf.
   *
   * ⚠ ITS OWN CODE, AND IT MUST NOT REACH THE SESSION-EXPIRED PANEL. An impersonated session
   * carries no `accessToken` at all (`startImpersonationAction` deletes both tokens so the
   * middleware can never re-seal it past its 30-minute deadline), so the credential pre-flight
   * reads it as dead and would otherwise offer "Sign in" — which signs the STAFF MEMBER in as
   * themselves and silently ends the impersonation. Nothing about that is a session that
   * expired, and no retry can change it.
   */
  | 'impersonation_refused'
  /**
   * The expert cannot take this booking: they have paused new work (a NEW case only) or the
   * account behind the profile is suspended or deleted (every booking). Nothing was written.
   *
   * ⚠ ONE CODE FOR EVERY REFUSAL, so the panel never tells a client which reason applied.
   * The panel offers a way to someone else, never a retry.
   */
  | 'expert_unavailable'
  | 'booking_failed';

/**
 * BAL-474 — what the balance panel needs to render a hold (D6.1) or a reservation (D6.5)
 * refusal. Present on a failure whose code is one of the four `hold_*` / `reserved_*` codes.
 *
 * ⚠ THE FIGURE IS A TOP-UP AMOUNT, never a debt. `topUpNeededMinor` is `null` ONLY on the hold
 * variant's failed-heal fallback (a covered hold the booking API could not clear) — the panel
 * then renders a truthful no-figure body, and nothing ever renders A$0.00. The reserved variant
 * always has a figure and a count.
 */
export interface BookingBalanceFailure {
  readonly variant: 'hold' | 'reserved';
  readonly topUpNeededMinor: number | null;
  /** `reserved` only — how many planned consultations set credit aside. A count, never money. */
  readonly reservedBookingCount: number | null;
  /** The company whose balance refused the booking — the Top-up action must target THIS one. */
  readonly company: {
    readonly id: string;
    /** `null` ⇒ the name read failed; the panel says "your team". */
    readonly name: string | null;
    /** True ⇒ already the active workspace, so Top-up needs no switch. */
    readonly isActive: boolean;
  };
}

export type BookConsultationResult =
  | {
      ok: true;
      engagementId: string;
      meetingId: string;
      /** `/meetings/{meetingId}/call` — the member route (BAL-567). NEVER the raw Daily url (`meetings.join_url` never crosses).  */
      joinPath: string;
      /** `false` ⇒ the Daily room did not come up yet; the booked state must not show a live link. */
      provisioned: boolean;
      isNewCase: boolean;
      caseTitle: string;
      /**
       * ⚠⚠ THE SERVER'S WINDOW (`meetings.scheduled_start`/`_end`), NOT the slot the client
       * submitted (S2). On Decision 7's idempotent replay the two diverge — the API returns
       * the meeting that already exists. Step 3, the toast and the `booking.confirmed`
       * payload MUST render these; rendering the local slot told both parties a time the
       * meeting is not at.
       */
      scheduledStartIso: string;
      scheduledEndIso: string;
      /** Derived from the two above — never the client's declared slot duration. */
      durationMinutes: number;
      guestsInvited: number;
      guestInviteFailed: boolean;
    }
  | {
      ok: false;
      stage: BookingStage;
      code: BookingFailureCode;
      /**
       * Present on a `stage: 'meeting'` failure (Decision 3/D4b) so the partial-failure panel
       * can offer "Try again" against the case that DOES already exist, rather than restarting
       * the whole flow.
       */
      engagementId?: string;
      caseTitle?: string;
      /**
       * BAL-474 — present iff `code` is a `hold_*` / `reserved_*` code. On a `stage: 'meeting'`
       * refusal (the API's pre-write funding guard answered after the case row was written)
       * `engagementId`/`caseTitle` ride along so the panel can say the case is saved.
       */
      balance?: BookingBalanceFailure;
    };
