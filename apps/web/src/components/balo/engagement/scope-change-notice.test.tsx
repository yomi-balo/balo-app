import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';

import { render, screen } from '@/test/utils';
import { axe } from '@/test/axe';

import { ScopeChangeNotice } from './scope-change-notice';

describe('ScopeChangeNotice', () => {
  it('announces the message with a link into the composer', () => {
    render(
      <ScopeChangeNotice
        message="Adding a milestone needs Northwind Industrial's approval first."
        cta={{ href: '/engagements/eng-1/change-order?prefill=add' }}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(/needs Northwind Industrial's approval/);
    expect(screen.getByRole('link', { name: 'Propose a change' })).toHaveAttribute(
      'href',
      '/engagements/eng-1/change-order?prefill=add'
    );
  });

  it('shows the reason, not a link, while a change is already with the client', () => {
    render(
      <ScopeChangeNotice
        message="Needs approval."
        cta={{ disabledReason: 'Waiting on Northwind Industrial.' }}
        onDismiss={vi.fn()}
      />
    );
    expect(screen.getByText('Waiting on Northwind Industrial.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('has no action when the viewer has no composer entry', () => {
    render(<ScopeChangeNotice message="Needs approval." cta={null} onDismiss={vi.fn()} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('dismisses', async () => {
    const onDismiss = vi.fn();
    render(<ScopeChangeNotice message="Needs approval." cta={null} onDismiss={onDismiss} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ScopeChangeNotice message="Needs approval." cta={{ href: '/x' }} onDismiss={vi.fn()} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
