import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { axe } from 'jest-axe';
import { ApplicationReviewBanner } from './application-review-banner';

const SUBMITTED = new Date('2026-10-03T09:00:00.000Z');

describe('ApplicationReviewBanner', () => {
  it('says the application is under review, when it was submitted, and where the answer goes', () => {
    render(<ApplicationReviewBanner submittedAt={SUBMITTED} email="dana@northwind.test" />);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Your expert application is under review');
    expect(banner).toHaveTextContent('Submitted on October 3, 2026.');
    expect(banner).toHaveTextContent(
      "We'll email you at dana@northwind.test as soon as there's a decision — usually within 2–3 business days."
    );
  });

  it('links to the applicant’s read-only view of their application', () => {
    render(<ApplicationReviewBanner submittedAt={SUBMITTED} email="dana@northwind.test" />);
    expect(screen.getByRole('link', { name: 'View your application' })).toHaveAttribute(
      'href',
      '/expert/apply/review'
    );
  });

  it('drops the submitted sentence rather than printing a placeholder date', () => {
    render(<ApplicationReviewBanner submittedAt={null} email="dana@northwind.test" />);
    expect(screen.getByRole('status')).not.toHaveTextContent('Submitted on');
    expect(screen.getByRole('status')).not.toHaveTextContent('N/A');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <div>
        <h1>Dashboard</h1>
        <ApplicationReviewBanner submittedAt={SUBMITTED} email="dana@northwind.test" />
      </div>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
