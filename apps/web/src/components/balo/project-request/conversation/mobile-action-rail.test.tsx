import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MobileActionRail } from './mobile-action-rail';
import type { CallSlot, RailProposalSlot } from './thread-actions';
import type { UpcomingCallView } from '@/lib/project-request/conversation-view-types';
import type { ViewerClock } from '@/hooks/use-viewer-clock';

const { clockRef } = vi.hoisted(() => ({ clockRef: { value: null as ViewerClock | null } }));
vi.mock('@/hooks/use-viewer-clock', () => ({ useViewerClock: () => clockRef.value }));

const NONE: CallSlot = { kind: 'none' };
const BOOK: CallSlot = { kind: 'book', route: 'in_place' };
const BOOK_VIA_PROFILE: CallSlot = { kind: 'book', route: 'profile' };
const PROPOSE: CallSlot = { kind: 'propose' };
const SHARED: CallSlot = { kind: 'shared' };

const NEXT: UpcomingCallView = {
  meetingId: 'meeting-1',
  scheduledStartIso: '2026-09-03T04:00:00.000Z',
  contextType: 'request_interaction',
};
const LATER: UpcomingCallView = {
  meetingId: 'meeting-2',
  scheduledStartIso: '2026-09-04T04:00:00.000Z',
  contextType: 'project_call',
};

const REQUEST_CTA: RailProposalSlot = { kind: 'request', label: 'Request proposal', quiet: false };

interface RailOverrides {
  visible?: boolean;
  callSlot?: CallSlot;
  callPending?: boolean;
  upcomingCalls?: readonly UpcomingCallView[];
  profileBookingHref?: string | null;
  proposalCta?: RailProposalSlot | null;
  onCall?: () => void;
  onBookAnother?: () => void;
  onJoin?: (call: UpcomingCallView) => void;
  onProposal?: (() => void) | null;
  onBuildProposal?: (() => void) | null;
  onViewProposal?: (() => void) | null;
}

function renderRail(o: RailOverrides = {}): ReturnType<typeof render> {
  return render(
    <MobileActionRail
      visible={o.visible ?? true}
      callSlot={o.callSlot ?? NONE}
      callPending={o.callPending ?? false}
      expertName="Priya Nair"
      expertFirstName="Priya"
      upcomingCalls={o.upcomingCalls ?? []}
      profileBookingHref={o.profileBookingHref ?? null}
      deliveryEngagementId={null}
      joinPartyLabel="Priya Nair"
      proposalCta={o.proposalCta ?? null}
      onCall={o.onCall ?? vi.fn()}
      onBookAnother={o.onBookAnother ?? vi.fn()}
      onJoin={o.onJoin ?? vi.fn()}
      onProposal={o.onProposal ?? null}
      onBuildProposal={o.onBuildProposal ?? null}
      onViewProposal={o.onViewProposal ?? null}
    />
  );
}

