import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/credit/actions', () => ({
  saveLowBalanceConfigAction: vi.fn(),
  armSavedCardMandateAction: vi.fn(),
  startCardCaptureAction: vi.fn(),
}));
vi.mock('@/lib/stripe/resolve-setup-next-action', () => ({
  resolveSetupIntentNextAction: vi.fn(),
}));

import type { Stripe, StripeElements } from '@stripe/stripe-js';
import {
  armSavedCardMandateAction,
  saveLowBalanceConfigAction,
  startCardCaptureAction,
} from '@/lib/credit/actions';
import { resolveSetupIntentNextAction } from '@/lib/stripe/resolve-setup-next-action';
import { armSavedCard, captureNewCard, switchToKeepGoing } from './pay-after-steps';

const FIGURES = { topupReloadMinor: 10_000, topupThresholdMinor: 2_000 };
const hooks = { onAuthenticating: vi.fn(), onSwitched: vi.fn() };

const confirmSetup = vi.fn();
const submit = vi.fn();
const stripe = { confirmSetup } as unknown as Stripe;
const elements = { submit } as unknown as StripeElements;

describe('pay-after steps', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('location', { origin: 'https://app.test', pathname: '/book' });
    vi.mocked(saveLowBalanceConfigAction).mockResolvedValue({ ok: true });
    submit.mockResolvedValue({});
    vi.mocked(startCardCaptureAction).mockResolvedValue({
      ok: true,
      clientSecret: 'seti_secret',
      setupIntentId: 'seti_1',
      publishableKey: 'pk_test',
    });
    confirmSetup.mockResolvedValue({});
  });

  describe('switchToKeepGoing', () => {
    it('saves keep_going with the wallet figures unchanged', async () => {
      await expect(switchToKeepGoing(FIGURES)).resolves.toEqual({ ok: true });
      expect(saveLowBalanceConfigAction).toHaveBeenCalledWith({
        lowBalanceMode: 'keep_going',
        topupReloadMinor: 10_000,
        topupThresholdMinor: 2_000,
      });
    });

    it.each(['no_saved_card', 'unauthorized', 'invalid_input', 'settlement_outstanding'] as const)(
      'maps a %s refusal to setup_failed',
      async (error) => {
        vi.mocked(saveLowBalanceConfigAction).mockResolvedValue({ ok: false, error });
        await expect(switchToKeepGoing(FIGURES)).resolves.toEqual({
          ok: false,
          reason: 'setup_failed',
        });
      }
    );
  });

  describe('armSavedCard', () => {
    it('saves the mode BEFORE arming the mandate, with a fresh request id', async () => {
      const order: string[] = [];
      vi.mocked(saveLowBalanceConfigAction).mockImplementation(async () => {
        order.push('save');
        return { ok: true };
      });
      vi.mocked(armSavedCardMandateAction).mockImplementation(async () => {
        order.push('arm');
        return { ok: true, outcome: 'captured' };
      });
      await expect(armSavedCard(FIGURES, hooks)).resolves.toEqual({ ok: true });
      expect(order).toEqual(['save', 'arm']);
      expect(hooks.onSwitched).toHaveBeenCalledTimes(1);
      expect(armSavedCardMandateAction).toHaveBeenCalledWith({
        clientRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
    });

    it('does not arm when the save is refused', async () => {
      vi.mocked(saveLowBalanceConfigAction).mockResolvedValue({
        ok: false,
        error: 'no_saved_card',
      });
      await expect(armSavedCard(FIGURES, hooks)).resolves.toEqual({
        ok: false,
        reason: 'setup_failed',
      });
      expect(armSavedCardMandateAction).not.toHaveBeenCalled();
      expect(hooks.onSwitched).not.toHaveBeenCalled();
    });

    it.each(['failed', 'no_saved_card', 'unauthorized'] as const)(
      'maps an arm %s to arm_failed (the mode was already switched)',
      async (error) => {
        vi.mocked(armSavedCardMandateAction).mockResolvedValue({ ok: false, error });
        await expect(armSavedCard(FIGURES, hooks)).resolves.toEqual({
          ok: false,
          reason: 'arm_failed',
        });
      }
    );

    it('resolves a bank challenge inline and reports it', async () => {
      vi.mocked(armSavedCardMandateAction).mockResolvedValue({
        ok: true,
        outcome: 'requires_action',
        clientSecret: 'seti_secret',
      });
      vi.mocked(resolveSetupIntentNextAction).mockResolvedValue(true);
      await expect(armSavedCard(FIGURES, hooks)).resolves.toEqual({ ok: true });
      expect(hooks.onAuthenticating).toHaveBeenCalledTimes(1);
      expect(resolveSetupIntentNextAction).toHaveBeenCalledWith('seti_secret');
    });

    it('maps an abandoned challenge to auth_failed', async () => {
      vi.mocked(armSavedCardMandateAction).mockResolvedValue({
        ok: true,
        outcome: 'requires_action',
        clientSecret: 'seti_secret',
      });
      vi.mocked(resolveSetupIntentNextAction).mockResolvedValue(false);
      await expect(armSavedCard(FIGURES, hooks)).resolves.toEqual({
        ok: false,
        reason: 'auth_failed',
      });
    });
  });

  describe('captureNewCard', () => {
    it('validates, opens the SetupIntent and confirms it inline without a redirect', async () => {
      await expect(captureNewCard(stripe, elements)).resolves.toEqual({ ok: true });
      expect(confirmSetup).toHaveBeenCalledWith({
        elements,
        clientSecret: 'seti_secret',
        confirmParams: {
          return_url: 'https://app.test/book',
        },
        redirect: 'if_required',
      });
    });

    it('never writes the low-balance setting', async () => {
      await captureNewCard(stripe, elements);
      expect(saveLowBalanceConfigAction).not.toHaveBeenCalled();
    });

    it('stops silently on an Element validation error, opening no SetupIntent', async () => {
      submit.mockResolvedValue({ error: { message: 'Incomplete' } });
      await expect(captureNewCard(stripe, elements)).resolves.toEqual({
        ok: false,
        reason: 'error',
        silent: true,
      });
      expect(startCardCaptureAction).not.toHaveBeenCalled();
    });

    it('maps settlement_outstanding to its own failure', async () => {
      vi.mocked(startCardCaptureAction).mockResolvedValue({
        ok: false,
        error: 'settlement_outstanding',
      });
      await expect(captureNewCard(stripe, elements)).resolves.toEqual({
        ok: false,
        reason: 'settlement_outstanding',
      });
      expect(confirmSetup).not.toHaveBeenCalled();
    });

    it.each(['unauthorized', 'unconfigured', 'error'] as const)(
      'maps a start %s to setup_failed',
      async (error) => {
        vi.mocked(startCardCaptureAction).mockResolvedValue({ ok: false, error });
        await expect(captureNewCard(stripe, elements)).resolves.toEqual({
          ok: false,
          reason: 'setup_failed',
        });
      }
    );

    it.each([
      [{ type: 'card_error', code: 'setup_intent_authentication_failure' }, 'auth_failed'],
      [{ type: 'card_error', code: 'card_declined' }, 'declined'],
      [{ type: 'api_connection_error' }, 'error'],
    ] as const)('maps the confirm error %j to %s', async (error, reason) => {
      confirmSetup.mockResolvedValue({ error });
      await expect(captureNewCard(stripe, elements)).resolves.toEqual({ ok: false, reason });
    });
  });
});
