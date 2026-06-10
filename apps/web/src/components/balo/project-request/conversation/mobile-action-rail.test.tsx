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
        proposalCta={{ label: 'Request proposal', quiet: false }}
        onCall={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('fires the call CTA and renders the proposal stub disabled', async () => {
    const user = userEvent.setup();
    const onCall = vi.fn();
    render(
      <MobileActionRail
        visible
        showCall
        callLabel="Propose times"
        callPending={false}
        proposalCta={{ label: 'Build proposal', quiet: false }}
        onCall={onCall}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Propose times' }));
    expect(onCall).toHaveBeenCalled();
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
        proposalCta={{ label: 'Request proposal', quiet: true }}
        onCall={vi.fn()}
      />
    );
    const cta = screen.getByRole('button', { name: 'Request proposal' });
    expect(cta.className).toContain('bg-primary/5');
    expect(cta.className).not.toContain('bg-gradient-to-r');
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
      />
    );
    expect(screen.getByRole('button', { name: 'Book a call' })).toBeDisabled();
  });
});
