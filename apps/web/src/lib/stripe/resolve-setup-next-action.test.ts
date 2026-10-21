import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockGetStripe, mockHandleNextAction } = vi.hoisted(() => ({
  mockGetStripe: vi.fn(),
  mockHandleNextAction: vi.fn(),
}));

vi.mock('@/lib/stripe/loader', () => ({ getStripe: mockGetStripe }));

import { resolveSetupIntentNextAction } from './resolve-setup-next-action';

describe('resolveSetupIntentNextAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_1');
    mockGetStripe.mockResolvedValue({ handleNextAction: mockHandleNextAction });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is false without a publishable key', async () => {
    vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', '');
    expect(await resolveSetupIntentNextAction('seti_secret')).toBe(false);
    expect(mockGetStripe).not.toHaveBeenCalled();
  });

  it('is false when Stripe fails to load', async () => {
    mockGetStripe.mockResolvedValue(null);
    expect(await resolveSetupIntentNextAction('seti_secret')).toBe(false);
  });

  it('is true when the challenge succeeds', async () => {
    mockHandleNextAction.mockResolvedValue({ setupIntent: { status: 'succeeded' } });
    expect(await resolveSetupIntentNextAction('seti_secret')).toBe(true);
    expect(mockHandleNextAction).toHaveBeenCalledWith({ clientSecret: 'seti_secret' });
  });

  it('is false on an error, an abandoned challenge, or a rejection', async () => {
    mockHandleNextAction.mockResolvedValueOnce({ error: { message: 'nope' } });
    expect(await resolveSetupIntentNextAction('s')).toBe(false);

    mockHandleNextAction.mockResolvedValueOnce({ setupIntent: { status: 'requires_action' } });
    expect(await resolveSetupIntentNextAction('s')).toBe(false);

    mockHandleNextAction.mockRejectedValueOnce(new Error('boom'));
    expect(await resolveSetupIntentNextAction('s')).toBe(false);
  });
});
