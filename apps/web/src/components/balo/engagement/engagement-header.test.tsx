import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';

import { EngagementHeader } from './engagement-header';
import type { EngagementHeaderView, StatusChipView } from '@/lib/engagement/engagement-view';

const statusChip: StatusChipView = {
  status: 'active',
  label: 'Active',
  tone: 'success',
  icon: 'Layers',
};

const header = (overrides: Partial<EngagementHeaderView> = {}): EngagementHeaderView => ({
  engagementTitle: 'Salesforce revenue-cloud rollout',
  headerLine: 'Delivered by CloudPeak Consulting',
  statusChip,
  provenance: { requestId: 'req-1', href: '/projects/req-1' },
  terms: [
    { icon: 'DollarSign', label: 'Pricing', value: 'Fixed price · A$58,000' },
    { icon: 'Clock', label: 'Timeframe', value: '~120h estimated' },
    { icon: 'CalendarDays', label: 'Kicked off', value: '16 Jun 2026' },
  ],
  backHref: '/projects',
  ...overrides,
});

describe('EngagementHeader', () => {
  it('renders the title as a heading', () => {
    render(<EngagementHeader header={header()} />);
    expect(
      screen.getByRole('heading', { name: 'Salesforce revenue-cloud rollout' })
    ).toBeInTheDocument();
  });

  it('renders the back-link to /projects', () => {
    render(<EngagementHeader header={header()} />);
    expect(screen.getByRole('link', { name: /Projects/i })).toHaveAttribute('href', '/projects');
  });

  it('renders the status chip label', () => {
    render(<EngagementHeader header={header()} />);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('renders the per-lens header line', () => {
    render(<EngagementHeader header={header({ headerLine: 'For Northwind Industrial' })} />);
    expect(screen.getByText('For Northwind Industrial')).toBeInTheDocument();
  });

  it('folds the pill value into the accessible name (category + value)', () => {
    render(<EngagementHeader header={header()} />);
    expect(screen.getByLabelText('Pricing: Fixed price · A$58,000')).toHaveTextContent(
      'Fixed price · A$58,000'
    );
    expect(screen.getByLabelText('Timeframe: ~120h estimated')).toHaveTextContent(
      '~120h estimated'
    );
    expect(screen.getByLabelText('Kicked off: 16 Jun 2026')).toHaveTextContent('16 Jun 2026');
  });

  it('renders the provenance link only when provenance is non-null', () => {
    render(<EngagementHeader header={header()} />);
    expect(screen.getByRole('link', { name: /View request/i })).toHaveAttribute(
      'href',
      '/projects/req-1'
    );
  });

  it('omits the provenance link for retainers (provenance === null)', () => {
    render(<EngagementHeader header={header({ provenance: null })} />);
    expect(screen.queryByRole('link', { name: /View request/i })).not.toBeInTheDocument();
  });

  it('tolerates an empty terms strip', () => {
    render(<EngagementHeader header={header({ terms: [], provenance: null })} />);
    expect(
      screen.getByRole('heading', { name: 'Salesforce revenue-cloud rollout' })
    ).toBeInTheDocument();
  });
});
