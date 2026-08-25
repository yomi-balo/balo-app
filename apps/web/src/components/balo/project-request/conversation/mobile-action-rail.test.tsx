import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MobileActionRail } from './mobile-action-rail';
import type { CallSlot } from './thread-actions';

const NONE: CallSlot = { kind: 'none' };
const BOOK: CallSlot = { kind: 'book' };
const PROPOSE: CallSlot = { kind: 'propose' };
const SHARED: CallSlot = { kind: 'shared' };

describe('MobileActionRail', () => {
  it('renders nothing when nothing is actionable', () => {
    const { container } = render(
      <MobileActionRail
        visible
        callSlot={NONE}
        callPending={false}
        proposalCta={null}
        onCall={vi.fn()}
        onProposal={null}
        onBuildProposal={null}
        onViewProposal={null}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the composer is focused (keyboard up)', () => {
    const { container } = render(
      <MobileActionRail
        visible={false}
        callSlot={BOOK}
        callPending={false}
        proposalCta={{ kind: 'request', label: 'Request proposal', quiet: false }}
        onCall={vi.fn()}
        onProposal={vi.fn()}
        onBuildProposal={null}
        onViewProposal={null}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the proposal CTA ENABLED and fires the handler when provided (client lens, A5)', async () => {
    const user = userEvent.setup();
    const onProposal = vi.fn();
    render(
      <MobileActionRail
        visible
        callSlot={NONE}
        callPending={false}
        proposalCta={{ kind: 'request', label: 'Request proposal', quiet: false }}
        onCall={vi.fn()}
        onProposal={onProposal}
        onBuildProposal={null}
        onViewProposal={null}
      />
    );
    const cta = screen.getByRole('button', { name: 'Request proposal' });
    expect(cta).toBeEnabled();
    expect(cta).not.toHaveAttribute('aria-disabled');
    await user.click(cta);
    expect(onProposal).toHaveBeenCalledTimes(1);
  });

  it("kind:'build' renders the live gradient CTA and fires onBuildProposal (expert lens, A6.2)", async () => {
    const user = userEvent.setup();
    const onBuildProposal = vi.fn();
    render(
      <MobileActionRail
        visible
        callSlot={NONE}
        callPending={false}
        proposalCta={{ kind: 'build', label: 'Build proposal', quiet: false }}
        onCall={vi.fn()}
        onProposal={null}
        onBuildProposal={onBuildProposal}
        onViewProposal={null}
      />
    );
    const cta = screen.getByRole('button', { name: 'Build proposal' });
    expect(cta).toBeEnabled();
    expect(cta).not.toHaveAttribute('aria-disabled');
    // Live commit treatment — the gradient, not the outlined stub.
    expect(cta.className).toContain('bg-gradient-to-r');
    await user.click(cta);
    expect(onBuildProposal).toHaveBeenCalledTimes(1);
  });

  it("kind:'build' renders disabled when no handler is provided", () => {
    render(
      <MobileActionRail
        visible
        callSlot={NONE}
        callPending={false}
        proposalCta={{ kind: 'build', label: 'Build proposal', quiet: false }}
        onCall={vi.fn()}
        onProposal={null}
        onBuildProposal={null}
        onViewProposal={null}
      />
    );
    const stub = screen.getByRole('button', { name: 'Build proposal' });
    expect(stub).toBeDisabled();
    expect(stub).toHaveAttribute('aria-disabled', 'true');
  });

  it('quiet proposal CTA drops the gradient when the nudge already pushes it', () => {
    render(
      <MobileActionRail
        visible
        callSlot={NONE}
        callPending={false}
        proposalCta={{ kind: 'request', label: 'Request proposal', quiet: true }}
        onCall={vi.fn()}
        onProposal={vi.fn()}
        onBuildProposal={null}
        onViewProposal={null}
      />
    );
    const cta = screen.getByRole('button', { name: 'Request proposal' });
    expect(cta.className).toContain('bg-primary/5');
    expect(cta.className).not.toContain('bg-gradient-to-r');
  });

  it("kind:'view' renders ENABLED and fires onViewProposal when provided (BAL-289 / A6.3)", async () => {
    const user = userEvent.setup();
    const onViewProposal = vi.fn();
    render(
      <MobileActionRail
        visible
        callSlot={NONE}
        callPending={false}
        proposalCta={{ kind: 'view', label: 'View proposal', quiet: false }}
        onCall={vi.fn()}
        onProposal={null}
        onBuildProposal={null}
        onViewProposal={onViewProposal}
      />
    );
    const cta = screen.getByRole('button', { name: 'View proposal' });
    expect(cta).toBeEnabled();
    expect(cta).not.toHaveAttribute('aria-disabled');
    // The "view" link keeps the outlined treatment, never the commit gradient.
    expect(cta.className).toContain('bg-primary/5');
    expect(cta.className).not.toContain('bg-gradient-to-r');
    await user.click(cta);
    expect(onViewProposal).toHaveBeenCalledTimes(1);
  });

  it("kind:'view' renders the disabled stub when no view handler is provided (defensive)", async () => {
    const user = userEvent.setup();
    const onProposal = vi.fn();
    const onBuildProposal = vi.fn();
    render(
      <MobileActionRail
        visible
        callSlot={NONE}
        callPending={false}
        proposalCta={{ kind: 'view', label: 'View proposal', quiet: false }}
        onCall={vi.fn()}
        onProposal={onProposal}
        onBuildProposal={onBuildProposal}
        onViewProposal={null}
      />
    );
    const stub = screen.getByRole('button', { name: 'View proposal' });
    expect(stub).toBeDisabled();
    expect(stub).toHaveAttribute('aria-disabled', 'true');
    // The unrelated request/build handlers are never invoked by the view slot.
    await user.click(stub);
    expect(onProposal).not.toHaveBeenCalled();
    expect(onBuildProposal).not.toHaveBeenCalled();
  });

  it('disables the call button while pending', () => {
    render(
      <MobileActionRail
        visible
        callSlot={BOOK}
        callPending
        proposalCta={null}
        onCall={vi.fn()}
        onProposal={null}
        onBuildProposal={null}
        onViewProposal={null}
      />
    );
    expect(screen.getByRole('button', { name: 'Book a call' })).toBeDisabled();
  });

  // ── BAL-283 — the callSlot states ───────────────────────────────────────────────────────

  it("callSlot 'propose' renders the Propose times label and fires onCall", async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    render(
      <MobileActionRail
        visible
        callSlot={PROPOSE}
        callPending={false}
        proposalCta={null}
        onCall={onCall}
        onProposal={null}
        onBuildProposal={null}
        onViewProposal={null}
      />
    );
    const cta = screen.getByRole('button', { name: 'Propose times' });
    await user.click(cta);
    expect(onCall).toHaveBeenCalledTimes(1);
  });

  it("callSlot 'shared' renders a quiet, non-interactive pill — no button, no onCall wiring", () => {
    render(
      <MobileActionRail
        visible
        callSlot={SHARED}
        callPending={false}
        proposalCta={null}
        onCall={vi.fn()}
        onProposal={null}
        onBuildProposal={null}
        onViewProposal={null}
      />
    );
    expect(screen.queryByRole('button', { name: /availability shared/i })).not.toBeInTheDocument();
    const pill = screen.getByText('Availability shared');
    expect(pill.closest('[aria-disabled="true"]')).not.toBeNull();
  });

  it("callSlot 'booked' renders no call affordance at all", () => {
    const { container } = render(
      <MobileActionRail
        visible
        callSlot={{ kind: 'booked', scheduledStartIso: '2026-09-01T04:00:00.000Z' }}
        callPending={false}
        proposalCta={null}
        onCall={vi.fn()}
        onProposal={null}
        onBuildProposal={null}
        onViewProposal={null}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
