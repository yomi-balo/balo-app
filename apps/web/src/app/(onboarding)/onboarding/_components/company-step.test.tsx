import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, AUTH_EVENTS, ONBOARDING_EVENTS, DOMAIN_JOIN_EVENTS } from '@/lib/analytics';
import type { AuthMethodSignal } from '@/lib/auth/auth-method';

// ── Mocks ───────────────────────────────────────────────────────

const mockPush = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const { mockResolve, mockComplete, mockJoinMatched, mockRequestJoin, mockCompleteOnboarding } =
  vi.hoisted(() => ({
    mockResolve: vi.fn(),
    mockComplete: vi.fn(),
    mockJoinMatched: vi.fn(),
    mockRequestJoin: vi.fn(),
    mockCompleteOnboarding: vi.fn(),
  }));

vi.mock('@/lib/auth/actions', () => ({
  resolveOnboardingCompanyAction: mockResolve,
  nameWorkspaceAndCompleteAction: mockComplete,
  joinMatchedCompanyAction: mockJoinMatched,
  requestJoinCompanyAction: mockRequestJoin,
  completeOnboardingAction: mockCompleteOnboarding,
}));

import { CompanyStep } from './company-step';

// ── Helpers ─────────────────────────────────────────────────────

function renderStep(authMethod: AuthMethodSignal = 'email') {
  return render(
    <CompanyStep authMethod={authMethod} timezone="Europe/London" stepNumber={5} onBack={vi.fn()} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockComplete.mockResolvedValue({ success: true, data: { redirectTo: '/dashboard' } });
  mockJoinMatched.mockResolvedValue({ success: true, data: { redirectTo: '/dashboard' } });
  mockRequestJoin.mockResolvedValue({ success: true, data: { status: 'pending' } });
  mockCompleteOnboarding.mockResolvedValue({ success: true, data: { redirectTo: '/dashboard' } });
});

// ── Tests ───────────────────────────────────────────────────────

