import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { ApplicationSections } from './application-sections';
import type { ApplicationWithRelations } from '@balo/db';

function application(overrides: Partial<ApplicationWithRelations> = {}): ApplicationWithRelations {
  return {
    profile: {
      id: 'p1',
      yearStartedSalesforce: 2018,
      projectCountMin: 10,
      projectLeadCountMin: 1,
      linkedinUrl: null,
      trailheadUrl: null,
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
      declineNote: 'Balo-only internal note — must never render on the staff sections',
      // Remaining ExpertProfile fields are irrelevant to this component and are not read.
    } as unknown as ApplicationWithRelations['profile'],
    user: {
      id: 'u1',
      firstName: 'Priya',
      lastName: 'Shah',
      email: 'priya@example.com',
      avatarUrl: null,
      phone: null,
      timezone: null,
      country: null,
      countryCode: null,
      deletedAt: null,
    },
    agency: null,
    competencies: [],
    certifications: [],
    languages: [],
    industries: [],
    workHistory: [],
    ...overrides,
  };
}

describe('ApplicationSections', () => {
  it('renders the experience section', () => {
    render(
      <ApplicationSections
        application={application()}
        productsByCategory={[]}
        supportTypes={[]}
        certificationsByCategory={[]}
      />
    );
    expect(screen.getByText('Experience')).toBeInTheDocument();
    expect(screen.getByText('2018')).toBeInTheDocument();
  });

  it('never renders decline_note, even though it is on the full profile row', () => {
    render(
      <ApplicationSections
        application={application()}
        productsByCategory={[]}
        supportTypes={[]}
        certificationsByCategory={[]}
      />
    );
    expect(screen.queryByText(/must never render on the staff sections/i)).not.toBeInTheDocument();
  });

  it('shows "None selected" for industries and distinctions when empty', () => {
    render(
      <ApplicationSections
        application={application()}
        productsByCategory={[]}
        supportTypes={[]}
        certificationsByCategory={[]}
      />
    );
    expect(screen.getAllByText('None selected')).toHaveLength(2);
  });

  it('renders a language row with its proficiency badge', () => {
    render(
      <ApplicationSections
        application={application({
          languages: [
            {
              id: 'l1',
              expertProfileId: 'p1',
              languageId: 'lang-1',
              proficiency: 'advanced',
              language: { id: 'lang-1', name: 'French', code: 'fr', flagEmoji: '🇫🇷' },
            } as unknown as ApplicationWithRelations['languages'][number],
          ],
        })}
        productsByCategory={[]}
        supportTypes={[]}
        certificationsByCategory={[]}
      />
    );
    expect(screen.getByText('French')).toBeInTheDocument();
    expect(screen.getByText('advanced')).toBeInTheDocument();
  });

  it('renders work history with a Current badge', () => {
    render(
      <ApplicationSections
        application={application({
          workHistory: [
            {
              id: 'w1',
              role: 'Solutions Architect',
              company: 'Acme Corp',
              startedAt: new Date('2025-04-01T00:00:00.000Z'),
              endedAt: null,
              isCurrent: true,
              responsibilities: null,
            } as unknown as ApplicationWithRelations['workHistory'][number],
          ],
        })}
        productsByCategory={[]}
        supportTypes={[]}
        certificationsByCategory={[]}
      />
    );
    expect(screen.getByText('Solutions Architect')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
    // A current role's tenure is open-ended.
    expect(screen.getByText(/Apr 2025 — Present/)).toBeInTheDocument();
  });

  /**
   * WEB-REVIEW FIX ROUND W2 — TENURE AND RESPONSIBILITIES ARE WHAT THE DECISION NEEDS.
   *
   * This section rendered role + company + a `Current` badge and nothing else, while the
   * applicant's own review page has always shown the date range and what they wrote about the
   * role. Those two fields are precisely the evidence a reviewer weighs when choosing the
   * `experience_depth` decline reason, so omitting them undermined the decision this page exists
   * to support.
   *
   * MUTATION-PROVEN: delete either the `formatPeriod` line or the `responsibilities` block in
   * `application-sections.tsx` and this goes red on that half.
   */
  it('renders the tenure range and the responsibilities the applicant wrote', () => {
    render(
      <ApplicationSections
        application={application({
          workHistory: [
            {
              id: 'w1',
              role: 'Lead Consultant',
              company: 'Northwind',
              startedAt: new Date('2017-11-01T00:00:00.000Z'),
              endedAt: new Date('2020-04-01T00:00:00.000Z'),
              isCurrent: false,
              responsibilities: 'Owned the CPQ rollout across three business units.',
            } as unknown as ApplicationWithRelations['workHistory'][number],
          ],
        })}
        productsByCategory={[]}
        supportTypes={[]}
        certificationsByCategory={[]}
      />
    );
    expect(screen.getByText(/Nov 2017 — Apr 2020/)).toBeInTheDocument();
    expect(
      screen.getByText('Owned the CPQ rollout across three business units.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Current')).toBeNull();
  });

  it('renders the tenure but no responsibilities paragraph when the applicant left it blank', () => {
    const { container } = render(
      <ApplicationSections
        application={application({
          workHistory: [
            {
              id: 'w1',
              role: 'Lead Consultant',
              company: 'Northwind',
              startedAt: new Date('2017-11-01T00:00:00.000Z'),
              endedAt: new Date('2020-04-01T00:00:00.000Z'),
              isCurrent: false,
              responsibilities: '',
            } as unknown as ApplicationWithRelations['workHistory'][number],
          ],
        })}
        productsByCategory={[]}
        supportTypes={[]}
        certificationsByCategory={[]}
      />
    );
    expect(screen.getByText(/Nov 2017 — Apr 2020/)).toBeInTheDocument();
    // No empty bordered paragraph left behind.
    expect(container.querySelector('.border-t')).toBeNull();
  });
});
