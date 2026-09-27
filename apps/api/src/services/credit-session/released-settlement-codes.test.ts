import { describe, expect, it } from 'vitest';
import {
  RELEASED_SETTLEMENT_CODES,
  isReleasedSettlementCode,
} from './released-settlement-codes.js';

describe('isReleasedSettlementCode', () => {
  it.each(RELEASED_SETTLEMENT_CODES)('recognizes %s as a released settlement code', (code) => {
    expect(isReleasedSettlementCode(code)).toBe(true);
  });

  it('rejects a code that is not in the released list', () => {
    expect(isReleasedSettlementCode('debt_settled')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isReleasedSettlementCode('')).toBe(false);
  });
});
