import { describe, it, expect } from 'vitest';
import {
  formatAudMinor,
  formatExpiryDateLong,
  formatExpiryDateShort,
  lowBalanceModeLabel,
  cardBrandLabel,
  buildSavedCardDetachedCopy,
} from './credit-format.js';

describe('formatAudMinor', () => {
  it('formats whole-dollar minor units with two fraction digits', () => {
    expect(formatAudMinor(34700)).toBe('A$347.00');
  });

  it('formats sub-dollar and thousands-grouped amounts', () => {
    expect(formatAudMinor(5)).toBe('A$0.05');
    expect(formatAudMinor(123456)).toBe('A$1,234.56');
  });

  it('degrades a non-finite amount to A$0.00 (never NaN)', () => {
    expect(formatAudMinor(Number.NaN)).toBe('A$0.00');
  });
});

describe('formatExpiryDateLong', () => {
  it('renders the long UTC date (en-GB)', () => {
    expect(formatExpiryDateLong('2027-07-12T00:00:00.000Z')).toBe('12 July 2027');
  });

  it('is stable at a UTC midnight boundary (no local-timezone drift)', () => {
    expect(formatExpiryDateLong('2027-01-01T00:00:00.000Z')).toBe('1 January 2027');
  });

  it('degrades an unparseable input to "the expiry date"', () => {
    expect(formatExpiryDateLong('not-a-date')).toBe('the expiry date');
  });
});

describe('formatExpiryDateShort', () => {
  it('renders the short UTC date (en-GB)', () => {
    expect(formatExpiryDateShort('2027-07-12T00:00:00.000Z')).toBe('12 Jul 2027');
  });

  it('degrades an unparseable input to "the expiry date"', () => {
    expect(formatExpiryDateShort('')).toBe('the expiry date');
  });
});

describe('lowBalanceModeLabel', () => {
  it('maps the three modes to the exact web-picker strings (BAL-521)', () => {
    expect(lowBalanceModeLabel('auto_topup')).toBe('Auto top-up');
    expect(lowBalanceModeLabel('keep_going')).toBe('Keep me going');
    expect(lowBalanceModeLabel('notify_only')).toBe('Just notify me');
  });

  it('degrades an unrecognised value to "Just notify me" rather than throwing', () => {
    expect(lowBalanceModeLabel('some_future_mode')).toBe('Just notify me');
  });
});

describe('cardBrandLabel (BAL-521 F6)', () => {
  it('title-cases jcb and eftpos_au correctly (not "Jcb" / "Eftpos_au")', () => {
    expect(cardBrandLabel('jcb')).toBe('JCB');
    expect(cardBrandLabel('eftpos_au')).toBe('Eftpos');
  });

  it('title-cases the other known Stripe brands', () => {
    expect(cardBrandLabel('visa')).toBe('Visa');
    expect(cardBrandLabel('mastercard')).toBe('Mastercard');
    expect(cardBrandLabel('amex')).toBe('Amex');
    expect(cardBrandLabel('discover')).toBe('Discover');
    expect(cardBrandLabel('diners')).toBe('Diners');
    expect(cardBrandLabel('unionpay')).toBe('UnionPay');
  });

  it('is case-insensitive on the input', () => {
    expect(cardBrandLabel('JCB')).toBe('JCB');
    expect(cardBrandLabel('Eftpos_Au')).toBe('Eftpos');
  });

  it('falls back to a title-cased pass-through for an unrecognised brand', () => {
    expect(cardBrandLabel('mysterybrand')).toBe('Mysterybrand');
  });

  it('degrades an empty brand to "Card" rather than throwing', () => {
    expect(cardBrandLabel('')).toBe('Card');
  });
});

describe('buildSavedCardDetachedCopy (BAL-521 F3 — the shared copy derivation)', () => {
  it('stripe_webhook + known card: names the bank/card provider, never the actor', () => {
    const copy = buildSavedCardDetachedCopy({
      source: 'stripe_webhook',
      cardBrand: 'visa',
      cardLast4: '4242',
      modeReconciled: false,
    });
    expect(copy.headline).toBe('Your saved card was removed');
    expect(copy.leadSentence).toBe(
      'Your saved Visa ending 4242 was removed by your bank or card provider.'
    );
    expect(copy.consequence).toBe('You were already on Just notify me, so nothing else changed.');
  });

  it('stripe_webhook + unknown card degrades to the card-less lead sentence', () => {
    const copy = buildSavedCardDetachedCopy({ source: 'stripe_webhook', modeReconciled: false });
    expect(copy.leadSentence).toBe('Your saved card was removed by your bank or card provider.');
  });

  it('user_initiated: leads with the labelled "@ company" form, not the bare name', () => {
    const copy = buildSavedCardDetachedCopy({
      source: 'user_initiated',
      detachedByName: 'Dana',
      detachedByLabel: 'Dana @ Northwind Industrial',
      cardBrand: 'mastercard',
      cardLast4: '0005',
      modeReconciled: false,
    });
    expect(copy.headline).toBe('Saved card removed');
    expect(copy.leadSentence).toBe(
      'Dana @ Northwind Industrial removed the saved card — the Mastercard ending 0005.'
    );
    expect(copy.bareName).toBe('Dana');
    expect(copy.label).toBe('Dana @ Northwind Industrial');
  });

  it('user_initiated falls back to "A teammate" for both bareName and label when no actor resolved', () => {
    const copy = buildSavedCardDetachedCopy({ source: 'user_initiated', modeReconciled: false });
    expect(copy.leadSentence).toBe('A teammate removed the saved card.');
    expect(copy.bareName).toBe('A teammate');
    expect(copy.label).toBe('A teammate');
  });

  it('the consequence names the mode that went off IFF modeReconciled', () => {
    const reconciled = buildSavedCardDetachedCopy({
      source: 'stripe_webhook',
      modeReconciled: true,
      previousLowBalanceMode: 'auto_topup',
    });
    expect(reconciled.consequence).toBe(
      "Auto top-up is now off — you're on Just notify me. Add a card in Billing settings to turn it back on."
    );

    const notReconciled = buildSavedCardDetachedCopy({
      source: 'stripe_webhook',
      modeReconciled: false,
    });
    expect(notReconciled.consequence).toBe(
      'You were already on Just notify me, so nothing else changed.'
    );
  });

  it('reports `source` back to the caller for subject/branching needs', () => {
    expect(buildSavedCardDetachedCopy({ source: 'user_initiated' }).source).toBe('user_initiated');
    expect(buildSavedCardDetachedCopy({ source: 'stripe_webhook' }).source).toBe('stripe_webhook');
    expect(buildSavedCardDetachedCopy({}).source).toBe('stripe_webhook');
  });
});
