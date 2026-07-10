import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, DOMAIN_JOIN_EVENTS } from '@/lib/analytics';
import { DomainJoinPending } from './domain-join-pending';

// ── Helpers ─────────────────────────────────────────────────────

type Overrides = Partial<React.ComponentProps<typeof DomainJoinPending>>;

function renderPending(overrides: Overrides = {}) {
  const props = {
    companyName: 'Northwind',
    isBusy: false,
    actionError: null,
    onExplore: vi.fn(),
    onCreateInstead: vi.fn(),
    onContinueToCompany: vi.fn(),
    ...overrides,
  };
  render(<DomainJoinPending {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────

describe('DomainJoinPending', () => {
  describe('pending phase', () => {
    it('renders the party-named heading, subcopy, and the NextSteps list', async () => {
      renderPending();

      expect(
        await screen.findByRole('heading', { name: /request sent to northwind/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/is with their admins/i)).toBeInTheDocument();
      const steps = screen.getAllByRole('listitem');
      expect(steps).toHaveLength(3);
      expect(screen.getByText(/we'll email you the moment they respond/i)).toBeInTheDocument();
    });

    it('fires REQUEST_PENDING_VIEWED once on mount', () => {
      renderPending();
      expect(track).toHaveBeenCalledWith(DOMAIN_JOIN_EVENTS.REQUEST_PENDING_VIEWED, {
        party_type: 'company',
      });
    });

    it('invokes onExplore when the explore button is clicked', async () => {
      const user = userEvent.setup();
      const { onExplore } = renderPending();
      await user.click(screen.getByRole('button', { name: /explore balo while you wait/i }));
      expect(onExplore).toHaveBeenCalledOnce();
    });

    it('invokes onCreateInstead when the escape-hatch button is clicked', async () => {
      const user = userEvent.setup();
      const { onCreateInstead } = renderPending();
      await user.click(screen.getByRole('button', { name: /set up my own company instead/i }));
      expect(onCreateInstead).toHaveBeenCalledOnce();
    });

    it('renders the action error in an alert banner', () => {
      renderPending({ actionError: 'We could not send your request just now.' });
      expect(screen.getByRole('alert')).toHaveTextContent(/could not send your request/i);
    });

    it('disables the buttons while the explore completion is in flight', () => {
      renderPending({ isBusy: true });
      expect(screen.getByRole('button', { name: /working/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /set up my own company instead/i })).toBeDisabled();
    });

    it('has no accessibility violations', async () => {
      const { container } = render(
        <DomainJoinPending
          companyName="Northwind"
          isBusy={false}
          actionError={null}
          onExplore={vi.fn()}
          onCreateInstead={vi.fn()}
        />
      );
      await screen.findByRole('heading', { name: /request sent to northwind/i });
      expect(await axe(container)).toHaveNoViolations();
    });
  });

  describe('approved phase (dormant — testable via initialPhase)', () => {
    it('renders the success copy and the continue CTA', async () => {
      const { onContinueToCompany } = renderPending({ initialPhase: 'approved' });
      const user = userEvent.setup();

      expect(
        await screen.findByRole('heading', { name: /you're in — welcome to northwind/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/approved your request/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /continue to northwind/i }));
      expect(onContinueToCompany).toHaveBeenCalledOnce();
      // Not a pending screen — the pending-viewed event must not fire.
      expect(track).not.toHaveBeenCalledWith(
        DOMAIN_JOIN_EVENTS.REQUEST_PENDING_VIEWED,
        expect.anything()
      );
    });

    it('disables the continue CTA and shows the Working… spinner while busy', () => {
      renderPending({ initialPhase: 'approved', isBusy: true });
      expect(screen.getByRole('button', { name: /working/i })).toBeDisabled();
    });

    it('surfaces a completion error in an alert banner', () => {
      renderPending({
        initialPhase: 'approved',
        actionError: 'We could not finish that just now.',
      });
      expect(screen.getByRole('alert')).toHaveTextContent(/could not finish that just now/i);
    });
  });

  describe('declined phase (dormant — testable via initialPhase)', () => {
    it('renders neutral copy (no admin named, no "rejected") and routes to creation', async () => {
      const { onCreateInstead } = renderPending({ initialPhase: 'declined' });
      const user = userEvent.setup();

      expect(
        await screen.findByRole('heading', { name: /set up your own workspace/i })
      ).toBeInTheDocument();
      expect(screen.getByText(/weren't able to add you this time/i)).toBeInTheDocument();
      expect(screen.queryByText(/rejected/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /create my own company/i }));
      expect(onCreateInstead).toHaveBeenCalledOnce();
    });

    it('disables the create CTA and shows the Working… spinner while busy', () => {
      renderPending({ initialPhase: 'declined', isBusy: true });
      expect(screen.getByRole('button', { name: /working/i })).toBeDisabled();
    });

    it('surfaces a completion error in an alert banner', () => {
      renderPending({
        initialPhase: 'declined',
        actionError: 'We could not finish that just now.',
      });
      expect(screen.getByRole('alert')).toHaveTextContent(/could not finish that just now/i);
    });
  });
});
