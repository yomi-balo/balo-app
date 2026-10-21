import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';

const mockGetCurrentUser = vi.fn();
const mockRequireUser = vi.fn();
const mockGetCompanyContext = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => mockGetCurrentUser(),
  requireUser: () => mockRequireUser(),
  getCompanyContext: () => mockGetCompanyContext(),
}));

const mockGetChecklistStatus = vi.fn();
vi.mock('@/lib/actions/expert-checklist', () => ({
  getChecklistStatus: () => mockGetChecklistStatus(),
}));

const mockBuildNavContext = vi.fn();
vi.mock('@/lib/navigation/nav-context', () => ({
  buildNavContext: (...a: unknown[]) => mockBuildNavContext(...a),
  navWorkspaceTypeOf: (user: { activeMode?: string } | null) =>
    user?.activeMode === 'expert' ? 'expert' : 'company',
}));

const mockResolveUpNextFooterLinks = vi.fn();
vi.mock('./_lib/up-next-footer-links', () => ({
  resolveUpNextFooterLinks: (...a: unknown[]) => mockResolveUpNextFooterLinks(...a),
}));

vi.mock('@/lib/logging', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('./_components/expert-dashboard', () => ({
  ExpertDashboard: ({
    upNext,
    yourMove,
  }: {
    upNext: React.ReactNode;
    yourMove: React.ReactNode;
  }) => (
    <div data-testid="expert-dashboard">
      {yourMove}
      {upNext}
    </div>
  ),
}));
vi.mock('./_components/dashboard-refresh-on-focus', () => ({
  DashboardRefreshOnFocus: () => <div data-testid="refresh-on-focus" />,
}));
let walletSuspends = false;
vi.mock('./_components/dashboard-wallet-slot', () => ({
  DashboardWalletSlot: () => {
    if (walletSuspends) throw new Promise(() => {});
    return <div data-testid="wallet-slot" />;
  },
}));
vi.mock('./_components/company-up-next-slot', () => ({
  CompanyUpNextSlot: () => <div data-testid="company-up-next-slot" />,
}));
const mockYourMoveSlot = vi.fn();
vi.mock('./_components/your-move-slot', () => ({
  YourMoveSlot: (props: unknown) => {
    mockYourMoveSlot(props);
    return <div data-testid="your-move-slot" />;
  },
}));
vi.mock('./_components/your-move-skeleton', () => ({
  YourMoveSkeleton: () => <div data-testid="your-move-skeleton" />,
}));
const mockCompanyYourMoveSlot = vi.fn();
vi.mock('./_components/company-your-move-slot', () => ({
  CompanyYourMoveSlot: (props: unknown) => {
    mockCompanyYourMoveSlot(props);
    return <div data-testid="company-your-move-slot" />;
  },
}));
vi.mock('./_components/expert-up-next-slot', () => ({
  ExpertUpNextSlot: () => <div data-testid="expert-up-next-slot" />,
}));
const mockApplicationReviewBannerSlot = vi.fn();
vi.mock('./_components/application-review-banner-slot', () => ({
  ApplicationReviewBannerSlot: (props: { userId: string; email: string }) => {
    mockApplicationReviewBannerSlot(props);
    return <div data-testid="application-review-banner-slot" />;
  },
}));
vi.mock('./_components/up-next-card-skeleton', () => ({
  UpNextCardSkeleton: () => <div data-testid="skeleton" />,
}));

import DashboardPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  walletSuspends = false;
  mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });
  mockResolveUpNextFooterLinks.mockReturnValue([]);
});

