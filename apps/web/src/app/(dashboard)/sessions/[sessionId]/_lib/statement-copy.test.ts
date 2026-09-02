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
    for (const value of Object.values(SETTLEMENT_STATUS_COPY)) {
      expect(value.toLowerCase()).not.toContain('overdraft');
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
  it('covers exactly the three non-ordinary settlement statuses', () => {
    expect(Object.keys(SETTLEMENT_STATUS_COPY).sort()).toEqual(
      ['failed', 'processing', 'requires_action'].sort()
    );
  });

  it('covers exactly the four payout statuses', () => {
    expect(Object.keys(PAYOUT_STATUS_COPY).sort()).toEqual(
      ['disbursing', 'failed', 'paid', 'recorded'].sort()
    );
  });
});
