import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockLogError, mockCaptureException } = vi.hoisted(() => ({
  mockLogError: vi.fn(),
  mockCaptureException: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: mockLogError }),
}));
vi.mock('@sentry/node', () => ({ captureException: mockCaptureException }));
// ⚠ NO `@balo/db` MOCK, ON PURPOSE. The reporter performs NO database read (D7.3): the check ran
// inside the terminal transaction, where it was consistent. If this module ever imported a
// repository, it would load the real `@balo/db` in this suite and any call would fail loudly.

import { WALLET_DEBT_WITHOUT_OWNER_MSG, reportOwnerlessPriorDebt } from './debt-owner-alarm.js';

const BASE = { sessionId: 'session_1', walletId: 'wallet_1', companyId: 'company_1' } as const;

function basis(ownerlessPriorDebtMinor: number, priorDebtLeftMinor = 10_000) {
  return {
    overdraftMinor: 17_500,
    walletNegativeMinor: 27_500,
    ownConsumedMinor: 17_500,
    priorDebtLeftMinor,
    ownerlessPriorDebtMinor,
  };
}

describe('reportOwnerlessPriorDebt (BAL-474, D7.3)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('pins the alarm string VERBATIM — an operator monitor matches on it', () => {
    expect(WALLET_DEBT_WITHOUT_OWNER_MSG).toBe(
      'Wallet carries debt that no open receivable and no in-flight settlement owns — a coverage clear or a settlement stamp has lost a debt (ADR-1040 Amendment 7 §A)'
    );
  });

  it('is SILENT when every unit of older debt still has an owner', () => {
    reportOwnerlessPriorDebt({ ...BASE, basis: basis(0) });
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it.each([
    ['null (the idempotent re-end computed nothing)', null],
    ['undefined', undefined],
  ])('is SILENT for a %s basis', (_label, value) => {
    reportOwnerlessPriorDebt({ ...BASE, basis: value });
    expect(mockLogError).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('logs at ERROR and captures in Sentry when the prior debt has no owner — with the amounts, not counts', () => {
    reportOwnerlessPriorDebt({ ...BASE, basis: basis(10_000) });

    const expectedFields = {
      sessionId: 'session_1',
      walletId: 'wallet_1',
      companyId: 'company_1',
      priorDebtLeftMinor: 10_000,
      ownerlessPriorDebtMinor: 10_000,
    };
    expect(mockLogError).toHaveBeenCalledTimes(1);
    expect(mockLogError).toHaveBeenCalledWith(expectedFields, WALLET_DEBT_WITHOUT_OWNER_MSG);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [error, context] = mockCaptureException.mock.calls[0] as [Error, { extra: unknown }];
    expect(error.message).toBe(WALLET_DEBT_WITHOUT_OWNER_MSG);
    expect(context).toEqual({ extra: expectedFields });
  });

  it('a PARTIAL shortfall (owners exist but are too small) alarms too', () => {
    reportOwnerlessPriorDebt({ ...BASE, basis: basis(3_000, 10_000) });
    expect(mockLogError).toHaveBeenCalledTimes(1);
  });
});
