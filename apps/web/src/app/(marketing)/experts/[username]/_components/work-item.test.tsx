import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import type { WorkHistoryView } from '@/components/expert/profile';
import { WorkItem } from './work-item';

const currentRole: WorkHistoryView = {
  role: 'Founder & MD',
  company: 'MIDCAI Consulting',
  periodLabel: 'Apr 2025 — Present',
  durationLabel: '',
  isCurrent: true,
  responsibilities: 'Founded the firm and lead every engagement.',
};

const pastRole: WorkHistoryView = {
  role: 'Account Director',
  company: 'Appirio',
  periodLabel: 'Nov 2017 — Apr 2020',
  durationLabel: '2 yrs 5 mos',
  isCurrent: false,
  responsibilities: 'Owned delivery across ~25 projects a year.',
};

describe('WorkItem', () => {
  it('renders role, company and period', () => {
    render(<WorkItem item={pastRole} isLast />);
    expect(screen.getByText('Account Director')).toBeInTheDocument();
    expect(screen.getByText('Appirio')).toBeInTheDocument();
    expect(screen.getByText('Nov 2017 — Apr 2020')).toBeInTheDocument();
  });

  it('shows "Current" for a current role and its duration for a past role', () => {
    const { rerender } = render(<WorkItem item={currentRole} isLast />);
    expect(screen.getByText('Current')).toBeInTheDocument();

    rerender(<WorkItem item={pastRole} isLast />);
    expect(screen.getByText('2 yrs 5 mos')).toBeInTheDocument();
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
  });

  it('a past role starts collapsed and toggles between View more / View less', async () => {
    const user = userEvent.setup();
    render(<WorkItem item={pastRole} isLast />);

    const toggle = screen.getByRole('button', { name: 'View more' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'View less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    await user.click(screen.getByRole('button', { name: 'View less' }));
    expect(screen.getByRole('button', { name: 'View more' })).toBeInTheDocument();
  });

  it('a current role starts expanded (View less)', () => {
    render(<WorkItem item={currentRole} isLast />);
    expect(screen.getByRole('button', { name: 'View less' })).toBeInTheDocument();
  });

  it('renders no toggle when there are no responsibilities', () => {
    render(<WorkItem item={{ ...pastRole, responsibilities: null }} isLast />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<WorkItem item={pastRole} isLast />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
