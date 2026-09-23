import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import ExpertSettingsLoading from './loading';

describe('ExpertSettingsLoading', () => {
  it('renders the skeleton with an accessible name, via <output> not role="status" (S6819)', () => {
    render(<ExpertSettingsLoading />);

    const skeleton = screen.getByRole('status', { name: 'Loading settings' });
    expect(skeleton.tagName).toBe('OUTPUT');
    expect(screen.getByText('Loading…')).toHaveClass('sr-only');
  });

  it('mirrors the chrome: banner bar, a pill main strip, then one underline sub strip', () => {
    const { container } = render(<ExpertSettingsLoading />);

    const pill = screen.getByTestId('main-tab-pill');
    expect(pill).toHaveClass('bg-muted', 'rounded-xl', 'inline-flex');
    expect(pill.children).toHaveLength(4);

    const underlines = container.querySelectorAll('.shadow-\\[inset_0_-1px_0_var\\(--border\\)\\]');
    expect(underlines).toHaveLength(1);
    expect(underlines[0]?.children).toHaveLength(4);
    expect(container.querySelector('.rounded-\\[10px\\]')).not.toBeNull();
  });
});
