import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/utils';
import userEvent from '@testing-library/user-event';

const { mockRedeem, mockToastSuccess } = vi.hoisted(() => ({
  mockRedeem: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock('../_actions/redeem-promo', () => ({
  redeemPromoCode: (...a: unknown[]) => mockRedeem(...a),
}));
vi.mock('sonner', () => ({ toast: { success: mockToastSuccess, error: vi.fn() } }));
// motion is mocked so the animated success card mounts synchronously in JSDOM.
vi.mock('motion/react', () => ({
  motion: { div: (props: Record<string, unknown>) => <div {...props} /> },
}));
// Stub the Stripe continue component — it is covered by its own test; here we only assert
// the panel renders it on success.
vi.mock('./continue-to-mandate', () => ({
  ContinueToMandate: ({ companyId }: { companyId: string }) => (
    <div data-testid="continue-to-mandate">{companyId}</div>
  ),
}));

import { RedeemPromoPanel } from './redeem-promo-panel';

const COMPANY = { companyName: 'Northwind Industrial', companyId: 'company-1' };

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.history.replaceState({}, '', '/');
});

async function submitCode(user: ReturnType<typeof userEvent.setup>, code = 'WELCOME50') {
  await user.type(screen.getByLabelText('Promo code'), code);
  await user.click(screen.getByRole('button', { name: /^redeem$/i }));
}

describe('RedeemPromoPanel', () => {
  it('renders the idle state with invitation copy and a disabled submit until a code is typed', () => {
    render(<RedeemPromoPanel {...COMPANY} />);
    expect(screen.getByRole('heading', { name: /redeem a promo code/i })).toBeInTheDocument();
    expect(screen.getByText(/Add the credit to Northwind Industrial/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^redeem$/i })).toBeDisabled();
  });

  it('shows the success card + continue hand-off + toast on a fresh redeem', async () => {
    mockRedeem.mockResolvedValue({
      status: 'redeemed',
      grantedLabel: 'A$50.00',
      balanceLabel: 'A$50.00',
      alreadyRedeemed: false,
    });
    const user = userEvent.setup();
    render(<RedeemPromoPanel {...COMPANY} />);
    await submitCode(user);

    expect(await screen.findByText(/you're all set/i)).toBeInTheDocument();
    expect(screen.getByText(/A\$50\.00 added to Northwind Industrial/i)).toBeInTheDocument();
    expect(screen.getByTestId('continue-to-mandate')).toHaveTextContent('company-1');
    expect(mockToastSuccess).toHaveBeenCalledWith('A$50.00 added to Northwind Industrial.');
  });

  it('shows the already-redeemed variant (no balance figure) with its own toast', async () => {
    mockRedeem.mockResolvedValue({
      status: 'redeemed',
      grantedLabel: 'A$50.00',
      balanceLabel: null,
      alreadyRedeemed: true,
    });
    const user = userEvent.setup();
    render(<RedeemPromoPanel {...COMPANY} />);
    await submitCode(user);

    expect(await screen.findByRole('heading', { name: /already redeemed/i })).toBeInTheDocument();
    expect(mockToastSuccess).toHaveBeenCalledWith(
      'This code was already redeemed for Northwind Industrial.'
    );
  });

  it.each([
    ['expired', /this code has expired/i],
    ['scheduled', /isn't active yet/i],
    ['deactivated', /no longer available/i],
    ['exhausted', /fully claimed/i],
    ['not_found', /couldn't find that code/i],
    ['error', /something went wrong/i],
  ])('renders the warm %s refusal inline', async (status, pattern) => {
    mockRedeem.mockResolvedValue({ status });
    const user = userEvent.setup();
    render(<RedeemPromoPanel {...COMPANY} />);
    await submitCode(user);
    expect(await screen.findByText(pattern)).toBeInTheDocument();
  });

  it('renders the forbidden refusal naming the company', async () => {
    mockRedeem.mockResolvedValue({ status: 'forbidden' });
    const user = userEvent.setup();
    render(<RedeemPromoPanel {...COMPANY} />);
    await submitCode(user);
    expect(await screen.findByText(/don't have permission to redeem/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Ask an owner or admin to redeem for Northwind Industrial/i)
    ).toBeInTheDocument();
  });

  it('surfaces the continue confirmation when returning from a 3DS redirect', async () => {
    globalThis.history.replaceState(
      {},
      '',
      '/redeem?setup_intent=seti_x&setup_intent_client_secret=seti_x_secret&redirect_status=succeeded'
    );
    render(<RedeemPromoPanel {...COMPANY} />);
    expect(await screen.findByTestId('continue-to-mandate')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /redeem a promo code/i })).not.toBeInTheDocument();
  });

  it('lets the user redeem another code from the success screen', async () => {
    mockRedeem.mockResolvedValue({
      status: 'redeemed',
      grantedLabel: 'A$50.00',
      balanceLabel: 'A$50.00',
      alreadyRedeemed: false,
    });
    const user = userEvent.setup();
    render(<RedeemPromoPanel {...COMPANY} />);
    await submitCode(user);
    await screen.findByText(/you're all set/i);

    await user.click(screen.getByRole('button', { name: /redeem another code/i }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /redeem a promo code/i })).toBeInTheDocument()
    );
  });
});
