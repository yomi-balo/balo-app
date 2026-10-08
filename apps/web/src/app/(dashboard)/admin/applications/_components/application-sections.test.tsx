import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/utils';
import { ApplicationSections, WorkHistorySection } from './application-sections';
import type { ApplicationWithRelations, StaffSelfRating, SupportType } from '@balo/db';

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

const SUPPORT_TYPES: SupportType[] = [
  { id: 'st-config', slug: 'config', name: 'Configuration' } as unknown as SupportType,
  { id: 'st-dev', slug: 'development', name: 'Development' } as unknown as SupportType,
];

interface RenderSectionsOptions {
  application?: ApplicationWithRelations;
  supportTypes?: readonly SupportType[];
  selfRatings?: readonly StaffSelfRating[] | null;
  skillsLocked?: boolean;
}

function renderSections({
  application: applicationOverride,
  supportTypes = [],
  // A destructuring default only applies to `undefined` (an OMITTED key), never to an
  // explicitly-passed `null` — the view-only arm needs exactly that distinction,
  // which `options.selfRatings ?? []` would erase.
  selfRatings = [],
  skillsLocked = false,
}: RenderSectionsOptions = {}) {
  return render(
    <ApplicationSections
      application={applicationOverride ?? application()}
      productsByCategory={[]}
      supportTypes={supportTypes}
      certificationsByCategory={[]}
      selfRatings={selfRatings}
      skillsLocked={skillsLocked}
    />
  );
}

const PRODUCT_ID = 'product-1';

function applicationWithOneCompetency(
  overrides: Partial<ApplicationWithRelations> = {}
): ApplicationWithRelations {
  return application({
    competencies: [
      {
        id: 'comp-1',
        expertProfileId: 'p1',
        productId: PRODUCT_ID,
        supportTypeId: 'st-config',
        proficiency: 5,
        product: { id: PRODUCT_ID, name: 'Sales Cloud' },
        supportType: SUPPORT_TYPES[0],
      } as unknown as ApplicationWithRelations['competencies'][number],
      {
        id: 'comp-2',
        expertProfileId: 'p1',
        productId: PRODUCT_ID,
        supportTypeId: 'st-dev',
        proficiency: 3,
        product: { id: PRODUCT_ID, name: 'Sales Cloud' },
        supportType: SUPPORT_TYPES[1],
      } as unknown as ApplicationWithRelations['competencies'][number],
    ],
    ...overrides,
  });
}