describe('CompanyStep', () => {
  it('shows the resolving spinner while the workspace identity resolves', () => {
    mockResolve.mockReturnValue(new Promise(() => {})); // never settles
    renderStep();
    expect(screen.getByText(/setting up your workspace/i)).toBeInTheDocument();
  });

  it('renders the create form prefilled with the email-derived suggestion', async () => {
    mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    expect(screen.getByLabelText(/company name/i)).toHaveValue('Acme');
    expect(screen.getByText(/we suggested this from your email/i)).toBeInTheDocument();
  });

  it('renders the blocked-domain helper copy and an empty field', async () => {
    mockResolve.mockResolvedValue({ status: 'blocked', suggestion: '' });
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    expect(screen.getByLabelText(/company name/i)).toHaveValue('');
    expect(screen.getByText(/tell us your company or team name/i)).toBeInTheDocument();
  });

  it('shows a required error and does not submit when the name is empty', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ status: 'blocked', suggestion: '' });
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(await screen.findByText(/enter a name for your workspace/i)).toBeInTheDocument();
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it.each<AuthMethodSignal>(['email', 'oauth_google'])(
    'completes the create branch and fires analytics for auth_method=%s',
    async (authMethod) => {
      const user = userEvent.setup();
      mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
      renderStep(authMethod);

      await screen.findByRole('heading', { name: /name your workspace/i });
      await user.click(screen.getByRole('button', { name: /continue/i }));

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
      expect(mockComplete).toHaveBeenCalledWith('Acme');
      expect(track).toHaveBeenCalledWith(AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED, {
        domain_type: 'new',
        prefill_used: true,
        prefill_edited: false,
        auth_method: authMethod,
      });
      expect(track).toHaveBeenCalledWith(
        ONBOARDING_EVENTS.COMPLETED,
        expect.objectContaining({ intent: 'client', timezone: 'Europe/London' })
      );
    }
  );

  it('marks prefill_edited when the user changes the suggested name', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
    renderStep();

    const input = await screen.findByLabelText(/company name/i);
    await user.clear(input);
    await user.type(input, 'Acme Corp');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(mockComplete).toHaveBeenCalledWith('Acme Corp'));
    expect(track).toHaveBeenCalledWith(
      AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED,
      expect.objectContaining({ prefill_used: true, prefill_edited: true })
    );
  });

  it('reports domain_type blocked with prefill_used false for a blocked domain', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ status: 'blocked', suggestion: '' });
    renderStep();

    const input = await screen.findByLabelText(/company name/i);
    await user.type(input, 'My Team');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    await waitFor(() => expect(mockComplete).toHaveBeenCalledWith('My Team'));
    expect(track).toHaveBeenCalledWith(
      AUTH_EVENTS.SIGNUP_COMPANY_NAME_CAPTURED,
      expect.objectContaining({
        domain_type: 'blocked',
        prefill_used: false,
        prefill_edited: false,
      })
    );
  });

  it('shows a retryable error banner when the save fails and keeps the form editable', async () => {
    const user = userEvent.setup();
    mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
    mockComplete.mockResolvedValue({
      success: false,
      error: "We couldn't save that just now. Please try again.",
    });
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    await user.click(screen.getByRole('button', { name: /continue/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/couldn't save that just now/i);
    // Form stays editable (retryable).
    expect(screen.getByLabelText(/company name/i)).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();
  });

  describe('JOIN branch (dormant — driven via a matched resolve)', () => {
    function matched(joinMode: 'auto' | 'request') {
      return {
        status: 'matched',
        company: { name: 'Northwind', memberCount: 42, joinMode },
        suggestion: 'Northwind',
      };
    }

    it('renders the auto interstitial with the member count and fires INTERSTITIAL_VIEWED', async () => {
      mockResolve.mockResolvedValue(matched('auto'));
      renderStep();

      await screen.findByRole('heading', { name: /join northwind\?/i });
      expect(screen.getByText(/42 teammates already on balo/i)).toBeInTheDocument();
      expect(track).toHaveBeenCalledWith(DOMAIN_JOIN_EVENTS.INTERSTITIAL_VIEWED, {
        mode: 'auto',
        party_type: 'company',
      });
    });

    it('auto-joins on the primary action and fires the completion analytics', async () => {
      const user = userEvent.setup();
      mockResolve.mockResolvedValue(matched('auto'));
      renderStep('oauth_google');

      await screen.findByRole('heading', { name: /join northwind\?/i });
      await user.click(screen.getByRole('button', { name: /^join northwind$/i }));

      await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/dashboard'));
      expect(mockJoinMatched).toHaveBeenCalledOnce();
      expect(track).toHaveBeenCalledWith(DOMAIN_JOIN_EVENTS.INTERSTITIAL_CONTINUED, {
        mode: 'auto',
        party_type: 'company',
      });
      expect(track).toHaveBeenCalledWith(AUTH_EVENTS.SIGNUP_COMPANY_JOINED, {
        party_type: 'company',
        auth_method: 'oauth_google',
      });
      expect(track).toHaveBeenCalledWith(
        ONBOARDING_EVENTS.COMPLETED,
        expect.objectContaining({ intent: 'client', timezone: 'Europe/London' })
      );
    });

    it('shows an inline banner and does not navigate when the auto-join write fails', async () => {
      const user = userEvent.setup();
      mockResolve.mockResolvedValue(matched('auto'));
      mockJoinMatched.mockResolvedValue({
        success: false,
        error: "We couldn't add you to that workspace just now. Please try again.",
      });
      renderStep();

      await screen.findByRole('heading', { name: /join northwind\?/i });
      await user.click(screen.getByRole('button', { name: /^join northwind$/i }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/couldn't add you to that workspace/i);
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('files a request and transitions to the pending screen in request mode', async () => {
      const user = userEvent.setup();
      mockResolve.mockResolvedValue(matched('request'));
      renderStep();

      await screen.findByRole('heading', { name: /join northwind\?/i });
      expect(screen.getByText(/an admin will review your request/i)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /request to join northwind/i }));

      expect(
        await screen.findByRole('heading', { name: /request sent to northwind/i })
      ).toBeInTheDocument();
      expect(mockRequestJoin).toHaveBeenCalledOnce();
      expect(track).toHaveBeenCalledWith(DOMAIN_JOIN_EVENTS.INTERSTITIAL_CONTINUED, {
        mode: 'request',
        party_type: 'company',
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it('shows an inline banner and stays on the interstitial when the request write fails', async () => {
      const user = userEvent.setup();
      mockResolve.mockResolvedValue(matched('request'));
      mockRequestJoin.mockResolvedValue({
        success: false,
        error: "We couldn't send your request just now. Nothing was changed — please try again.",
      });
      renderStep();

      await screen.findByRole('heading', { name: /join northwind\?/i });
      await user.click(screen.getByRole('button', { name: /request to join northwind/i }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/nothing was changed/i);
      expect(
        screen.queryByRole('heading', { name: /request sent to northwind/i })
      ).not.toBeInTheDocument();
    });

    it('escapes to a create form prefilled with the matched suggestion and fires OPTED_OUT', async () => {
      const user = userEvent.setup();
      mockResolve.mockResolvedValue(matched('auto'));
      renderStep();

      await screen.findByRole('heading', { name: /join northwind\?/i });
      await user.click(screen.getByRole('button', { name: /this isn't my company/i }));

      expect(
        await screen.findByRole('heading', { name: /name your workspace/i })
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/company name/i)).toHaveValue('Northwind');
      expect(track).toHaveBeenCalledWith(DOMAIN_JOIN_EVENTS.INTERSTITIAL_OPTED_OUT, {
        mode: 'auto',
        party_type: 'company',
      });
    });
  });

  it('fails open to an empty create form when the resolve RPC rejects', async () => {
    mockResolve.mockRejectedValue(new Error('rpc down'));
    renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    expect(screen.getByLabelText(/company name/i)).toHaveValue('');
  });

  it('has no accessibility violations in the create state', async () => {
    mockResolve.mockResolvedValue({ status: 'new', suggestion: 'Acme' });
    const { container } = renderStep();

    await screen.findByRole('heading', { name: /name your workspace/i });
    expect(await axe(container)).toHaveNoViolations();
  });
});
