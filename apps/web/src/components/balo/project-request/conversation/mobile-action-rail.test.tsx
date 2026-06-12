import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { MobileActionRail } from './mobile-action-rail';

describe('MobileActionRail', () => {
  it('renders nothing when nothing is actionable', () => {
    const { container } = render(
      <MobileActionRail
        visible
        showCall={false}
        callLabel="Book a call"
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
        showCall
        callLabel="Book a call"
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
        showCall={false}
        callLabel="Book a call"
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
        showCall={false}
        callLabel="Propose times"
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
        showCall={false}
        callLabel="Book a call"
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
        showCall={false}
        callLabel="Book a call"
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
        showCall={false}
        callLabel="Book a call"
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
        showCall={false}
        callLabel="Book a call"
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
        showCall
        callLabel="Book a call"
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
});
