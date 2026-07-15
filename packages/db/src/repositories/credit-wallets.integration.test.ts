import { describe, it, expect } from 'vitest';
import { creditWalletFactory } from '../test/factories';
import { companyFactory } from '../test/factories/company.factory';
import { creditWalletsRepository } from './credit-wallets';

/**
 * Integration tests for `creditWalletsRepository` (BAL-376). Uses the in-harness `db`
 * (per-test transaction, auto-rolled-back). Factories only — never raw inserts.
 */

describe('creditWalletsRepository.create', () => {
  it('creates one wallet per company with the schema defaults', async () => {
    const company = await companyFactory();
    const wallet = await creditWalletsRepository.create({ companyId: company.id });

    expect(wallet.id).toBeDefined();
    expect(wallet.companyId).toBe(company.id);
    expect(wallet.balanceMinor).toBe(0);
    expect(wallet.currency).toBe('AUD');
    expect(wallet.lowBalanceMode).toBe('notify_only');
    expect(wallet.topupThresholdMinor).toBe(2000);
    expect(wallet.topupReloadMinor).toBe(10_000);
    expect(wallet.overdraftCeilingMinor).toBeNull();
    expect(wallet.expiresAt).toBeNull();
    expect(wallet.stripePaymentMethodId).toBeNull();
    expect(wallet.mandateRef).toBeNull();
  });

  it('returns balanceMinor as a JS number (bigint accumulator, mode:number)', async () => {
    const { wallet } = await creditWalletFactory();
    expect(typeof wallet.balanceMinor).toBe('number');
  });

  it('rejects a second wallet for the same company (one-per-company unique)', async () => {
    const company = await companyFactory();
    await creditWalletsRepository.create({ companyId: company.id });
    await expect(creditWalletsRepository.create({ companyId: company.id })).rejects.toThrow();
  });
});

describe('creditWalletsRepository reads', () => {
  it('findById returns the wallet', async () => {
    const { wallet } = await creditWalletFactory();
    const found = await creditWalletsRepository.findById(wallet.id);
    expect(found?.id).toBe(wallet.id);
  });

  it('findByCompanyId returns the wallet for the company', async () => {
    const { wallet, companyId } = await creditWalletFactory();
    const found = await creditWalletsRepository.findByCompanyId(companyId);
    expect(found?.id).toBe(wallet.id);
  });

  it('findById returns undefined for an unknown id', async () => {
    const found = await creditWalletsRepository.findById('00000000-0000-0000-0000-000000000000');
    expect(found).toBeUndefined();
  });
});

describe('creditWalletsRepository.updateConfig', () => {
  it('writes each config field and leaves the rest untouched', async () => {
    const { wallet } = await creditWalletFactory();
    const updated = await creditWalletsRepository.updateConfig(wallet.id, {
      lowBalanceMode: 'auto_topup',
      topupThresholdMinor: 5000,
      topupReloadMinor: 25_000,
      overdraftCeilingMinor: 30_000,
      stripePaymentMethodId: 'pm_123',
      mandateRef: 'mandate_xyz',
    });

    expect(updated.lowBalanceMode).toBe('auto_topup');
    expect(updated.topupThresholdMinor).toBe(5000);
    expect(updated.topupReloadMinor).toBe(25_000);
    expect(updated.overdraftCeilingMinor).toBe(30_000);
    expect(updated.stripePaymentMethodId).toBe('pm_123');
    expect(updated.mandateRef).toBe('mandate_xyz');
    // Untouched fields keep their values.
    expect(updated.currency).toBe('AUD');
    expect(updated.balanceMinor).toBe(0);
  });

  it('clears a nullable field back to null (overdraft ceiling → platform default at the caller)', async () => {
    const { wallet } = await creditWalletFactory({ values: { overdraftCeilingMinor: 20_000 } });
    const cleared = await creditWalletsRepository.updateConfig(wallet.id, {
      overdraftCeilingMinor: null,
    });
    expect(cleared.overdraftCeilingMinor).toBeNull();
  });

  it('is a no-op passthrough when given no fields (returns the current row)', async () => {
    const { wallet } = await creditWalletFactory();
    const same = await creditWalletsRepository.updateConfig(wallet.id, {});
    expect(same.id).toBe(wallet.id);
  });

  it('throws for an unknown wallet id', async () => {
    await expect(
      creditWalletsRepository.updateConfig('00000000-0000-0000-0000-000000000000', {
        lowBalanceMode: 'keep_going',
      })
    ).rejects.toThrow(/not found/i);
  });
});
