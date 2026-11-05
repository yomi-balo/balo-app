import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';

import { EngagementHeader } from './engagement-header';
import type {
  EngagementHeaderLineView,
  EngagementHeaderView,
  StatusChipView,
} from '@/lib/engagement/engagement-view';

const statusChip: StatusChipView = {
  status: 'active',
  label: 'Active',
  tone: 'success',
  icon: 'Layers',
};

const PROFILE_HREF = '/experts/priya-sharma';

const agencyClientLine = (
  overrides: Partial<EngagementHeaderLineView> = {}
): EngagementHeaderLineView => ({
  prefix: 'Delivered by CloudPeak Consulting (',
  expertName: 'Priya Sharma',
  suffix: ', CPQ Specialist)',
  expertProfileHref: PROFILE_HREF,
  ...overrides,
});

const header = (overrides: Partial<EngagementHeaderView> = {}): EngagementHeaderView => ({
  engagementTitle: 'Salesforce revenue-cloud rollout',
  headerLine: agencyClientLine(),
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

  it('renders the per-lens header line as one sentence around the linked name', () => {
    render(<EngagementHeader header={header()} />);
    const line = screen.getByRole('link', { name: 'Priya Sharma' }).closest('p');
    expect(line).toHaveTextContent(
      /^Delivered by CloudPeak Consulting \(Priya Sharma, CPQ Specialist\)$/
    );
  });

  it('client lens (agency): links only the expert person, never the agency', () => {
    render(<EngagementHeader header={header()} />);
    expect(screen.getByRole('link', { name: 'Priya Sharma' })).toHaveAttribute(
      'href',
      PROFILE_HREF
    );
    expect(screen.queryByRole('link', { name: /CloudPeak/ })).not.toBeInTheDocument();
  });

  it('client lens (independent): links the person and leaves the headline outside the link', () => {
    render(
      <EngagementHeader
        header={header({
          headerLine: agencyClientLine({ prefix: 'Delivered by ', suffix: ' — CPQ Specialist' }),
        })}
      />
    );
    const link = screen.getByRole('link', { name: 'Priya Sharma' });
    expect(link).toHaveAttribute('href', PROFILE_HREF);
    expect(link).toHaveTextContent(/^Priya Sharma$/);
    expect(link.parentElement).toHaveTextContent('Delivered by Priya Sharma — CPQ Specialist');
  });

  it('admin lens: links the expert person, not the client company', () => {
    render(
      <EngagementHeader
        header={header({
          headerLine: agencyClientLine({ prefix: 'Northwind Industrial ↔ ', suffix: '' }),
        })}
      />
    );
    expect(screen.getByRole('link', { name: 'Priya Sharma' })).toHaveAttribute(
      'href',
      PROFILE_HREF
    );
    expect(screen.queryByRole('link', { name: /Northwind/ })).not.toBeInTheDocument();
  });

  it('renders the name unlinked when the profile does not resolve (null href)', () => {
    render(
      <EngagementHeader
        header={header({ headerLine: agencyClientLine({ expertProfileHref: null }) })}
      />
    );
    expect(screen.queryByRole('link', { name: 'Priya Sharma' })).not.toBeInTheDocument();
    expect(
      screen.getByText('Delivered by CloudPeak Consulting (Priya Sharma, CPQ Specialist)', {
        selector: 'p',
      })
    ).toBeInTheDocument();
  });

  it('expert lens: renders the client line with no expert link', () => {
    render(
      <EngagementHeader
        header={header({
          headerLine: {
            prefix: 'For Northwind Industrial',
            expertName: null,
            suffix: '',
            expertProfileHref: null,
          },
        })}
      />
    );
    expect(screen.getByText('For Northwind Industrial', { selector: 'p' })).toBeInTheDocument();
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual([
      'Projects',
      'View request',
    ]);
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

  it('renders an actions slot beside the status chip', () => {
    render(<EngagementHeader header={header()} actions={<button type="button">More</button>} />);
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('renders the Receipt billing chip on time and materials', () => {
    render(
      <EngagementHeader
        header={header({
          terms: [
            { icon: 'Clock', label: 'Pricing', value: 'Time & materials' },
            { icon: 'Receipt', label: 'Billing', value: 'Billed monthly' },
          ],
        })}
      />
    );
    expect(screen.getByLabelText('Billing: Billed monthly')).toBeInTheDocument();
  });

  it('renders a warning-toned chip in the warning colours, and a plain chip neutral', () => {
    render(
      <EngagementHeader
        header={header({
          terms: [
            { icon: 'Clock', label: 'Pricing', value: 'Time & materials' },
            {
              icon: 'Clock',
              label: 'Last delivery activity',
              value: 'Quiet for 16 days · worth a check-in with Priya',
              tone: 'warning',
            },
          ],
        })}
      />
    );
    const quiet = screen.getByLabelText(
      'Last delivery activity: Quiet for 16 days · worth a check-in with Priya'
    );
    expect(quiet).toHaveClass('text-warning-strong', 'bg-warning/10');
    const plain = screen.getByLabelText('Pricing: Time & materials');
    expect(plain).toHaveClass('text-muted-foreground');
    expect(plain).not.toHaveClass('text-warning-strong');
  });
});
