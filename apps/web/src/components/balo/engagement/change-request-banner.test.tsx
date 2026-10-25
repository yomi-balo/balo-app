import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen, waitFor } from '@/test/utils';
import type { ChangeRequestBannerView } from '@/lib/engagement/engagement-view';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/app/(dashboard)/engagements/[id]/_actions/request-completion', () => ({
  requestCompletionAction: vi.fn(),
}));

import { ChangeRequestBanner } from './change-request-banner';
import { requestCompletionAction } from '@/app/(dashboard)/engagements/[id]/_actions/request-completion';

const requestMock = vi.mocked(requestCompletionAction);

type Banner<V extends ChangeRequestBannerView['variant']> = Extract<
  ChangeRequestBannerView,
  { variant: V }
>;

const outstanding: Banner<'work_outstanding'> = {
  variant: 'work_outstanding',
  headline: 'Dana @ Northwind Industrial requested changes on Build.',
  quote: 'The dashboard needs the pipeline widget before we sign off.',
  guidance: 'Build is back in progress. Complete it, then mark the project ready again.',
};

const changesMade: Banner<'changes_made'> = {
  variant: 'changes_made',
  headline: 'Changes made. Ready to send back to Northwind Industrial?',
  reminder: 'Dana @ Northwind Industrial asked: “Add the pipeline widget.”',
  ctaLabel: 'Mark project ready again',
  modalBody: 'All 2 milestones are delivered. Northwind Industrial reviews the whole project…',
};

function renderBanner(banner: ChangeRequestBannerView): void {
  render(
    <ChangeRequestBanner
      banner={banner}
      engagementId="eng-1"
      clientCompanyName="Northwind Industrial"
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  requestMock.mockResolvedValue({ success: true });
});

describe('ChangeRequestBanner — work_outstanding', () => {
  it('renders the headline, the quoted note and the guidance', () => {
    renderBanner(outstanding);
    expect(screen.getByText(outstanding.headline)).toBeInTheDocument();
    expect(screen.getByText(/pipeline widget/)).toBeInTheDocument();
    expect(screen.getByText(/Build is back in progress/)).toBeInTheDocument();
  });

  it('omits the guidance for the admin lens (guidance null)', () => {
    renderBanner({ ...outstanding, guidance: null });
    expect(screen.queryByText(/back in progress/)).not.toBeInTheDocument();
    expect(screen.getByText(/pipeline widget/)).toBeInTheDocument();
  });

  it('carries no action button', () => {
    renderBanner(outstanding);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ChangeRequestBanner — landmark', () => {
  it('renders every variant as a labelled region, never a live region', () => {
    const variants: ChangeRequestBannerView[] = [
      outstanding,
      changesMade,
      { variant: 'client_waiting', body: 'You requested changes on Build.' },
    ];
    for (const banner of variants) {
      const { unmount } = render(
        <ChangeRequestBanner
          banner={banner}
          engagementId="eng-1"
          clientCompanyName="Northwind Industrial"
        />
      );
      expect(screen.getByRole('region', { name: 'Change request' })).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      unmount();
    }
  });
});

describe('ChangeRequestBanner — client_waiting', () => {
  it('renders the client acknowledgement and no button', () => {
    renderBanner({
      variant: 'client_waiting',
      body: "You requested changes on Build. Priya is working on them, and you'll be told when the project is ready again.",
    });
    expect(screen.getByText(/You requested changes on Build/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ChangeRequestBanner — changes_made', () => {
  it('renders the headline, the reminder and the single mark-ready-again control', () => {
    renderBanner(changesMade);
    expect(screen.getByText(/Changes made\. Ready to send back/)).toBeInTheDocument();
    expect(screen.getByText(/Add the pipeline widget/)).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Mark project ready again' })).toBeEnabled();
  });

  it('confirms in a dialog, then sends the project for review', async () => {
    const user = userEvent.setup();
    renderBanner(changesMade);

    await user.click(screen.getByRole('button', { name: 'Mark project ready again' }));
    await user.click(await screen.findByRole('button', { name: /Send for Northwind Industrial/i }));

    await waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith({ engagementId: 'eng-1' });
    });
  });
});