describe('MobileActionRail', () => {
  it('renders nothing when nothing is actionable', () => {
    const { container } = renderRail();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the composer is focused (keyboard up)', () => {
    const { container } = renderRail({
      visible: false,
      callSlot: BOOK,
      proposalCta: REQUEST_CTA,
      onProposal: vi.fn(),
    });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the proposal CTA ENABLED and fires the handler when provided (client lens, A5)', async () => {
    const user = userEvent.setup();
    const onProposal = vi.fn();
    renderRail({ proposalCta: REQUEST_CTA, onProposal });
    const cta = screen.getByRole('button', { name: 'Request proposal' });
    expect(cta).toBeEnabled();
    expect(cta).not.toHaveAttribute('aria-disabled');
    await user.click(cta);
    expect(onProposal).toHaveBeenCalledTimes(1);
  });

  it("kind:'build' renders the live solid CTA and fires onBuildProposal (expert lens, A6.2)", async () => {
    const user = userEvent.setup();
    const onBuildProposal = vi.fn();
    renderRail({
      proposalCta: { kind: 'build', label: 'Build proposal', quiet: false },
      onBuildProposal,
    });
    const cta = screen.getByRole('button', { name: 'Build proposal' });
    expect(cta).toBeEnabled();
    expect(cta.className).toContain('text-primary-foreground');
    await user.click(cta);
    expect(onBuildProposal).toHaveBeenCalledTimes(1);
  });

  it('quiet proposal CTA drops the solid fill when the nudge already pushes it', () => {
    renderRail({ proposalCta: { ...REQUEST_CTA, quiet: true }, onProposal: vi.fn() });
    const cta = screen.getByRole('button', { name: 'Request proposal' });
    expect(cta.className).toContain('bg-primary/5');
    expect(cta.className).not.toContain('text-primary-foreground');
  });

  it("kind:'view' renders ENABLED, outlined, and fires onViewProposal (BAL-289 / A6.3)", async () => {
    const user = userEvent.setup();
    const onViewProposal = vi.fn();
    renderRail({
      proposalCta: { kind: 'view', label: 'View proposal', quiet: false },
      onViewProposal,
    });
    const cta = screen.getByRole('button', { name: 'View proposal' });
    expect(cta).toBeEnabled();
    expect(cta.className).toContain('bg-primary/5');
    expect(cta.className).not.toContain('text-primary-foreground');
    await user.click(cta);
    expect(onViewProposal).toHaveBeenCalledTimes(1);
  });

  describe('a proposal CTA with a null handler renders nothing (BAL-615 carry-over)', () => {
    const cases: ReadonlyArray<[string, RailProposalSlot]> = [
      ['request', REQUEST_CTA],
      ['build', { kind: 'build', label: 'Build proposal', quiet: false }],
      ['view', { kind: 'view', label: 'View proposal', quiet: false }],
    ];

    it.each(cases)(
      'kind:%s — no stub, and the rail collapses when nothing else shows',
      (_k, cta) => {
        const { container } = renderRail({
          proposalCta: cta,
          // Handlers for the OTHER kinds must never stand in for a missing one.
          onProposal: cta.kind === 'request' ? null : vi.fn(),
          onBuildProposal: cta.kind === 'build' ? null : vi.fn(),
          onViewProposal: cta.kind === 'view' ? null : vi.fn(),
        });
        expect(screen.queryByRole('button', { name: cta.label })).not.toBeInTheDocument();
        expect(container).toBeEmptyDOMElement();
      }
    );

    it('keeps the call group when the proposal CTA is dropped, with no opacity-60 stub', () => {
      const { container } = renderRail({ callSlot: BOOK, proposalCta: REQUEST_CTA });
      expect(screen.getByRole('button', { name: 'Book a call' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Request proposal' })).not.toBeInTheDocument();
      expect(container.querySelector('.opacity-60')).toBeNull();
    });
  });

  it('disables the call button while pending', () => {
    renderRail({ callSlot: BOOK, callPending: true });
    expect(screen.getByRole('button', { name: 'Book a call' })).toBeDisabled();
  });

  // ── BAL-283 / BAL-616 — the callSlot states ─────────────────────────────────────────────

  it("callSlot 'book' renders a full-width 44px Book a call and fires onCall", async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    renderRail({ callSlot: BOOK, onCall });
    const cta = screen.getByRole('button', { name: 'Book a call' });
    expect(cta.className).toContain('min-h-11');
    expect(cta.className).toContain('flex-1');
    await user.click(cta);
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("callSlot 'book' via the profile is a link to the booking deep link", () => {
    renderRail({
      callSlot: BOOK_VIA_PROFILE,
      profileBookingHref: '/experts/priya?book=1&src=request_thread',
    });
    expect(screen.getByRole('link', { name: 'Book a call' })).toHaveAttribute(
      'href',
      '/experts/priya?book=1&src=request_thread'
    );
  });

  it("callSlot 'propose' renders the Propose times label and fires onCall", async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    renderRail({ callSlot: PROPOSE, onCall });
    await user.click(screen.getByRole('button', { name: 'Propose times' }));
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("callSlot 'shared' renders a quiet, non-interactive pill — no button, no onCall wiring", () => {
    renderRail({ callSlot: SHARED });
    expect(screen.queryByRole('button', { name: /availability shared/i })).not.toBeInTheDocument();
    const pill = screen.getByText('Availability shared');
    expect(pill.closest('[aria-disabled="true"]')).not.toBeNull();
  });

  describe("callSlot 'upcoming'", () => {
    const upcoming: CallSlot = { kind: 'upcoming', next: NEXT, more: 1, canBookAnother: true };

    it('names the expert over the next-call line, then a 44px Join with a 44px Book another call', async () => {
      const user = userEvent.setup();
      const onBookAnother = vi.fn();
      renderRail({ callSlot: upcoming, upcomingCalls: [NEXT, LATER], onBookAnother });

      expect(screen.getByText('Priya Nair')).toBeInTheDocument();
      expect(screen.getByText(/Next call/)).toBeInTheDocument();
      const join = screen.getByTestId('join-countdown');
      expect(join.className).toContain('min-h-11');
      expect(join.className).toContain('flex-1');
      const another = screen.getByRole('button', { name: 'Book another call' });
      expect(another.className).toContain('h-11');
      expect(another.className).toContain('w-11');
      await user.click(another);
      expect(onBookAnother).toHaveBeenCalledTimes(1);
    });

    it('counts as actionable on its own, and offers no Book another call to the expert', () => {
      renderRail({
        callSlot: { kind: 'upcoming', next: NEXT, more: 0, canBookAnother: false },
        upcomingCalls: [NEXT],
      });
      expect(screen.getByTestId('join-countdown')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Book another call' })).not.toBeInTheDocument();
    });

    it('opens the "+1 more" list of every upcoming call', async () => {
      const user = userEvent.setup();
      clockRef.value = { now: new Date('2026-09-01T00:00:00.000Z'), timeZone: 'UTC' };
      renderRail({ callSlot: upcoming, upcomingCalls: [NEXT, LATER] });
      await user.click(screen.getByRole('button', { name: 'Show 1 more upcoming call' }));
      expect(await screen.findByText('Upcoming calls')).toBeInTheDocument();
      expect(screen.getAllByText('Thu 3 Sep at 4:00 am')).not.toHaveLength(0);
      expect(screen.getByText('Fri 4 Sep at 4:00 am')).toBeInTheDocument();
      clockRef.value = null;
    });
  });
});
