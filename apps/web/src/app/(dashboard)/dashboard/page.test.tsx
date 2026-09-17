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
  ExpertDashboard: ({ upNext }: { upNext: React.ReactNode }) => (
    <div data-testid="expert-dashboard">{upNext}</div>
  ),
}));
vi.mock('./_components/dashboard-wallet-slot', () => ({
  DashboardWalletSlot: () => <div data-testid="wallet-slot" />,
}));
vi.mock('./_components/company-up-next-slot', () => ({
  CompanyUpNextSlot: () => <div data-testid="company-up-next-slot" />,
}));
vi.mock('./_components/expert-up-next-slot', () => ({
  ExpertUpNextSlot: () => <div data-testid="expert-up-next-slot" />,
}));
vi.mock('./_components/up-next-card-skeleton', () => ({
  UpNextCardSkeleton: () => <div data-testid="skeleton" />,
}));

import DashboardPage from './page';

beforeEach(() => {
  vi.clearAllMocks();
  mockBuildNavContext.mockResolvedValue({ workspaceType: 'company', capabilities: [] });
  mockResolveUpNextFooterLinks.mockReturnValue([]);
});

/** `a` precedes `b` in DOM order (a comes before b, not just "is an ancestor"). */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe('DashboardPage — company branch', () => {
  it('F4: renders Up next, then the wallet slot, then the promo link, then the metric placeholders, in real DOM order', async () => {
    mockGetCurrentUser.mockResolvedValue({ id: 'u-1', activeMode: 'client' });
    mockRequireUser.mockResolvedValue({ id: 'u-1' });
    mockGetCompanyContext.mockResolvedValue({ companyId: 'co-1', companyName: 'Northwind' });

    const element = await DashboardPage();
    const { container } = render(element);

    const upNext = screen.getByTestId('company-up-next-slot');
    const wallet = screen.getByTestId('wallet-slot');
    const promo = screen.getByText('Have a promo code?');
    const metricGrid = container.querySelector('.mt-4.grid');
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(wallet).toBeInTheDocument(); // non-vacuity: the wallet slot really renders
    expect(metricGrid).not.toBeNull();
    if (metricGrid === null) throw new Error('metric placeholder grid not found');

    expect(precedes(upNext, wallet)).toBe(true);
    expect(precedes(wallet, promo)).toBe(true);
    expect(precedes(promo, metricGrid)).toBe(true);
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
   * `expertProfileId` is representable. The branch gates on truthiness — as `requireExpert()`
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
});
