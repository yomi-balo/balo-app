import { describe, it, expect } from 'vitest';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@/test/utils';
import { axe } from '@/test/axe';
import type { ReviewAttribution } from '@balo/shared/reviews';
import { NOTE_CLAMP_CHARS, ReviewEntry, type ReviewEntryProps } from './review-entry';

const SAM: ReviewAttribution = {
  name: 'Sam K.',
  descriptor: 'RevOps Lead @Northwind Logistics',
  initials: 'SK',
};
const LENA: ReviewAttribution = { name: 'Lena W.', descriptor: 'Sales Director', initials: 'LW' };
const ANON: ReviewAttribution = { name: 'Verified client', descriptor: null, initials: null };

function entry(overrides: Partial<ReviewEntryProps> = {}): ReviewEntryProps {
  return {
    engagementKind: 'project',
    rating: 5,
    dateLabel: 'Oct 2026',
    topics: [],
    sharedCompanyName: null,
    raters: [{ id: 'sam', attribution: SAM, rating: 5, note: 'Quoting got much faster.' }],
    ...overrides,
  };
}

describe('ReviewEntry — one rater', () => {
  it('shows the stars, kind badge, date, note and attribution', () => {
    render(<ReviewEntry {...entry()} />);

    expect(screen.getByRole('img', { name: '5.0 out of 5 stars' })).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('Oct 2026')).toBeInTheDocument();
    expect(screen.getByText('Quoting got much faster.')).toBeInTheDocument();
    expect(screen.getByText('Sam K.')).toBeInTheDocument();
    expect(screen.getByText('RevOps Lead @Northwind Logistics')).toBeInTheDocument();
    expect(screen.getByText('SK')).toBeInTheDocument();
  });

  it('wraps unbroken attribution and note text instead of overflowing', () => {
    const long = 'x'.repeat(80);
    render(
      <ReviewEntry
        {...entry({
          raters: [
            {
              id: 'sam',
              attribution: { name: 'Sam K.', descriptor: `${long} @Co`, initials: 'SK' },
              rating: 5,
              note: long,
            },
          ],
        })}
      />
    );
    expect(screen.getByText(long)).toHaveClass('break-words');
    expect(screen.getByText(`${long} @Co`)).toHaveClass('break-words');
    expect(screen.getByText('Sam K.')).toHaveClass('break-words');
  });

  it('labels a case as a Consultation', () => {
    render(<ReviewEntry {...entry({ engagementKind: 'case' })} />);
    expect(screen.getByText('Consultation')).toBeInTheDocument();
    expect(screen.queryByText('Project')).not.toBeInTheDocument();
  });

  it('renders a null note identically to no note — no placeholder', () => {
    const { container } = render(
      <ReviewEntry
        {...entry({ raters: [{ id: 'sam', attribution: SAM, rating: 5, note: null }] })}
      />
    );
    expect(screen.queryByText(/no comment/i)).not.toBeInTheDocument();
    expect(container.querySelectorAll('p')).toHaveLength(0);
  });

  it('shows an icon, not initials, for an unnamed reviewer, and no descriptor line', () => {
    render(
      <ReviewEntry
        {...entry({ raters: [{ id: 'anon', attribution: ANON, rating: 4, note: null }] })}
      />
    );
    expect(screen.getByText('Verified client')).toBeInTheDocument();
    expect(document.querySelector('svg.lucide-user')).not.toBeNull();
  });

  it('omits the date when there is none', () => {
    render(<ReviewEntry {...entry({ dateLabel: null })} />);
    expect(screen.queryByText('Oct 2026')).not.toBeInTheDocument();
  });

  it('renders topics as a list, and nothing for an empty list', () => {
    const { rerender } = render(<ReviewEntry {...entry({ topics: ['CPQ', 'Sales Cloud'] })} />);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'CPQ',
      'Sales Cloud',
    ]);
    rerender(<ReviewEntry {...entry({ topics: [] })} />);
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('rounds the star label to one decimal', () => {
    render(<ReviewEntry {...entry({ rating: 4.666 })} />);
    expect(screen.getByRole('img', { name: '4.7 out of 5 stars' })).toBeInTheDocument();
  });

  it('gives the first entry no top rule and later ones a rule', () => {
    const { rerender } = render(<ReviewEntry {...entry({ first: true })} />);
    expect(screen.getByRole('article')).not.toHaveClass('border-t');
    rerender(<ReviewEntry {...entry()} />);
    expect(screen.getByRole('article')).toHaveClass('border-t');
  });
});

describe('ReviewEntry — note clamp', () => {
  const LONG = 'x'.repeat(NOTE_CLAMP_CHARS + 1);

  it('does not clamp a note at the limit', () => {
    render(
      <ReviewEntry
        {...entry({
          raters: [{ id: 'sam', attribution: SAM, rating: 5, note: 'y'.repeat(NOTE_CLAMP_CHARS) }],
        })}
      />
    );
    expect(screen.queryByRole('button', { name: 'Read more' })).not.toBeInTheDocument();
  });

  it('clamps a long note behind Read more, and Show less folds it again', async () => {
    const user = userEvent.setup();
    render(
      <ReviewEntry
        {...entry({ raters: [{ id: 'sam', attribution: SAM, rating: 5, note: LONG }] })}
      />
    );

    expect(screen.getByText(LONG)).toHaveClass('line-clamp-4');
    await user.click(screen.getByRole('button', { name: 'Read more' }));
    expect(screen.getByText(LONG)).not.toHaveClass('line-clamp-4');
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );

    await user.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByText(LONG)).toHaveClass('line-clamp-4');
  });
});

describe('ReviewEntry — several raters', () => {
  const RATERS: ReviewEntryProps['raters'] = [
    { id: 'sam', attribution: SAM, rating: 5, note: 'Superb.' },
    { id: 'lena', attribution: LENA, rating: 4, note: null },
  ];

  it('names the shared company when every rater opted in', () => {
    render(
      <ReviewEntry {...entry({ rating: 4.5, raters: RATERS, sharedCompanyName: 'Northwind' })} />
    );
    expect(screen.getByText(/Rated by 2 people at Northwind/)).toBeInTheDocument();
  });

  it('says "on the client’s team" otherwise', () => {
    render(<ReviewEntry {...entry({ rating: 4.5, raters: RATERS })} />);
    expect(screen.getByText(/Rated by 2 people on the client’s team/)).toBeInTheDocument();
  });

  it('gives each rater their own stars and shows only the notes that exist', () => {
    render(<ReviewEntry {...entry({ rating: 4.5, raters: RATERS })} />);
    expect(screen.getByRole('img', { name: '5.0 out of 5 stars' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '4.0 out of 5 stars' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: '4.5 out of 5 stars' })).toBeInTheDocument();
    expect(screen.getByText('Superb.')).toBeInTheDocument();
    expect(screen.getByText('Sam K.')).toBeInTheDocument();
    expect(screen.getByText('Lena W.')).toBeInTheDocument();
  });
});

describe('ReviewEntry — accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = render(<ReviewEntry {...entry({ topics: ['CPQ'] })} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