describe('ApplicationSections', () => {
  it('renders the experience section', () => {
    renderSections();
    expect(screen.getByText('Experience')).toBeInTheDocument();
    expect(screen.getByText('2018')).toBeInTheDocument();
  });

  it('never renders decline_note, even though it is on the full profile row', () => {
    renderSections();
    expect(screen.queryByText(/must never render on the staff sections/i)).not.toBeInTheDocument();
  });

  it('shows "None selected" for industries and distinctions when empty', () => {
    renderSections();
    expect(screen.getAllByText('None selected')).toHaveLength(2);
  });

  it('renders a language row with its proficiency badge', () => {
    renderSections({
      application: application({
        languages: [
          {
            id: 'l1',
            expertProfileId: 'p1',
            languageId: 'lang-1',
            proficiency: 'advanced',
            language: { id: 'lang-1', name: 'French', code: 'fr', flagEmoji: '🇫🇷' },
          } as unknown as ApplicationWithRelations['languages'][number],
        ],
      }),
    });
    expect(screen.getByText('French')).toBeInTheDocument();
    expect(screen.getByText('advanced')).toBeInTheDocument();
  });

  /**
   * `WorkHistorySection` is rendered by the page and the edit workspace, not by
   * `ApplicationSections`, so these tests exercise the exported component directly.
   */
  describe('WorkHistorySection (rendered by the page/workspace, not by ApplicationSections)', () => {
    it('renders work history with a Current badge', () => {
      render(
        <WorkHistorySection
          entries={
            [
              {
                id: 'w1',
                role: 'Solutions Architect',
                company: 'Acme Corp',
                startedAt: new Date('2025-04-01T00:00:00.000Z'),
                endedAt: null,
                isCurrent: true,
                responsibilities: null,
              },
            ] as unknown as ApplicationWithRelations['workHistory']
          }
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
     * `experience_depth` decline reason, so omitting them undermined the decision this page
     * exists to support.
     *
     * MUTATION-PROVEN: delete either the `formatPeriod` line or the `responsibilities` block in
     * `application-sections.tsx` and this goes red on that half.
     */
    it('renders the tenure range and the responsibilities the applicant wrote', () => {
      render(
        <WorkHistorySection
          entries={
            [
              {
                id: 'w1',
                role: 'Lead Consultant',
                company: 'Northwind',
                startedAt: new Date('2017-11-01T00:00:00.000Z'),
                endedAt: new Date('2020-04-01T00:00:00.000Z'),
                isCurrent: false,
                responsibilities: 'Owned the CPQ rollout across three business units.',
              },
            ] as unknown as ApplicationWithRelations['workHistory']
          }
        />
      );
      expect(screen.getByText(/Nov 2017 — Apr 2020/)).toBeInTheDocument();
      expect(
        screen.getByText('Owned the CPQ rollout across three business units.')
      ).toBeInTheDocument();
      expect(screen.queryByText('Current')).toBeNull();
    });

    it('renders rich-text responsibilities with their formatting, and strips anything unsafe', () => {
      const { container } = render(
        <WorkHistorySection
          entries={
            [
              {
                id: 'w1',
                role: 'Lead Consultant',
                company: 'Northwind',
                startedAt: new Date('2017-11-01T00:00:00.000Z'),
                endedAt: new Date('2020-04-01T00:00:00.000Z'),
                isCurrent: false,
                responsibilities:
                  '<ul><li><strong>Owned</strong> the CPQ rollout</li></ul><script>alert(1)</script>',
              },
            ] as unknown as ApplicationWithRelations['workHistory']
          }
        />
      );
      expect(screen.getByRole('listitem')).toHaveTextContent('Owned the CPQ rollout');
      expect(screen.getByText('Owned').tagName).toBe('STRONG');
      expect(container.querySelector('script')).toBeNull();
    });

    it('renders the tenure but no responsibilities paragraph when the applicant left it blank', () => {
      const { container } = render(
        <WorkHistorySection
          entries={
            [
              {
                id: 'w1',
                role: 'Lead Consultant',
                company: 'Northwind',
                startedAt: new Date('2017-11-01T00:00:00.000Z'),
                endedAt: new Date('2020-04-01T00:00:00.000Z'),
                isCurrent: false,
                responsibilities: '',
              },
            ] as unknown as ApplicationWithRelations['workHistory']
          }
        />
      );
      expect(screen.getByText(/Nov 2017 — Apr 2020/)).toBeInTheDocument();
      // No empty bordered paragraph left behind.
      expect(container.querySelector('.border-t')).toBeNull();
    });
  });

  describe('Ratings (BAL-593 — self-rating overlay)', () => {
    it('renders the renamed "Ratings (0–10)" heading, not "Self-assessment"', () => {
      renderSections({ application: applicationWithOneCompetency(), supportTypes: SUPPORT_TYPES });
      expect(screen.getByText('Ratings (0–10)')).toBeInTheDocument();
      expect(screen.queryByText(/Self-assessment/)).toBeNull();
    });

    it('shows "Added by Balo" when every cell has no self-rating', () => {
      renderSections({
        application: applicationWithOneCompetency(),
        supportTypes: SUPPORT_TYPES,
        selfRatings: [],
      });
      expect(screen.getByText('Added by Balo')).toBeInTheDocument();
      expect(screen.queryByText(/adjusted/)).toBeNull();
    });

    it('shows "Self {n} →" only on the cell where self differs from Balo’s rating', () => {
      renderSections({
        application: applicationWithOneCompetency(),
        supportTypes: SUPPORT_TYPES,
        selfRatings: [
          { productId: PRODUCT_ID, supportTypeId: 'st-config', selfProficiency: 8 }, // differs (balo=5)
          { productId: PRODUCT_ID, supportTypeId: 'st-dev', selfProficiency: 3 }, // matches (balo=3)
        ],
      });
      expect(screen.getByText('Self 8 →')).toBeInTheDocument();
      expect(screen.queryByText('Self 3 →')).toBeNull();
      expect(screen.getByText('1 adjusted')).toBeInTheDocument();
      expect(screen.queryByText('Added by Balo')).toBeNull();
    });

    it('renders the legend sentence only when some cell differs', () => {
      const { rerender } = render(
        <ApplicationSections
          application={applicationWithOneCompetency()}
          productsByCategory={[]}
          supportTypes={SUPPORT_TYPES}
          certificationsByCategory={[]}
          selfRatings={[{ productId: PRODUCT_ID, supportTypeId: 'st-config', selfProficiency: 5 }]}
          skillsLocked={false}
        />
      );
      expect(screen.queryByText(/means the expert rated themselves/)).toBeNull();

      rerender(
        <ApplicationSections
          application={applicationWithOneCompetency()}
          productsByCategory={[]}
          supportTypes={SUPPORT_TYPES}
          certificationsByCategory={[]}
          selfRatings={[{ productId: PRODUCT_ID, supportTypeId: 'st-config', selfProficiency: 8 }]}
          skillsLocked={false}
        />
      );
      expect(screen.getByText(/means the expert rated themselves/)).toBeInTheDocument();
    });

    it('renders no "Self" text for a cell missing from selfRatings', () => {
      renderSections({
        application: applicationWithOneCompetency(),
        supportTypes: SUPPORT_TYPES,
        selfRatings: [],
      });
      expect(screen.queryByText(/^Self \d+ →$/)).toBeNull();
    });

    /**
     * `selfRatings: null` (the view-only viewer) renders
     * Balo's value only. An empty ARRAY still means "every cell was self-rated the same as
     * Balo's" and gets its own badge path (`staffAdded` / adjusted count); `null` suppresses that
     * badge logic entirely rather than guessing from an absent overlay.
     */
    it('renders Balo-only — no "Added by Balo", no "n adjusted", no legend — when selfRatings is null', () => {
      renderSections({
        application: applicationWithOneCompetency(),
        supportTypes: SUPPORT_TYPES,
        selfRatings: null,
      });
      expect(screen.queryByText(/^Self \d+ →$/)).toBeNull();
      expect(screen.queryByText('Added by Balo')).toBeNull();
      expect(screen.queryByText(/adjusted/)).toBeNull();
      expect(screen.queryByText(/means the expert rated themselves/)).toBeNull();
    });
  });

  describe('Locked pill (Decision 4)', () => {
    it('shows "Locked for the expert" on Product expertise, Ratings and Certifications when skillsLocked', () => {
      renderSections({
        application: applicationWithOneCompetency({
          certifications: [
            {
              id: 'cert-row-1',
              expertProfileId: 'p1',
              certificationId: 'cert-1',
              certification: { id: 'cert-1', name: 'Platform Developer I' },
            } as unknown as ApplicationWithRelations['certifications'][number],
          ],
        }),
        supportTypes: SUPPORT_TYPES,
        skillsLocked: true,
      });
      expect(screen.getAllByText('Locked for the expert')).toHaveLength(3);
    });

    it('shows no locked pill when skillsLocked is false', () => {
      renderSections({
        application: applicationWithOneCompetency(),
        supportTypes: SUPPORT_TYPES,
        skillsLocked: false,
      });
      expect(screen.queryByText('Locked for the expert')).toBeNull();
    });
  });
});
