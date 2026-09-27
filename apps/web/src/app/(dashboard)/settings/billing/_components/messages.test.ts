import { describe, expect, it } from 'vitest';
import { TOP_UP_LIMITS_MINOR } from '@balo/shared/credit';
import {
  CARD_REMOVAL_UNCOVERED_COPY,
  cardRemovalUncoveredMessage,
  type CardRemovalUncoveredFacts,
} from './messages';

/**
 * BAL-474 owner ruling D10.6 — the remove-card dialog's blocking copy is OWNER-APPROVED VERBATIM
 * (Yomi, 2026-09-25). Every assertion below is against the FULL literal string, so a rewording
 * (or a swapped apostrophe / dash) fails here and needs the owner again.
 */

function facts(overrides: Partial<CardRemovalUncoveredFacts> = {}): CardRemovalUncoveredFacts {
  return {
    topUpNeededMinor: 123_450,
    reservedBookingCount: 2,
    companyName: 'Northwind Industrial',
    ...overrides,
  };
}

describe('cardRemovalUncoveredMessage — the owner-approved strings, verbatim', () => {
  it('figure arm: plural count, company possessive, cents', () => {
    expect(cardRemovalUncoveredMessage(facts())).toBe(
      "This card is backing 2 upcoming consultations — more than Northwind Industrial's balance covers right now. A top-up of A$1,234.50 or more, or cancelling bookings, lets you remove it."
    );
  });

  it('singular: "1 upcoming consultation"', () => {
    expect(cardRemovalUncoveredMessage(facts({ reservedBookingCount: 1 }))).toBe(
      "This card is backing 1 upcoming consultation — more than Northwind Industrial's balance covers right now. A top-up of A$1,234.50 or more, or cancelling bookings, lets you remove it."
    );
  });

  it('a count of 3 or more is plural', () => {
    expect(cardRemovalUncoveredMessage(facts({ reservedBookingCount: 12 }))).toContain(
      'backing 12 upcoming consultations —'
    );
  });

  it('no company name ⇒ "your team\'s", in the same slot', () => {
    expect(cardRemovalUncoveredMessage(facts({ companyName: null }))).toBe(
      "This card is backing 2 upcoming consultations — more than your team's balance covers right now. A top-up of A$1,234.50 or more, or cancelling bookings, lets you remove it."
    );
  });

  it('a blank company name is no name — never "\'s balance"', () => {
    const message = cardRemovalUncoveredMessage(facts({ companyName: '   ' }));
    expect(message).toContain("more than your team's balance covers");
    expect(message).not.toContain("'s's");
  });

  it('a name is used as written — never re-cased', () => {
    expect(cardRemovalUncoveredMessage(facts({ companyName: 'eBay' }))).toContain(
      "more than eBay's balance covers right now."
    );
  });

  it('the figure keeps its cents — the same formatting the booking panel prints', () => {
    expect(cardRemovalUncoveredMessage(facts({ topUpNeededMinor: 100 }))).toContain(
      'A top-up of A$1.00 or more,'
    );
    expect(cardRemovalUncoveredMessage(facts({ topUpNeededMinor: 275_00 }))).toContain(
      'A top-up of A$275.00 or more,'
    );
  });
});

describe('cardRemovalUncoveredMessage — the large variant (figure above the single top-up maximum)', () => {
  it('reads "Top-ups totalling … let you remove it"', () => {
    expect(cardRemovalUncoveredMessage(facts({ topUpNeededMinor: 1_250_000 }))).toBe(
      "This card is backing 2 upcoming consultations — more than Northwind Industrial's balance covers right now. Top-ups totalling A$12,500.00 or more, or cancelling bookings, let you remove it."
    );
  });

  it('boundary: exactly A$10,000 is still a single top-up; one minor unit above is large', () => {
    const at = cardRemovalUncoveredMessage(facts({ topUpNeededMinor: TOP_UP_LIMITS_MINOR.max }));
    const above = cardRemovalUncoveredMessage(
      facts({ topUpNeededMinor: TOP_UP_LIMITS_MINOR.max + 1 })
    );
    expect(at).toContain(
      'A top-up of A$10,000.00 or more, or cancelling bookings, lets you remove it.'
    );
    expect(above).toContain(
      'Top-ups totalling A$10,000.01 or more, or cancelling bookings, let you remove it.'
    );
  });

  it('carries the singular count and the fallback company too', () => {
    expect(
      cardRemovalUncoveredMessage(
        facts({ topUpNeededMinor: 2_000_000, reservedBookingCount: 1, companyName: null })
      )
    ).toBe(
      "This card is backing 1 upcoming consultation — more than your team's balance covers right now. Top-ups totalling A$20,000.00 or more, or cancelling bookings, let you remove it."
    );
  });
});

describe('CARD_REMOVAL_UNCOVERED_COPY — the constants themselves', () => {
  const context = { count: '{count}', company: "{Company}'s", amount: '{amount}' };

  it('figure', () => {
    expect(CARD_REMOVAL_UNCOVERED_COPY.figure(context)).toBe(
      "This card is backing {count} — more than {Company}'s balance covers right now. A top-up of {amount} or more, or cancelling bookings, lets you remove it."
    );
  });

  it('large', () => {
    expect(CARD_REMOVAL_UNCOVERED_COPY.large(context)).toBe(
      "This card is backing {count} — more than {Company}'s balance covers right now. Top-ups totalling {amount} or more, or cancelling bookings, let you remove it."
    );
  });
});
