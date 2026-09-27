import { describe, it, expect } from 'vitest';
import {
  STATEMENT_COPY,
  STATEMENT_SHARED_COPY,
  SETTLEMENT_STATUS_COPY,
  PAYOUT_STATUS_COPY,
} from './statement-copy';

describe('STATEMENT_COPY', () => {
  it('has both lenses, each with a complete, non-empty copy set', () => {
    for (const lens of ['client', 'expert'] as const) {
      const copy = STATEMENT_COPY[lens];
      for (const value of Object.values(copy)) {
        expect(typeof value).toBe('string');
        expect(value.length).toBeGreaterThan(0);
      }
    }
  });

  it('never uses the word "overdraft" (CLAUDE.md)', () => {
    for (const copy of Object.values(STATEMENT_COPY)) {
      for (const value of Object.values(copy)) {
        expect(value.toLowerCase()).not.toContain('overdraft');
      }
    }
    for (const shape of Object.values(SETTLEMENT_STATUS_COPY)) {
      for (const value of Object.values(shape)) {
        expect(value.toLowerCase()).not.toContain('overdraft');
      }
    }
  });

  it('the client and expert eyebrows/titles diverge as the design specifies', () => {
    expect(STATEMENT_COPY.client.eyebrow).toBe('Session receipt');
    expect(STATEMENT_COPY.expert.eyebrow).toBe('Payout statement');
    expect(STATEMENT_COPY.client.totalRowLabel).toBe('Total charged');
    expect(STATEMENT_COPY.expert.totalRowLabel).toBe('Total earned');
  });
});

describe('STATEMENT_SHARED_COPY', () => {
  it('has every shared string non-empty', () => {
    for (const value of Object.values(STATEMENT_SHARED_COPY)) {
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe('SETTLEMENT_STATUS_COPY / PAYOUT_STATUS_COPY', () => {
  it('is keyed by exactly the two receipt shapes', () => {
    expect(Object.keys(SETTLEMENT_STATUS_COPY).sort((a, b) => a.localeCompare(b))).toEqual([
      'held',
      'no_show_client',
    ]);
  });

  it('each shape covers exactly the three non-ordinary settlement statuses', () => {
    for (const shape of Object.values(SETTLEMENT_STATUS_COPY)) {
      expect(Object.keys(shape).sort((a, b) => a.localeCompare(b))).toEqual([
        'failed',
        'processing',
        'requires_action',
      ]);
    }
  });

  it('never says "extra time" or "the card on file" (a no-show has no extra time; a card may have been swapped)', () => {
    for (const shape of Object.values(SETTLEMENT_STATUS_COPY)) {
      for (const value of Object.values(shape)) {
        expect(value.toLowerCase()).not.toContain('extra time');
        expect(value.toLowerCase()).not.toContain('card on file');
      }
    }
  });

  it('every no_show_client string says the booking was billed at its minimum; no held string does', () => {
    for (const value of Object.values(SETTLEMENT_STATUS_COPY.no_show_client)) {
      expect(value).toContain('billed at its minimum charge');
    }
    for (const value of Object.values(SETTLEMENT_STATUS_COPY.held)) {
      expect(value).not.toContain('minimum');
    }
  });

  it('covers exactly the four payout statuses', () => {
    expect(Object.keys(PAYOUT_STATUS_COPY).sort()).toEqual(
      ['disbursing', 'failed', 'paid', 'recorded'].sort()
    );
  });
});