/** `a` precedes `b` in DOM order (a comes before b, not just "is an ancestor"). */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('DashboardPage — company branch', () => {
  it('renders the header, then Up next, then the wallet slot, then Your move, in real DOM order', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'client' });
    mockRequireUser.mockResolvedValue({ id: 'u-1', firstName: 'Dana' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });

    const { container } = render(await DashboardPage());

    const header = screen.getByRole('heading', { name: 'Welcome back, Dana' });
    const yourMove = screen.getByTestId('company-your-move-slot');
    const upNext = screen.getByTestId('company-up-next-slot');
    const wallet = screen.getByTestId('wallet-slot');

    expect(precedes(header, upNext)).toBe(true);
    expect(precedes(upNext, wallet)).toBe(true);
    expect(precedes(wallet, yourMove)).toBe(true);
    expect(screen.queryByText('Have a promo code?')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeNull();
    expect(mockCompanyYourMoveSlot).toHaveBeenCalledWith({
      user: { id: 'u-1', firstName: 'Dana' },
      companyId: 'co-1',
      companyName: 'Northwind',
    });
  });

  it('places the application-review banner before Up next', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'client' });
    mockRequireUser.mockResolvedValue({ id: 'u-1', firstName: 'Dana', email: 'd@x.co' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });

    render(await DashboardPage());

    expect(
      precedes(
        screen.getByTestId('application-review-banner-slot'),
        screen.getByTestId('company-up-next-slot')
      )
    ).toBe(true);
  });

  it('stretches the top-row grid so both columns share one height', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'client' });
    mockRequireUser.mockResolvedValue({ id: 'u-1', firstName: 'Dana' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });

    render(await DashboardPage());

    const grid = screen.getByTestId('company-up-next-slot').closest('.grid');
    expect(grid).toHaveClass('items-stretch');
    expect(grid).not.toHaveClass('items-start');
  });

  it('renders a full-width wallet loading fallback without a promo entry', async () => {
    walletSuspends = true;
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'client' });
    mockRequireUser.mockResolvedValue({ id: 'u-1', firstName: 'Dana' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });

    render(await DashboardPage());

    const fallback = screen.getByLabelText('Loading wallet balance');
    expect(fallback).toHaveClass('max-w-none', 'shadow-sm');
    expect(fallback).not.toHaveClass('max-w-[380px]');
    expect(fallback).not.toHaveClass('flex-col');
    expect(screen.queryByText('Have a promo code?')).toBeNull();
  });

  it('mounts the refresh-on-focus listener exactly once', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'client' });
    mockRequireUser.mockResolvedValue({ id: 'u-1', firstName: 'Dana' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });

    render(await DashboardPage());

    expect(screen.getAllByTestId('refresh-on-focus')).toHaveLength(1);
  });

  it('greets by first name with the company in the sub-line, falling back to "there"', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'client' });
    mockRequireUser.mockResolvedValue({ id: 'u-1', firstName: null });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });

    render(await DashboardPage());

    expect(screen.getByRole('heading', { name: 'Welcome back, there' })).toBeInTheDocument();
    expect(screen.getByText('Here’s what’s happening across Northwind.')).toBeInTheDocument();
  });

  it('mounts the under-review banner slot for the actor, above Your move', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'client' });
    mockRequireUser.mockResolvedValue({ id: 'u-1', email: 'dana@northwind.test' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });

    render(await DashboardPage());

    const banner = screen.getByTestId('application-review-banner-slot');
    expect(mockApplicationReviewBannerSlot).toHaveBeenCalledWith({
      userId: 'u-1',
      email: 'dana@northwind.test',
    });
    expect(precedes(banner, screen.getByTestId('company-your-move-slot'))).toBe(true);
  });

  it('does not render the expert dashboard when activeMode is client', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'client' });
    mockRequireUser.mockResolvedValue({ id: 'u-1' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });

    const element = await DashboardPage();
    render(element);
    expect(screen.queryByTestId('expert-dashboard')).toBeNull();
  });

  it('an expert-mode user with no expertProfileId still renders the company dashboard, with COMPANY footer links (F6)', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'expert' });
    mockRequireUser.mockResolvedValue({ id: 'u-1' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'expert', capabilities: [] });

    const element = await DashboardPage();
    render(element);
    expect(screen.queryByTestId('expert-dashboard')).toBeNull();
    expect(screen.getByTestId('company-up-next-slot')).toBeInTheDocument();
    // F6 — even though navContext.workspaceType reads 'expert' here (R1/D11), the COMPANY branch
    // is what actually renders, so the resolver must be asked for COMPANY footer links, not
    // whatever navContext.workspaceType says.
    expect(mockResolveUpNextFooterLinks).toHaveBeenCalledWith(
      { workspaceType: 'expert', capabilities: [] },
      'company'
    );
  });

  /**
   * `SessionUser` is a type assertion over cookie JSON with no runtime validation, so a BLANK
   * `expertProfileId` is representable. The branch gates on truthiness — as `resolveApprovedExpert()`
   * does — so a blank id lands here rather than on an expert dashboard whose every read
   * ('' as a profile id) can only come back empty.
   */
  it('an expert-mode user whose expertProfileId is an empty string renders the company dashboard', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'expert', expertProfileId: '' });
    mockRequireUser.mockResolvedValue({ id: 'u-1' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });
    mockBuildNavContext.mockResolvedValue({ workspaceType: 'expert', capabilities: [] });

    const element = await DashboardPage();
    render(element);
    expect(screen.queryByTestId('expert-dashboard')).toBeNull();
    expect(screen.getByTestId('company-up-next-slot')).toBeInTheDocument();
  });
});

describe('DashboardPage — expert branch', () => {
  it('renders ExpertDashboard with an upNext element (the Suspense-wrapped slot)', async () => {
    mockGetCurrentUser.mockResolvedValue({
      id: 'u-1',
      activeMode: 'expert',
      expertProfileId: 'profile-1',
      firstName: 'Priya',
    });
    mockGetChecklistStatus.mockResolvedValue({
      items: {
        profile: true,
        phone: true,
        rate: true,
        calendar: true,
        availability: true,
        payouts: true,
      },
      completedCount: 6,
      allComplete: true,
      rateCents: 313,
      calendarNeedsReconnect: false,
    });

    const element = await DashboardPage();
    render(element);

    expect(screen.getByTestId('expert-dashboard')).toBeInTheDocument();
    expect(screen.getByTestId('expert-up-next-slot')).toBeInTheDocument();
    expect(mockResolveUpNextFooterLinks).toHaveBeenCalledWith(
      { workspaceType: 'company', capabilities: [] },
      'expert'
    );
  });

  it.each([
    [true, true],
    [false, false],
  ])('passes calendarNeedsReconnect=%s through to the Your move slot', async (flag, expected) => {
    mockGetCurrentUser.mockResolvedValue({
      id: 'u-1',
      activeMode: 'expert',
      expertProfileId: 'profile-1',
    });
    mockGetChecklistStatus.mockResolvedValue({ allComplete: true, calendarNeedsReconnect: flag });

    render(await DashboardPage());

    expect(screen.getByTestId('your-move-slot')).toBeInTheDocument();
    expect(mockYourMoveSlot).toHaveBeenCalledWith(
      expect.objectContaining({ expertProfileId: 'profile-1', calendarNeedsReconnect: expected })
    );
  });

  it('keeps the Your move rail when the checklist read fails, with no reconnect blocker', async () => {
    mockGetCurrentUser.mockResolvedValue({
      id: 'u-1',
      activeMode: 'expert',
      expertProfileId: 'profile-1',
    });
    mockGetChecklistStatus.mockRejectedValue(new Error('boom'));

    render(await DashboardPage());

    expect(mockYourMoveSlot).toHaveBeenCalledWith(
      expect.objectContaining({ calendarNeedsReconnect: false })
    );
  });
});
