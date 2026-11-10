import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@/test/utils';
import type { ApplicationSummaryView } from '@/lib/expert/application-summary';

vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
}));

import { ApplicationSummarySections } from './application-summary-sections';

function ratings(fix: number): ApplicationSummaryView['products'][number]['ratings'] {
  return [
    { supportTypeId: 'st-fix', slug: 'technical-fix', name: 'Technical Fix', proficiency: fix },
    { supportTypeId: 'st-arch', slug: 'architecture', name: 'Architecture', proficiency: 0 },
  ];
}

function buildSummary(overrides: Partial<ApplicationSummaryView> = {}): ApplicationSummaryView {
  return {
    experience: {
      yearStarted: 2018,
      projectCountMin: 10,
      projectLeadCountMin: null,
      linkedinUrl: 'https://linkedin.com/in/jane-doe',
    },
    languages: [{ id: 'l1', name: 'English', flagEmoji: null, proficiency: 'native' }],
    industries: [{ id: 'i1', name: 'Financial Services' }],
    distinctions: ['Salesforce MVP'],
    products: [
      { id: 'p1', name: 'CPQ', rated: true, ratings: ratings(8) },
      { id: 'p2', name: 'Lead Mgmt', rated: false, ratings: ratings(0) },
    ],
    trailheadUrl: 'https://trailblazer.me/id/jane',
    certifications: [{ id: 'c1', name: 'Certified Administrator', category: 'Administrator' }],
    workHistory: [
      {
        key: 'w1',
        role: 'Lead Consultant',
        company: 'Acme',
        isCurrent: true,
        periodLabel: 'Mar 2019 — Present',
        responsibilities: 'Led delivery.',
      },
    ],
    ...overrides,
  };
}

describe('ApplicationSummarySections', () => {
  it('shows no Edit buttons and no Rate now link without onEdit', () => {
    render(<ApplicationSummarySections summary={buildSummary()} />);

    expect(screen.queryByRole('button', { name: /^edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /rate now/i })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent("Lead Mgmt isn't rated yet.");
  });

  it('fires onEdit with the section target for each Edit button', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<ApplicationSummarySections summary={buildSummary()} onEdit={onEdit} />);

    await user.click(screen.getByRole('button', { name: 'Edit experience' }));
    await user.click(
      screen.getByRole('button', { name: 'Edit languages, industries and distinctions' })
    );
    await user.click(screen.getByRole('button', { name: 'Edit products and ratings' }));
    await user.click(screen.getByRole('button', { name: 'Edit certifications' }));
    await user.click(screen.getByRole('button', { name: 'Edit work history' }));

    expect(onEdit.mock.calls.map(([target]) => target)).toEqual([
      'profile',
      'profile',
      'assessment',
      'certifications',
      'work-history',
    ]);
  });

  it('flags a single unrated product by name and offers Rate now', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<ApplicationSummarySections summary={buildSummary()} onEdit={onEdit} />);

    const callout = screen.getByRole('status');
    expect(callout).toHaveTextContent("Lead Mgmt isn't rated yet.");
    await user.click(within(callout).getByRole('button', { name: 'Rate now' }));

    expect(onEdit).toHaveBeenCalledWith('assessment');
    expect(screen.getByText('Not rated')).toBeInTheDocument();
  });

  it('uses the plural copy when several products are unrated', () => {
    const summary = buildSummary({
      products: [
        { id: 'p1', name: 'CPQ', rated: false, ratings: ratings(0) },
        { id: 'p2', name: 'Lead Mgmt', rated: false, ratings: ratings(0) },
      ],
    });
    render(<ApplicationSummarySections summary={summary} />);

    expect(screen.getByRole('status')).toHaveTextContent("2 products aren't rated yet.");
  });

  it('shows no callout when every product is rated', () => {
    const summary = buildSummary({
      products: [{ id: 'p1', name: 'CPQ', rated: true, ratings: ratings(8) }],
    });
    render(<ApplicationSummarySections summary={summary} />);

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('1 product')).toBeInTheDocument();
  });

  it('renders "None" for unanswered project counts', () => {
    render(
      <ApplicationSummarySections
        summary={buildSummary({
          experience: {
            yearStarted: null,
            projectCountMin: null,
            projectLeadCountMin: null,
            linkedinUrl: null,
          },
        })}
      />
    );

    expect(screen.getAllByText('None')).toHaveLength(2);
    expect(screen.queryByText('LinkedIn')).not.toBeInTheDocument();
  });

  it('hides empty certifications and work history without onEdit', () => {
    const summary = buildSummary({ certifications: [], trailheadUrl: null, workHistory: [] });
    render(<ApplicationSummarySections summary={summary} />);

    expect(screen.queryByText('Certifications')).not.toBeInTheDocument();
    expect(screen.queryByText('Work history')).not.toBeInTheDocument();
  });

  it('keeps empty certifications and work history with invitation copy when editable', () => {
    const summary = buildSummary({ certifications: [], trailheadUrl: null, workHistory: [] });
    render(<ApplicationSummarySections summary={summary} onEdit={vi.fn()} />);

    expect(
      screen.getByText('Add your certifications to strengthen your application.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('Add your recent roles so we can see your experience.')
    ).toBeInTheDocument();
  });

  it('invites product selection when editable with none chosen', () => {
    render(
      <ApplicationSummarySections summary={buildSummary({ products: [] })} onEdit={vi.fn()} />
    );

    expect(screen.getByText('Choose the Salesforce products you work with.')).toBeInTheDocument();
  });

  it('invites adding industries and distinctions when editable', () => {
    render(
      <ApplicationSummarySections
        summary={buildSummary({ distinctions: [], industries: [] })}
        onEdit={vi.fn()}
      />
    );

    expect(screen.getByText('Add the industries you work in.')).toBeInTheDocument();
    expect(screen.getByText('Add any Salesforce distinctions you hold.')).toBeInTheDocument();
  });

  it('sends the Products Edit to the products step when none are selected', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    render(<ApplicationSummarySections summary={buildSummary({ products: [] })} onEdit={onEdit} />);

    await user.click(screen.getByRole('button', { name: 'Edit products and ratings' }));

    expect(onEdit).toHaveBeenCalledWith('products');
  });

  it('notes empty distinctions and industries', () => {
    render(
      <ApplicationSummarySections summary={buildSummary({ distinctions: [], industries: [] })} />
    );

    expect(screen.getByText('No distinctions selected')).toBeInTheDocument();
    expect(screen.getByText('No industries selected')).toBeInTheDocument();
  });

  it('renders work history responsibilities through the rich-text viewer', () => {
    render(<ApplicationSummarySections summary={buildSummary()} />);

    expect(screen.getByTestId('rt-viewer')).toHaveTextContent('<p>Led delivery.</p>');
    expect(screen.getByText('Current')).toBeInTheDocument();
    expect(screen.getByText('Mar 2019 — Present')).toBeInTheDocument();
  });
});
