import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { GENERIC_NO_CHARGE_COPY } from '@/components/billing/top-up/PayAction';
import {
  formatAud,
  formatAudShort,
  upcomingConsultationsLabel,
} from '@/lib/credit/display-constants';
import { BALANCE_PANEL_COPY, companyLabels, type CompanyLabels } from '../booking-error-panels';
import type { RefusedFundingView } from './funding-disposition';

/**
 * ⚠ UNCLEARED MJ CHECKPOINT (BAL-608 AC13). Every string in this module is placeholder copy
 * awaiting the owner's sign-off, EXCEPT the manager and heading strings of the reserved and hold
 * arms, which are {@link BALANCE_PANEL_COPY} (copy v2.1, owner-approved) and are read from it,
 * never retyped here.
 *
 * Copy rules held throughout: gender-neutral, no rate and no estimate (the only money named is
 * the top-up itself, and never on the setup arm), and nothing claims a billing admin was told
 * before the member has pressed Save.
 *
 * Cases for the owner to rule on at that sign-off:
 *  · {@link MEMBER_TAIL} / {@link MEMBER_TAIL_NO_DRAFT} after a SUBMIT-TIME refusal. The submit
 *    went through `enforceBookingFunding`, which has already told the billing admins, yet the
 *    member block re-rendered by that refusal still says "Save this booking and we'll let your
 *    billing admins know". No second notice goes out — Save's notice shares the gate's hourly
 *    `booking-funding:{company}:{booker}:{kind}:{hour}` correlationId and is deduped — so only
 *    the tense is in question.
 */

export interface FundingBlockCopy {
  readonly heading: string;
  readonly body: string;
}

const MEMBER_TAIL_LEAD = "Save this booking and we'll let your billing admins know.";

/** The sentence every member body ends with: it describes what Save does, in the future tense. */
export const MEMBER_TAIL = `${MEMBER_TAIL_LEAD} What you've typed stays on this device for when you come back.`;

/** The same tail where no draft is written (a booking on a case that is already chosen). */
export const MEMBER_TAIL_NO_DRAFT = MEMBER_TAIL_LEAD;

/** The stage text the funding block announces and shows while a top-up runs. */
export const FUNDING_STAGE_COPY = {
  processing: 'Processing payment…',
  awaiting_credit: 'Adding to balance…',
  booking: 'Booking…',
} as const;

/** Toast when a re-read shows the balance now covers a booking the submit had refused. */
export const BALANCE_NOW_COVERS_COPY =
  'Your balance now covers this booking — press Confirm & book.';

/** Toast when the details restored from this device are cleared. */
export const DRAFT_CLEARED_COPY = 'Cleared what was saved on this device.';

/** What a landed top-up is, for the failure panels that follow it. */
function topUpLandedLine(creditedMinor: number, companyName: string | null): string {
  const co = companyLabels(companyName);
  return `Your top-up went through and ${formatAud(creditedMinor)} is in ${co.mid} balance.`;
}

/** The hard-failure panel body after a top-up landed: it never claims nothing was charged. */
export function fundedHardFailureBody(creditedMinor: number, companyName: string | null): string {
  return `We couldn't finish your booking. ${topUpLandedLine(creditedMinor, companyName)} Trying again won't charge you again.`;
}

/** The line under the partial-failure panel after a top-up landed. */
export function fundedPartialFollowUp(creditedMinor: number, companyName: string | null): string {
  return `${topUpLandedLine(creditedMinor, companyName)} Trying again won't charge you again.`;
}

/** The line under the session-expired panel after a top-up landed. */
export function fundedSessionFollowUp(creditedMinor: number, companyName: string | null): string {
  return `${topUpLandedLine(creditedMinor, companyName)} Sign in and you won't be charged again.`;
}

/** The body of the saved-for-later result, by whether the typed details were kept on this device. */
export function savedForLaterBody(
  companyName: string | null,
  expertFirstName: string | null,
  draftKept: boolean
): string {
  const party = companyLabels(companyName).mid;
  if (!draftKept) {
    return `We've told ${party} billing admins this booking is waiting on them.`;
  }
  return `We've told ${party} billing admins this booking is waiting on them. What you typed is saved on this device, so it'll be filled in when you book with ${expertFirstName ?? 'this expert'} again.`;
}

/** Under the pay button: the amount is charged in AUD whatever the client's card currency. */
export const FUNDING_AUD_LINE = "You'll be charged in AUD — your bank sets the final rate.";

/** Inline pay errors where nothing was charged; the rest keep the top-up composer's own copy. */
export const BOOKING_PAY_ERROR_COPY = {
  declined:
    'Your card was declined, so nothing was charged. Try a different card or check with your bank.',
  auth_failed:
    "Your bank didn't confirm the payment, so nothing was charged. Try again or use a different card.",
  settlement_outstanding: GENERIC_NO_CHARGE_COPY,
} as const;

