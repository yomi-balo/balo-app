import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import { GENERIC_NO_CHARGE_COPY } from '@/components/billing/top-up/PayAction';
import { CARD_BACKED_MODE_TITLE } from '@/components/billing/top-up/LowBalanceModePicker';
import { describeSavedCard } from '@/components/billing/top-up/SavedCardRow';
import type { SavedCard } from '@/components/billing/top-up/types';
import type { BookingFundingMethodProperty } from '@balo/analytics/events';
import type { FundedVia } from '@/lib/booking/actions/booking-funding-types';
import {
  formatAud,
  formatAudShort,
  upcomingConsultationsLabel,
} from '@/lib/credit/display-constants';
import { BALANCE_PANEL_COPY, companyLabels, type CompanyLabels } from '../booking-error-panels';
import type { RefusedFundingView } from './funding-disposition';

/**
 * ⚠ UNCLEARED MJ CHECKPOINT (BAL-608 AC13, extended to BAL-609 by {@link PAY_AFTER_COPY},
 * {@link payAfterConsentLine} and the pay-after arms of the funded-line functions). Every string in this module is placeholder copy
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
 *  · {@link payAfterConsentLine}'s "Change it anytime in Billing settings" (and the help guide's
 *    "change that setting any time") overclaims: BAL-523 refuses switching back to Just notify me
 *    while a consultation is live.
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

/**
 * What the funding block is funding. `booking` is the booking flow's own wording; `call` is Call
 * now's (BAL-651 R8): it never says "book", and the funding events it fires are the call
 * funding-gate's, not the booking's. `answer` is the callee's side of the same funding (a client
 * answering an expert's call): the call wording, but the actions say "answer", never "call now".
 */
export type FundingContext = 'booking' | 'call' | 'answer';

/** Whether the block is funding a call (placed or answered) rather than a booking. */
export function isCallFunding(context: FundingContext): boolean {
  return context !== 'booking';
}

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

/** The company by name, or "your team" when it has none. */
function partyName(companyName: string | null): string {
  return companyName ?? 'your team';
}

/** The card a Pay-after booking set up, as it reads at the start of a sentence. */
function payAfterCardLead(card: SavedCard | null): string {
  return card === null ? 'Your card' : describeSavedCard(card);
}

/** What landed before a later step failed: the top-up, or the card set up to pay after the call. */
function landedLine(funded: FundedVia): string {
  if (funded.method === 'topup') return topUpLandedLine(funded.creditedMinor, funded.companyName);
  return `${payAfterCardLead(funded.card)} is set up for ${partyName(funded.companyName)}. Nothing was charged.`;
}

/** The hard-failure panel body after funding landed: it never claims nothing was charged for a top-up. */
export function fundedHardFailureBody(funded: FundedVia): string {
  const tail =
    funded.method === 'topup'
      ? "Trying again won't charge you again."
      : 'Try again when you are ready.';
  return `We couldn't finish your booking. ${landedLine(funded)} ${tail}`;
}

/** The line under the partial-failure panel after funding landed. */
export function fundedPartialFollowUp(funded: FundedVia): string {
  const tail =
    funded.method === 'topup'
      ? "Trying again won't charge you again."
      : 'Try again when you are ready.';
  return `${landedLine(funded)} ${tail}`;
}

/** The line under the session-expired panel after funding landed. */
export function fundedSessionFollowUp(funded: FundedVia): string {
  const tail =
    funded.method === 'topup'
      ? "Sign in and you won't be charged again."
      : 'Sign in and pick up where you left off.';
  return `${landedLine(funded)} ${tail}`;
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
  card_change_refused:
    "There's a consultation running on the card on file, so it can't be swapped right now. Nothing was charged. Pay with the saved card, or try again after the call.",
} as const;

/** The button that retries once a landed payment has not yet shown in the balance. */
const BOOKING_RETRY_LABEL = 'Book now';
const CALL_RETRY_LABEL = 'Call now';
/** NEW — the retry button on the answer path. */
const ANSWER_RETRY_LABEL = 'Answer';

