import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/credit/actions', () => ({ startPurchaseAction: vi.fn() }));

import { BALANCE_PANEL_COPY, companyLabels } from '../booking-error-panels';
import { GENERIC_NO_CHARGE_COPY } from '@/components/billing/top-up/PayAction';
import {
  BOOKING_PAY_ERROR_COPY,
  FUNDING_AUD_LINE,
  BALANCE_NOW_COVERS_COPY,
  DRAFT_CLEARED_COPY,
  FUNDING_STAGE_COPY,
  MEMBER_TAIL,
  MEMBER_TAIL_NO_DRAFT,
  creditPendingCopy,
  fundedHardFailureBody,
  fundedPartialFollowUp,
  fundedSessionFollowUp,
  fundingBlockCopy,
  savedForLaterBody,
  staleSlotFundedFollowUp,
  PAY_AFTER_COPY,
  payAfterConsentLine,
} from './funding-copy';
import type { SavedCard } from '@/components/billing/top-up/types';
import { SAVED_CARD } from './funding-fixtures';
import type { FundedVia } from '@/lib/booking/actions/booking-funding-types';
import { refusedView } from './funding-fixtures';
import type { RefusedFundingView } from './funding-disposition';

const CO = companyLabels('Northwind');
const BALANCE = {
  company: CO,
  amount: 'A$275.00',
  maxTopUp: 'A$10,000',
  count: '2 upcoming consultations',
};

const topUp = (creditedMinor: number, companyName: string | null): FundedVia => ({
  method: 'topup',
  creditedMinor,
  companyName,
});
const payAfter = (card: SavedCard | null, companyName: string | null): FundedVia => ({
  method: 'pay_after',
  card,
  companyName,
});

const holdFigure = (overrides: Partial<RefusedFundingView> = {}) =>
  refusedView({ arm: 'hold', topUpNeededMinor: 27_500, ...overrides });
const holdFallback = (overrides: Partial<RefusedFundingView> = {}) =>
  refusedView({ arm: 'hold', topUpNeededMinor: null, ...overrides });
const reserved = (overrides: Partial<RefusedFundingView> = {}) =>
  refusedView({
    arm: 'reserved',
    topUpNeededMinor: 27_500,
    reservedBookingCount: 2,
    firstTime: false,
    ...overrides,
  });
const asMember = { canManageBilling: false, wallet: null } as const;

describe('fundingBlockCopy — manager reserved and hold strings are the approved panel copy', () => {
  it('reserved', () => {
    expect(fundingBlockCopy(reserved())).toEqual({
      heading: BALANCE_PANEL_COPY.reserved.heading.figure(BALANCE),
      body: BALANCE_PANEL_COPY.reserved.body.manager.figure(BALANCE),
    });
  });

  it('hold with a figure', () => {
    expect(fundingBlockCopy(holdFigure())).toEqual({
      heading: BALANCE_PANEL_COPY.hold.heading.figure(BALANCE),
      body: BALANCE_PANEL_COPY.hold.body.manager.figure(BALANCE),
    });
  });

  it('hold with the failed-heal fallback', () => {
    const fallback = BALANCE_PANEL_COPY.hold.body.manager.fallback;
    const heading = BALANCE_PANEL_COPY.hold.heading.fallback;
    expect(fallback).toBeDefined();
    expect(heading).toBeDefined();
    expect(fundingBlockCopy(holdFallback())).toEqual({
      heading: heading?.({ ...BALANCE, amount: '' }),
      body: fallback?.({ ...BALANCE, amount: '' }),
    });
  });
});

describe('fundingBlockCopy — setup arm', () => {
  it('first time, manager', () => {
    expect(fundingBlockCopy(refusedView())).toEqual({
      heading: 'One setup step first',
      body: "Consultations are paid from Northwind's balance. Top up now and this one books straight after.",
    });
  });

  it('returning, manager', () => {
    expect(fundingBlockCopy(refusedView({ firstTime: false }))).toEqual({
      heading: "Northwind's balance needs a top-up for this one",
      body: 'Top up now and this one books straight after.',
    });
  });

  it('names an unnamed company as "your team"', () => {
    expect(
      fundingBlockCopy(
        refusedView({ company: { id: 'c', name: null, isActive: true }, firstTime: false })
      ).heading
    ).toBe("Your team's balance needs a top-up for this one");
  });

  it.each([true, false])('member (firstTime=%s)', (firstTime) => {
    expect(fundingBlockCopy(refusedView({ ...asMember, firstTime }))).toEqual({
      heading: 'A billing admin needs to set this up',
      body: `Booking needs a payment method on file or enough credit in Northwind's balance, and only billing admins can add either. ${MEMBER_TAIL}`,
    });
  });

  it('never states a figure', () => {
    for (const view of [
      refusedView(),
      refusedView({ firstTime: false }),
      refusedView({ ...asMember }),
    ]) {
      const { heading, body } = fundingBlockCopy(view);
      expect(`${heading} ${body}`).not.toContain('A$');
    }
  });
});

