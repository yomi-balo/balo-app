import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { ComposerTabStrip, type ComposerTabId } from './composer-tab-strip';

function renderStrip(active: ComposerTabId = 'overview'): {
  onChange: ReturnType<typeof vi.fn<(tab: ComposerTabId) => void>>;
} {
  const onChange = vi.fn<(tab: ComposerTabId) => void>();
  render(<ComposerTabStrip active={active} onChange={onChange} />);
  return { onChange };
}

describe('ComposerTabStrip', () => {
  it('exposes a labelled tablist with one selected tab', () => {
    renderStrip('milestones');
    expect(screen.getByRole('tablist', { name: 'Proposal sections' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Milestones' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('uses roving tabIndex — only the active tab is in the tab order', () => {
    renderStrip('overview');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Milestones' })).toHaveAttribute('tabindex', '-1');
  });

  it('clicking a tab fires onChange', async () => {
    const user = userEvent.setup();
    const { onChange } = renderStrip('overview');
    await user.click(screen.getByRole('tab', { name: 'Payment & terms' }));
    expect(onChange).toHaveBeenCalledWith('payment');
  });

  it('ArrowRight moves selection to the next tab', async () => {
    const user = userEvent.setup();
    const { onChange } = renderStrip('overview');
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('milestones');
  });

  it('ArrowLeft from the first tab wraps to the last', async () => {
    const user = userEvent.setup();
    const { onChange } = renderStrip('overview');
    screen.getByRole('tab', { name: 'Overview' }).focus();
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('attachments');
  });

  it('Home selects the first tab and End the last', async () => {
    const user = userEvent.setup();
    const { onChange } = renderStrip('payment');
    screen.getByRole('tab', { name: 'Payment & terms' }).focus();
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenCalledWith('overview');
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenCalledWith('attachments');
  });

  it('renders a "needs attention" dot only on non-active tabs with issues', () => {
    render(<ComposerTabStrip active="overview" onChange={vi.fn()} issues={{ milestones: true }} />);
    expect(screen.getByLabelText('Needs attention')).toBeInTheDocument();
  });
});