/** The payment succeeded but the balance has not caught up yet. Never invites a second payment. */
export function creditPendingCopy(companyName: string | null): string {
  const co = companyLabels(companyName);
  return `Your payment went through and is being added to ${co.mid} balance. Press Book now to finish — you won't be charged again.`;
}

/** After the top-up landed but the time was taken: the money is kept, and the line says so. */
export function staleSlotTopUpFollowUp(creditedMinor: number, companyName: string | null): string {
  const co = companyLabels(companyName);
  return `Your top-up went through, so ${formatAud(creditedMinor)} is in ${co.mid} balance for the next time you choose.`;
}

type Audience = 'manager' | 'member';
type HoldArm = 'figure' | 'fallback';

interface CopyContext {
  readonly view: RefusedFundingView;
  readonly company: CompanyLabels;
  /** Whether Save keeps the typed details on this device. */
  readonly draftKept: boolean;
  /** The context the owner-approved {@link BALANCE_PANEL_COPY} functions take. */
  readonly balance: {
    readonly company: CompanyLabels;
    readonly amount: string;
    readonly maxTopUp: string;
    readonly count: string;
  };
}

type CopyFn = (context: CopyContext) => FundingBlockCopy;

function withMemberTail(heading: string, lead: string, draftKept: boolean): FundingBlockCopy {
  return { heading, body: `${lead} ${draftKept ? MEMBER_TAIL : MEMBER_TAIL_NO_DRAFT}` };
}

const MEMBER_SETUP_HEADING = 'A billing admin needs to set this up';

function holdArm(view: RefusedFundingView): HoldArm {
  return view.topUpNeededMinor === null ? 'fallback' : 'figure';
}

const COPY: Readonly<Record<RefusedFundingView['arm'], Readonly<Record<Audience, CopyFn>>>> = {
  setup: {
    manager: ({ view, company }) =>
      view.firstTime
        ? {
            heading: 'One setup step first',
            body: `Consultations are paid from ${company.mid} balance. Top up now and this one books straight after.`,
          }
        : {
            heading: `${company.start} balance needs a top-up for this one`,
            body: 'Top up now and this one books straight after.',
          },
    member: ({ company, draftKept }) =>
      withMemberTail(
        MEMBER_SETUP_HEADING,
        `Booking needs a payment method on file or enough credit in ${company.mid} balance, and only billing admins can add either.`,
        draftKept
      ),
  },
  reserved: {
    manager: ({ balance }) => ({
      heading: BALANCE_PANEL_COPY.reserved.heading.figure(balance),
      body: BALANCE_PANEL_COPY.reserved.body.manager.figure(balance),
    }),
    member: ({ balance, company, draftKept }) =>
      withMemberTail(
        BALANCE_PANEL_COPY.reserved.heading.figure(balance),
        `Part of ${company.mid} balance is set aside for ${balance.count}, so there isn't enough left to book this one, and only billing admins can top up.`,
        draftKept
      ),
  },
  hold: {
    manager: ({ view, balance }) => {
      const arm = holdArm(view);
      const { heading, body } = BALANCE_PANEL_COPY.hold;
      return {
        heading: (heading[arm] ?? heading.figure)(balance),
        body: (body.manager[arm] ?? body.manager.figure)(balance),
      };
    },
    member: ({ view, balance, company, draftKept }) => {
      const arm = holdArm(view);
      const { heading } = BALANCE_PANEL_COPY.hold;
      const lead =
        arm === 'fallback'
          ? `An earlier hold is still on ${company.mid} account, although the balance already covers it. It lifts automatically within a day, or at once with any top-up.`
          : `${company.start} balance needs a top-up of ${balance.amount} or more before new consultations can be booked, and only billing admins can top up.`;
      return withMemberTail((heading[arm] ?? heading.figure)(balance), lead, draftKept);
    },
  },
};

/**
 * The heading and body for the funding block, by arm and audience (a billing manager, or a
 * member who can only save the booking for later). `draftKept` says whether Save keeps the typed
 * details on this device, which a booking on an already-chosen case does not.
 */
export function fundingBlockCopy(view: RefusedFundingView, draftKept = true): FundingBlockCopy {
  const company = companyLabels(view.company.name);
  const figureMinor =
    view.arm === 'reserved'
      ? (view.topUpNeededMinor ?? view.suggestedTopUpMinor ?? 0)
      : (view.topUpNeededMinor ?? 0);
  const context: CopyContext = {
    view,
    company,
    draftKept,
    balance: {
      company,
      amount: formatAud(figureMinor),
      maxTopUp: formatAudShort(TOP_UP_LIMITS_MINOR.max),
      count: upcomingConsultationsLabel(view.reservedBookingCount ?? 0),
    },
  };
  return COPY[view.arm][view.canManageBilling ? 'manager' : 'member'](context);
}