describe('fundingBlockCopy — member bodies', () => {
  it('reserved', () => {
    expect(fundingBlockCopy(reserved({ ...asMember }))).toEqual({
      heading: BALANCE_PANEL_COPY.reserved.heading.figure(BALANCE),
      body: `Part of Northwind's balance is set aside for 2 upcoming consultations, so there isn't enough left to book this one, and only billing admins can top up. ${MEMBER_TAIL}`,
    });
  });

  it('hold with a figure', () => {
    expect(fundingBlockCopy(holdFigure({ ...asMember }))).toEqual({
      heading: BALANCE_PANEL_COPY.hold.heading.figure(BALANCE),
      body: `Northwind's balance needs a top-up of A$275.00 or more before new consultations can be booked, and only billing admins can top up. ${MEMBER_TAIL}`,
    });
  });

  it('hold fallback', () => {
    expect(fundingBlockCopy(holdFallback({ ...asMember }))).toEqual({
      heading: 'An earlier hold is still clearing',
      body: `An earlier hold is still on Northwind's account, although the balance already covers it. It lifts automatically within a day, or at once with any top-up. ${MEMBER_TAIL}`,
    });
  });

  it('reserved falls back to the suggested amount when the figure is missing', () => {
    const copy = fundingBlockCopy(
      reserved({ topUpNeededMinor: null, suggestedTopUpMinor: 60_000 })
    );
    expect(copy.body).toContain('A$600.00');
  });
});

describe('no copy claims a billing admin was already told', () => {
  const VIEWS = [
    refusedView(),
    refusedView({ firstTime: false }),
    refusedView({ ...asMember }),
    reserved(),
    reserved({ ...asMember }),
    holdFigure(),
    holdFigure({ ...asMember }),
    holdFallback(),
    holdFallback({ ...asMember }),
  ];

  it.each(VIEWS.map((view, index) => [index, view] as const))('view %i', (_index, view) => {
    const { heading, body } = fundingBlockCopy(view);
    expect(`${heading} ${body}`).not.toMatch(/notified/i);
  });

  it('the member tail promises Save, not a past notification', () => {
    expect(MEMBER_TAIL).not.toMatch(/notified/i);
    expect(MEMBER_TAIL).toContain("we'll let your billing admins know");
  });

  it('the no-draft tail keeps the Save promise and drops the on-device sentence', () => {
    expect(MEMBER_TAIL_NO_DRAFT).toBe("Save this booking and we'll let your billing admins know.");
    expect(
      fundingBlockCopy(refusedView({ ...asMember }), false).body.endsWith(MEMBER_TAIL_NO_DRAFT)
    ).toBe(true);
  });
});

describe('payment copy', () => {
  it('maps settlement_outstanding to the generic no-charge line', () => {
    expect(BOOKING_PAY_ERROR_COPY.settlement_outstanding).toBe(GENERIC_NO_CHARGE_COPY);
  });

  it('the decline and authentication lines say nothing was charged', () => {
    expect(BOOKING_PAY_ERROR_COPY.declined).toContain('nothing was charged');
    expect(BOOKING_PAY_ERROR_COPY.auth_failed).toContain('nothing was charged');
  });

  it('the pending line never invites a second payment', () => {
    expect(creditPendingCopy('Northwind')).toBe(
      "Your payment went through and is being added to Northwind's balance. Press Book now to finish — you won't be charged again."
    );
    expect(creditPendingCopy(null)).toContain("your team's balance");
  });

  it('the stale-slot follow-up names the credited amount', () => {
    expect(staleSlotFundedFollowUp(topUp(60_000, 'Northwind'))).toBe(
      "Your top-up went through, so A$600.00 is in Northwind's balance for the next time you choose."
    );
  });

  it('the AUD line states the currency', () => {
    expect(FUNDING_AUD_LINE).toBe("You'll be charged in AUD — your bank sets the final rate.");
  });

  it('no payment string quotes a rate', () => {
    const all = [
      ...Object.values(BOOKING_PAY_ERROR_COPY),
      creditPendingCopy('Northwind'),
      staleSlotFundedFollowUp(topUp(60_000, 'Northwind')),
    ].join(' ');
    expect(all).not.toMatch(/\/hr|per hour|per minute|rate:/i);
  });
});

describe('copy for a landed top-up and the stage text', () => {
  it('the failure lines say the top-up is in the balance and never claim nothing was charged', () => {
    const lines = [
      fundedHardFailureBody(topUp(30_000, 'Northwind')),
      fundedPartialFollowUp(topUp(30_000, 'Northwind')),
      fundedSessionFollowUp(topUp(30_000, 'Northwind')),
    ];
    for (const line of lines) {
      expect(line).toContain("A$300.00 is in Northwind's balance");
      expect(line).not.toMatch(/nothing was charged/i);
      expect(line).toMatch(/won't (charge you )?again|won't be charged again/);
    }
    expect(fundedHardFailureBody(topUp(30_000, null))).toContain("your team's balance");
  });

  it('the saved-for-later body claims the device draft only when one was kept', () => {
    expect(savedForLaterBody('Northwind', 'Amara', true)).toContain('saved on this device');
    expect(savedForLaterBody('Northwind', null, true)).toContain('this expert');
    expect(savedForLaterBody('Northwind', 'Amara', false)).toBe(
      "We've told Northwind's billing admins this booking is waiting on them."
    );
  });

  it('names each stage', () => {
    expect(FUNDING_STAGE_COPY).toEqual({
      processing: 'Processing payment…',
      awaiting_credit: 'Adding to balance…',
      booking: 'Booking…',
    });
    expect(BALANCE_NOW_COVERS_COPY).toContain('Confirm & book');
    expect(DRAFT_CLEARED_COPY).toMatch(/cleared/i);
  });
});

