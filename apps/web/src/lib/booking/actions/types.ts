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
export type BookingStage = 'validation' | 'company' | 'case' | 'meeting';

export type BookingFailureCode =
  | 'invalid_request'
  | 'company_selection_required'
  | 'company_not_eligible'
  | 'no_eligible_company'
  | 'case_not_available'
  | 'slot_unavailable'
  | 'rate_limited'
  | 'idempotency_key_conflict'
  | 'booking_failed';

export type BookConsultationResult =
  | {
      ok: true;
      engagementId: string;
      meetingId: string;
      /** `/join/m/{meetingId}` — NEVER the raw Daily url (`meetings.join_url` never crosses). */
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
    };
