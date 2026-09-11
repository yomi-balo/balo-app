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
              isCurrent: true,
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
  });
});