const RETRY_LABELS: Readonly<Record<FundingContext, string>> = {
  booking: BOOKING_RETRY_LABEL,
  call: CALL_RETRY_LABEL,
  answer: ANSWER_RETRY_LABEL,
};

/** The payment succeeded but the balance has not caught up yet. Never invites a second payment. */
export function creditPendingCopy(
  companyName: string | null,
  context: FundingContext = 'booking'
): string {
  const co = companyLabels(companyName);
  const retry = RETRY_LABELS[context];
  return `Your payment went through and is being added to ${co.mid} balance. Press ${retry} to finish — you won't be charged again.`;
}

/** After funding landed but the time was taken: what is kept is kept, and the line says so. */
export function staleSlotFundedFollowUp(funded: FundedVia): string {
  const co = companyLabels(funded.companyName);
  if (funded.method === 'topup') {
    return `Your top-up went through, so ${formatAud(funded.creditedMinor)} is in ${co.mid} balance for the next time you choose.`;
  }
  return `${payAfterCardLead(funded.card)} is set up and ready for the next time you choose.`;
}

const SETUP_FAILED_LINE =
  "Your card couldn't be set up, so nothing was charged and nothing was booked.";

const SWITCHED_NOTE =
  'Your low-balance setting is now Keep me going, and it only takes effect once a card is confirmed.';

/** Pay after the call: the picker cards, the CTAs, the stage text and the failure lines. */
export const PAY_AFTER_COPY = {
  methodGroupLabel: 'How to pay',
  topup: {
    title: 'Top up now',
    description: (companyName: string | null): string =>
      `Add funds to ${companyLabels(companyName).mid} balance. Each consultation draws from it.`,
  },
  payAfter: {
    title: 'Pay after the call',
    description: 'No charge now. Time beyond the balance is charged to a card after each call.',
  },
  ctaSaved: 'Book and pay after the call',
  ctaNew: 'Add card & book',
  cardSaved: 'Your new card is saved. Press below to finish setting up and book.',
  stage: {
    setting_up_saved: 'Setting up…',
    setting_up_new: 'Saving your card…',
    authenticating: 'Waiting for your bank…',
    awaiting_mandate: 'Confirming your card…',
    booking: 'Booking…',
  },
  errors: {
    declined:
      'Your card was declined, so nothing was charged and nothing was booked. Try a different card or check with your bank.',
    auth_failed:
      "Your bank didn't confirm the card, so nothing was charged and nothing was booked. Try again or use a different card.",
    setup_failed:
      "Your card couldn't be set up, so nothing was charged and nothing was booked. What you've entered is still here.",
    setup_failed_saved: `${SETUP_FAILED_LINE} ${SWITCHED_NOTE}`,
    mode_failed:
      "Your card is saved, but we couldn't switch the low-balance setting to Keep me going, so nothing was booked. Nothing was charged. Try again.",
    settlement_outstanding:
      "There's consultation time in progress on the card on file. Once that call ends you can add a different card. Nothing was charged.",
    error: GENERIC_NO_CHARGE_COPY,
  },
  switchedNote: SWITCHED_NOTE,
  unconfirmed:
    "We're still confirming your card with your bank. Nothing has been charged and nothing is booked yet.",
  checkAgain: 'Check again',
  switchedToast: (companyName: string | null): string =>
    `${CARD_BACKED_MODE_TITLE.keep_going} is on for ${partyName(companyName)}.`,
} as const;

type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => R
    : { readonly [K in keyof T]: Widen<T[K]> };

/** The shape of {@link PAY_AFTER_COPY}, with every literal widened so a context can override it. */
export type PayAfterCopy = Widen<typeof PAY_AFTER_COPY>;

const SETUP_FAILED_CALL_LINE =
  "Your card couldn't be set up, so nothing was charged and the call hasn't started.";

