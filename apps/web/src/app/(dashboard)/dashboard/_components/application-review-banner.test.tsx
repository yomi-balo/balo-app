import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { track, EXPERT_EVENTS } from '@/lib/analytics';
import { ApplicationReviewBanner } from './application-review-banner';

const SUBMITTED = 'October 3, 2026';

describe('ApplicationReviewBanner', () => {
  it('says the application is under review, when it was submitted, and where the answer goes', () => {
    render(<ApplicationReviewBanner submittedOn={SUBMITTED} email="dana@northwind.test" />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Your expert application is under review');
    expect(banner).toHaveTextContent('Submitted on October 3, 2026.');
    expect(banner).toHaveTextContent(
      "We'll email you at dana@northwind.test as soon as there's a decision — usually within 2–3 business days."
    );
  });

  it('links to the applicant’s read-only view of their application', () => {
    render(<ApplicationReviewBanner submittedOn={SUBMITTED} email="dana@northwind.test" />);
    expect(screen.getByRole('link', { name: 'View your application' })).toHaveAttribute(
      'href',
      '/expert/apply/review'
    );
  });

  it('tracks a click on its CTA', async () => {
    const user = userEvent.setup();
    render(<ApplicationReviewBanner submittedOn={SUBMITTED} email="dana@northwind.test" />);
    await user.click(screen.getByRole('link', { name: 'View your application' }));
    expect(track).toHaveBeenCalledWith(EXPERT_EVENTS.APPLICATION_REVIEW_BANNER_CLICKED, {});
  });

  it('drops the submitted sentence rather than printing a placeholder date', () => {
    render(<ApplicationReviewBanner submittedOn={null} email="dana@northwind.test" />);
    expect(screen.getByRole('status')).not.toHaveTextContent('Submitted on');
    expect(screen.getByRole('status')).not.toHaveTextContent('N/A');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <div>
        <h1>Dashboard</h1>
        <ApplicationReviewBanner submittedOn={SUBMITTED} email="dana@northwind.test" />
      </div>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
