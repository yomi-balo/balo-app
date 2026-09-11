import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { LookupDrillInTabs } from './lookup-drill-in-tabs';

const TABS = [
  { key: 'timeline' as const, label: 'Timeline' },
  { key: 'money' as const, label: 'Money' },
];

describe('LookupDrillInTabs', () => {
  it('renders the ARIA tabs shape', () => {
    render(<LookupDrillInTabs tabs={TABS} active="timeline" onSelect={vi.fn()} />);
    expect(screen.getByRole('tablist', { name: 'Drill-in sections' })).toBeInTheDocument();
    const tabButtons = screen.getAllByRole('tab');
    expect(tabButtons).toHaveLength(2);
  });

  it('marks the active tab aria-selected true and the inactive tab false', () => {
    render(<LookupDrillInTabs tabs={TABS} active="money" onSelect={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: 'Money' })).toHaveAttribute('aria-selected', 'true');
  });

  it('calls onSelect with the clicked tab key', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<LookupDrillInTabs tabs={TABS} active="timeline" onSelect={onSelect} />);

    await user.click(screen.getByRole('tab', { name: 'Money' }));
    expect(onSelect).toHaveBeenCalledWith('money');
  });

  it('every tab button is type="button" (never submits a form)', () => {
    render(<LookupDrillInTabs tabs={TABS} active="timeline" onSelect={vi.fn()} />);
    for (const button of screen.getAllByRole('tab')) {
      expect(button).toHaveAttribute('type', 'button');
    }
  });

  it('shows a focus-visible ring class for keyboard navigation', () => {
    render(<LookupDrillInTabs tabs={TABS} active="timeline" onSelect={vi.fn()} />);
    expect(screen.getByRole('tab', { name: 'Timeline' }).className).toContain(
      'focus-visible:ring-2'
    );
  });

  describe('the WAI-ARIA APG tabs pattern (BAL-555 fix round F3)', () => {
    it('each tab carries an id + aria-controls pointing at a panel id', () => {
      render(<LookupDrillInTabs tabs={TABS} active="timeline" onSelect={vi.fn()} />);
      const timelineTab = screen.getByRole('tab', { name: 'Timeline' });
      const moneyTab = screen.getByRole('tab', { name: 'Money' });
      expect(timelineTab).toHaveAttribute('id', 'lookup-drill-in-tab-timeline');
      expect(timelineTab).toHaveAttribute('aria-controls', 'lookup-drill-in-panel-timeline');
      expect(moneyTab).toHaveAttribute('id', 'lookup-drill-in-tab-money');
      expect(moneyTab).toHaveAttribute('aria-controls', 'lookup-drill-in-panel-money');
    });

    it('roving tabIndex — only the active tab is 0, every other tab is -1', () => {
      render(<LookupDrillInTabs tabs={TABS} active="money" onSelect={vi.fn()} />);
      expect(screen.getByRole('tab', { name: 'Timeline' })).toHaveAttribute('tabIndex', '-1');
      expect(screen.getByRole('tab', { name: 'Money' })).toHaveAttribute('tabIndex', '0');
    });

    it('ArrowRight moves focus and selection to the next tab, wrapping past the last', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(<LookupDrillInTabs tabs={TABS} active="money" onSelect={onSelect} />);

      screen.getByRole('tab', { name: 'Money' }).focus();
      await user.keyboard('{ArrowRight}');

      expect(onSelect).toHaveBeenCalledWith('timeline');
    });

    it('ArrowLeft moves focus and selection to the previous tab, wrapping past the first', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(<LookupDrillInTabs tabs={TABS} active="timeline" onSelect={onSelect} />);

      screen.getByRole('tab', { name: 'Timeline' }).focus();
      await user.keyboard('{ArrowLeft}');

      expect(onSelect).toHaveBeenCalledWith('money');
    });

    it('Home selects the first tab and End selects the last tab', async () => {
      const user = userEvent.setup();
      const onSelect = vi.fn();
      render(<LookupDrillInTabs tabs={TABS} active="money" onSelect={onSelect} />);

      screen.getByRole('tab', { name: 'Money' }).focus();
      await user.keyboard('{Home}');
      expect(onSelect).toHaveBeenLastCalledWith('timeline');

      await user.keyboard('{End}');
      expect(onSelect).toHaveBeenLastCalledWith('money');
    });

    it('after ArrowRight, the newly active tab actually receives DOM focus', async () => {
      const user = userEvent.setup();
      // A real handler, mirroring how `lookup-drill-in.tsx` re-renders `active` from state —
      // otherwise `active` never changes and this test could pass with focus stuck in place.
      function Harness(): React.JSX.Element {
        const [active, setActive] = useState<'timeline' | 'money'>('timeline');
        return <LookupDrillInTabs tabs={TABS} active={active} onSelect={setActive} />;
      }
      render(<Harness />);

      screen.getByRole('tab', { name: 'Timeline' }).focus();
      await user.keyboard('{ArrowRight}');

      expect(screen.getByRole('tab', { name: 'Money' })).toHaveFocus();
    });
  });
});
