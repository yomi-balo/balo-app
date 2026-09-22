import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { track, ONBOARDING_EVENTS } from '@/lib/analytics';
import { IntentStep } from './intent-step';

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const { mockCompleteOnboarding } = vi.hoisted(() => ({ mockCompleteOnboarding: vi.fn() }));
vi.mock('@/lib/auth/actions/complete-onboarding', () => ({
  completeOnboardingAction: mockCompleteOnboarding,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

function renderStep(overrides: Partial<React.ComponentProps<typeof IntentStep>> = {}): {
  onBack: ReturnType<typeof vi.fn>;
  onClientContinue: ReturnType<typeof vi.fn>;
} {
  const onBack = vi.fn();
  const onClientContinue = vi.fn();
  render(<IntentStep onBack={onBack} onClientContinue={onClientContinue} {...overrides} />);
  return { onBack, onClientContinue };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCompleteOnboarding.mockResolvedValue({
    success: true,
    data: { redirectTo: '/expert/apply' },
  });
});

describe('IntentStep', () => {
  it('names each choice by its title plus its visible call to action', () => {
    renderStep();
    const client = screen.getByRole('button', { name: 'Find an Expert Get started' });
    const expert = screen.getByRole('button', { name: 'Become an Expert Apply now' });
    expect(client).toHaveAccessibleDescription(
      'Get matched with top Salesforce consultants for your business.'
    );
    expect(expert).toHaveAccessibleDescription(
      'Apply to join our consultant network and grow your practice.'
    );
  });

  it('renders the heading and one h2 per choice', () => {
    renderStep();
    expect(
      screen.getByRole('heading', { level: 1, name: 'What brings you to Balo?' })
    ).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Find an Expert',
      'Become an Expert',
    ]);
  });

  it('client choice advances exactly once, even on a double click, without completing', async () => {
    const user = userEvent.setup();
    const { onClientContinue } = renderStep();

    await user.dblClick(screen.getByRole('button', { name: /find an expert/i }));

    expect(onClientContinue).toHaveBeenCalledTimes(1);
    expect(mockCompleteOnboarding).not.toHaveBeenCalled();
    expect(track).toHaveBeenCalledWith(ONBOARDING_EVENTS.STEP_COMPLETED, {
      step: 'intent',
      step_number: 3,
      value: 'client',
    });
  });

  it('expert choice shows its pending state and locks every control while completing', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mockCompleteOnboarding.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    renderStep();

    await user.click(screen.getByRole('button', { name: /become an expert/i }));

    const pending = screen.getByRole('button', { name: 'Become an Expert Setting up...' });
    expect(pending).toHaveAttribute('aria-busy', 'true');
    expect(pending).toBeDisabled();
    expect(screen.getByRole('button', { name: /find an expert/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /back/i })).toBeDisabled();

    resolve({ success: true, data: { redirectTo: '/expert/apply' } });
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/expert/apply'));
  });

  it('a pending apply-intent overrides the computed expert redirect', async () => {
    mockCompleteOnboarding.mockResolvedValue({ success: true, data: { redirectTo: '/dashboard' } });
    const user = userEvent.setup();
    renderStep({ pendingApplyReturnTo: '/expert/apply' });

    await user.click(screen.getByRole('button', { name: /become an expert/i }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/expert/apply'));
  });

  it('a failed expert completion toasts and re-enables both choices for a retry', async () => {
    mockCompleteOnboarding.mockResolvedValue({ success: false, error: 'Could not save' });
    const user = userEvent.setup();
    renderStep();

    await user.click(screen.getByRole('button', { name: /become an expert/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not save'));
    // `isPending` clears in its own commit after the failure branch's updates, so wait for
    // the re-enable itself rather than asserting it in the toast's tick.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Become an Expert Apply now' })).toBeEnabled()
    );
    expect(screen.getByRole('button', { name: /find an expert/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /back/i })).toBeEnabled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps containing-block utilities off the CTAs, so their overlay spans the whole card', () => {
    renderStep();
    for (const name of [/find an expert/i, /become an expert/i]) {
      const cta = screen.getByRole('button', { name });
      expect(cta.className).toContain('after:inset-0');
      expect(cta.className).not.toMatch(
        /(?:^|\s)(?:[\w-]+:)*-?(?:brightness|blur|contrast|saturate|grayscale|filter|backdrop|transform|translate|scale|rotate|will-change|contain)\b/
      );
    }
  });

  it('Back calls onBack', async () => {
    const user = userEvent.setup();
    const { onBack } = renderStep();
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