/** {@link PAY_AFTER_COPY} for a call: every string that names booking says the call instead. */
const CALL_PAY_AFTER_COPY: PayAfterCopy = {
  ...PAY_AFTER_COPY,
  ctaSaved: 'Start the call, pay after',
  ctaNew: 'Add card & call',
  cardSaved: 'Your new card is saved. Press below to finish setting up and start the call.',
  stage: { ...PAY_AFTER_COPY.stage, booking: 'Starting the call…' },
  errors: {
    ...PAY_AFTER_COPY.errors,
    declined:
      "Your card was declined, so nothing was charged and the call hasn't started. Try a different card or check with your bank.",
    auth_failed:
      "Your bank didn't confirm the card, so nothing was charged and the call hasn't started. Try again or use a different card.",
    setup_failed:
      "Your card couldn't be set up, so nothing was charged and the call hasn't started. What you've entered is still here.",
    setup_failed_saved: `${SETUP_FAILED_CALL_LINE} ${SWITCHED_NOTE}`,
    mode_failed:
      "Your card is saved, but we couldn't switch the low-balance setting to Keep me going, so the call hasn't started. Nothing was charged. Try again.",
  },
  unconfirmed:
    "We're still confirming your card with your bank. Nothing has been charged and the call hasn't started yet.",
};

const CONSENT_ACTS: Readonly<Record<FundingContext, string>> = {
  booking: 'booking',
  call: 'calling',
  answer: 'answering',
};

/**
 * NEW — {@link CALL_PAY_AFTER_COPY} for the person ANSWERING a call: the actions say "answer" and
 * no string says "call now" or "starting the call".
 */
const ANSWER_PAY_AFTER_COPY: PayAfterCopy = {
  ...CALL_PAY_AFTER_COPY,
  ctaSaved: 'Answer, pay after',
  ctaNew: 'Add card & answer',
  cardSaved: 'Your new card is saved. Press below to finish setting up and answer.',
  stage: { ...CALL_PAY_AFTER_COPY.stage, booking: 'Answering…' },
};

/**
 * The consent shown before the press. It describes what the booking changes and what the card is
 * charged for; it never says the setting is what makes the card chargeable.
 */
export function payAfterConsentLine(
  companyName: string | null,
  card: SavedCard | null,
  context: FundingContext = 'booking'
): string {
  const co = companyLabels(companyName);
  const cardName = card === null ? 'this card' : describeSavedCard(card);
  const act = CONSENT_ACTS[context];
  return `By ${act}, you switch ${co.mid} low-balance setting to ${CARD_BACKED_MODE_TITLE.keep_going} and let Balo charge ${cardName} for consultation time beyond the balance, after each call. Change it anytime in Billing settings.`;
}