describe('copy for a landed Pay after', () => {
  const funded = payAfter(SAVED_CARD, 'Northwind');
  const newCard = payAfter(null, null);

  it('every follow-up names the card, says nothing was charged and quotes no AUD figure', () => {
    const lines = [
      fundedHardFailureBody(funded),
      fundedPartialFollowUp(funded),
      fundedSessionFollowUp(funded),
    ];
    for (const line of lines) {
      expect(line).toContain('Visa •••• 4242 is set up for Northwind. Nothing was charged.');
      expect(line).not.toMatch(/A\$/);
    }
  });

  it('falls back to "Your card" and "your team" for a new card and an unnamed company', () => {
    expect(fundedPartialFollowUp(newCard)).toContain(
      'Your card is set up for your team. Nothing was charged.'
    );
  });

  it('the stale-slot line says the card is ready for the next time', () => {
    expect(staleSlotFundedFollowUp(funded)).toBe(
      'Visa •••• 4242 is set up and ready for the next time you choose.'
    );
    expect(staleSlotFundedFollowUp(newCard)).toBe(
      'Your card is set up and ready for the next time you choose.'
    );
  });
});

describe('PAY_AFTER_COPY', () => {
  it('pins the placeholder strings', () => {
    expect(PAY_AFTER_COPY.payAfter.title).toBe('Pay after the call');
    expect(PAY_AFTER_COPY.topup.description('Northwind')).toBe(
      "Add funds to Northwind's balance. Each consultation draws from it."
    );
    expect(PAY_AFTER_COPY.ctaSaved).toBe('Book and pay after the call');
    expect(PAY_AFTER_COPY.ctaNew).toBe('Add card & book');
    expect(PAY_AFTER_COPY.stage).toEqual({
      setting_up_saved: 'Setting up…',
      setting_up_new: 'Saving your card…',
      authenticating: 'Waiting for your bank…',
      awaiting_mandate: 'Confirming your card…',
      booking: 'Booking…',
    });
    expect(PAY_AFTER_COPY.errors.setup_failed).toBe(
      "Your card couldn't be set up, so nothing was charged and nothing was booked. What you've entered is still here."
    );
    expect(PAY_AFTER_COPY.errors.setup_failed_saved).toBe(
      `Your card couldn't be set up, so nothing was charged and nothing was booked. ${PAY_AFTER_COPY.switchedNote}`
    );
    expect(PAY_AFTER_COPY.switchedNote).toBe(
      'Your low-balance setting is now Keep me going, and it only takes effect once a card is confirmed.'
    );
    expect(PAY_AFTER_COPY.switchedToast('Northwind')).toBe('Keep me going is on for Northwind.');
  });

  it('every failure line says nothing was charged', () => {
    for (const line of Object.values(PAY_AFTER_COPY.errors)) {
      expect(line).toMatch(/nothing was charged|no charge was made/i);
    }
  });
});

describe('pay-after header band', () => {
  it.each([
    ['setup', refusedView()],
    ['reserved', reserved()],
  ])('on the %s arm has its own copy and no top-up figure', (_arm, view) => {
    const copy = fundingBlockCopy(view, true, 'pay_after');
    expect(copy).not.toEqual(fundingBlockCopy(view, true));
    expect(`${copy.heading} ${copy.body}`).not.toMatch(/A\$|Top up/);
    expect(copy.body).toContain('Nothing is charged now.');
  });

  it('the top-up method keeps the existing band', () => {
    expect(fundingBlockCopy(refusedView(), true, 'topup')).toEqual(fundingBlockCopy(refusedView()));
  });

  it('the card-swap refusal gives a recovery path', () => {
    expect(BOOKING_PAY_ERROR_COPY.card_change_refused).toContain('Nothing was charged.');
    expect(BOOKING_PAY_ERROR_COPY.card_change_refused).toContain('try again after the call');
  });
});

describe('payAfterConsentLine', () => {
  it('names the company, the setting and the card, in the future tense', () => {
    expect(payAfterConsentLine('Northwind', SAVED_CARD)).toBe(
      "By booking, you switch Northwind's low-balance setting to Keep me going and let Balo charge Visa •••• 4242 for consultation time beyond the balance, after each call. Change it anytime in Billing settings."
    );
  });

  it('says "this card" for a new card and never says the setting makes the card chargeable', () => {
    const line = payAfterConsentLine(null, null);
    expect(line).toContain("your team's low-balance setting");
    expect(line).toContain('charge this card');
    expect(line).not.toMatch(/so (that )?(the|your) card|makes? .* chargeable/i);
  });
});
