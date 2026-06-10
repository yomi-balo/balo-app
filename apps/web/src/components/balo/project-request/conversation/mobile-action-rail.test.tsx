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
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('fires the call CTA and renders the proposal stub disabled when no handler (expert lens)', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    render(
      <MobileActionRail
        visible
        showCall
        callLabel="Propose times"
        callPending={false}
        proposalCta={{ kind: 'request', label: 'Build proposal', quiet: false }}
        onCall={onCall}
        onProposal={null}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Propose times' }));
    expect(onCall).toHaveBeenCalled();
    const stub = screen.getByRole('button', { name: 'Build proposal' });
    expect(stub).toBeDisabled();
    expect(stub).toHaveAttribute('aria-disabled', 'true');
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
      />
    );
    const cta = screen.getByRole('button', { name: 'Request proposal' });
    expect(cta).toBeEnabled();
    expect(cta).not.toHaveAttribute('aria-disabled');
    await user.click(cta);
    expect(onProposal).toHaveBeenCalledTimes(1);
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
      />
    );
    const cta = screen.getByRole('button', { name: 'Request proposal' });
    expect(cta.className).toContain('bg-primary/5');
    expect(cta.className).not.toContain('bg-gradient-to-r');
  });

  it("kind:'view' renders the disabled stub even when a live handler is passed (A6 owns it)", async () => {
    const user = userEvent.setup();
    const onProposal = vi.fn();
    render(
      <MobileActionRail
        visible
        showCall={false}
        callLabel="Book a call"
        callPending={false}
        proposalCta={{ kind: 'view', label: 'View proposal', quiet: false }}
        onCall={vi.fn()}
        onProposal={onProposal}
      />
    );
    const stub = screen.getByRole('button', { name: 'View proposal' });
    expect(stub).toBeDisabled();
    expect(stub).toHaveAttribute('aria-disabled', 'true');
    // Desktop-header stub treatment: outlined, never the commit gradient.
    expect(stub.className).toContain('bg-primary/5');
    expect(stub.className).not.toContain('bg-gradient-to-r');
    await user.click(stub);
    expect(onProposal).not.toHaveBeenCalled();
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
      />
    );
    expect(screen.getByRole('button', { name: 'Book a call' })).toBeDisabled();
  });
});