/** The header band while "Pay after the call" is selected: no top-up figure, on either arm. */
function payAfterBandCopy(view: RefusedFundingView, context: FundingContext): FundingBlockCopy {
  const straightAway = isCallFunding(context)
    ? 'the call starts straight away'
    : 'this one books straight away';
  if (view.arm === 'reserved') {
    return {
      heading: 'Pay after the call for this one',
      body: `Part of ${companyLabels(view.company.name).mid} balance is set aside for upcoming consultations. Choose a card to charge after the call and ${straightAway}. Nothing is charged now.`,
    };
  }
  return {
    heading: 'Pay after the call',
    body: `Choose a card to charge after the call and ${straightAway}. Nothing is charged now.`,
  };
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
 * The billing manager's copy for a call (BAL-651 R8): the booking table's strings with the booking
 * wording replaced by the call's. Only the manager arm exists here — a member never reaches the
 * block from a call, because the call funding step shows its own member panel.
 */
const CALL_MANAGER_COPY: Readonly<Record<RefusedFundingView['arm'], CopyFn>> = {
  setup: ({ view, company }) =>
    view.firstTime
      ? {
          heading: 'One setup step first',
          body: `Calls are paid from ${company.mid} balance. Top up now and the call starts straight after.`,
        }
      : {
          heading: `${company.start} balance needs a top-up for this call`,
          body: 'Top up now and the call starts straight after.',
        },
  reserved: ({ balance }) => ({
    heading: BALANCE_PANEL_COPY.reserved.heading.figure(balance),
    body: `Part of ${balance.company.mid} balance is set aside for ${balance.count}, so there isn't enough left to start this call. A top-up of ${balance.amount} or more would make room for it. ${balance.company.start} balance still shows in full — nothing has been taken for the planned consultations yet.`,
  }),
  hold: ({ view, balance }) => {
    const arm = holdArm(view);
    const { heading } = BALANCE_PANEL_COPY.hold;
    const body =
      arm === 'fallback'
        ? `An earlier hold is still on ${balance.company.mid} account, although the balance already covers it. It lifts automatically within a day, or at once with any top-up. Consultations that are already scheduled aren't affected.`
        : `${balance.company.start} balance needs a top-up of ${balance.amount} or more before new calls can start. Consultations that are already scheduled aren't affected.`;
    return { heading: (heading[arm] ?? heading.figure)(balance), body };
  },
};

/**
 * The heading and body for the funding block, by arm and audience (a billing manager, or a
 * member who can only save the booking for later). `draftKept` says whether Save keeps the typed
 * details on this device, which a booking on an already-chosen case does not.
 */
export function fundingBlockCopy(
  view: RefusedFundingView,
  draftKept = true,
  method: BookingFundingMethodProperty = 'topup',
  context: FundingContext = 'booking'
): FundingBlockCopy {
  if (method === 'pay_after') return payAfterBandCopy(view, context);
  const company = companyLabels(view.company.name);
  const figureMinor =
    view.arm === 'reserved'
      ? (view.topUpNeededMinor ?? view.suggestedTopUpMinor ?? 0)
      : (view.topUpNeededMinor ?? 0);
  const copyContext: CopyContext = {
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
  if (isCallFunding(context) && view.canManageBilling) {
    return CALL_MANAGER_COPY[view.arm](copyContext);
  }
  return COPY[view.arm][view.canManageBilling ? 'manager' : 'member'](copyContext);
}

/** Every context-dependent string the funding block shows, for one {@link FundingContext}. */
export interface FundingCopyBundle {
  readonly stage: Readonly<Record<keyof typeof FUNDING_STAGE_COPY, string>>;
  readonly payAfter: PayAfterCopy;
  readonly creditPending: (companyName: string | null) => string;
  readonly consentLine: (companyName: string | null, card: SavedCard | null) => string;
  readonly blockCopy: (
    view: RefusedFundingView,
    draftKept: boolean,
    method: BookingFundingMethodProperty
  ) => FundingBlockCopy;
  /** The top-up button's idle label; `null` while "Other" holds nothing usable. */
  readonly topUpLabel: (effectiveMinor: number | null) => string;
  /** The button that retries once a landed payment has not shown in the balance yet. */
  readonly creditRetryLabel: string;
}

const STAGE_COPY: Readonly<Record<FundingContext, FundingCopyBundle['stage']>> = {
  booking: FUNDING_STAGE_COPY,
  call: { ...FUNDING_STAGE_COPY, booking: 'Starting the call…' },
  // NEW
  answer: { ...FUNDING_STAGE_COPY, booking: 'Answering…' },
};

const PAY_AFTER_BY_CONTEXT: Readonly<Record<FundingContext, PayAfterCopy>> = {
  booking: PAY_AFTER_COPY,
  call: CALL_PAY_AFTER_COPY,
  answer: ANSWER_PAY_AFTER_COPY,
};

const TOP_UP_NOUNS: Readonly<Record<FundingContext, string>> = {
  booking: 'book',
  call: 'call',
  answer: 'answer',
};

function topUpLabelFor(noun: string): FundingCopyBundle['topUpLabel'] {
  return (effectiveMinor) =>
    effectiveMinor === null
      ? `Top up & ${noun}`
      : `Top up ${formatAudShort(effectiveMinor)} & ${noun}`;
}

/** The funding block's copy for a booking, for a call (BAL-651 R8), or for answering one. */
export function fundingCopyFor(context: FundingContext): FundingCopyBundle {
  return {
    stage: STAGE_COPY[context],
    payAfter: PAY_AFTER_BY_CONTEXT[context],
    creditPending: (companyName) => creditPendingCopy(companyName, context),
    consentLine: (companyName, card) => payAfterConsentLine(companyName, card, context),
    blockCopy: (view, draftKept, method) => fundingBlockCopy(view, draftKept, method, context),
    topUpLabel: topUpLabelFor(TOP_UP_NOUNS[context]),
    creditRetryLabel: RETRY_LABELS[context],
  };
}
