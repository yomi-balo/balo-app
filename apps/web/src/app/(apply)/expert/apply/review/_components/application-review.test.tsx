import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import type { ApplicationWithRelations, CertificationsByCategory, SupportType } from '@balo/db';

// ── Mocks ────────────────────────────────────────────────────────

// Stub motion to render plain elements — avoids animation timing in tests.
const MOTION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'variants',
  'transition',
  'whileHover',
  'whileTap',
  'custom',
  'layout',
]);

vi.mock('motion/react', async () => {
  const React = await import('react');
  return {
    motion: new Proxy(
      {},
      {
        get: (_t: unknown, prop: string) =>
          React.forwardRef(function MotionStub(
            props: Record<string, unknown>,
            ref: React.Ref<unknown>
          ) {
            const filtered: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(props)) {
              if (!MOTION_PROPS.has(key)) filtered[key] = value;
            }
            return React.createElement(prop, { ...filtered, ref });
          }),
      }
    ),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

// The real viewer is Tiptap behind `next/dynamic`; it has its own suite. This stub shows the HTML
// it is handed, which is what this page decides.
vi.mock('@/components/balo/rich-text-editor', () => ({
  RichTextViewer: ({ value }: { value: string }) => <div data-testid="rt-viewer">{value}</div>,
}));

import { ApplicationReview } from './application-review';

// ── Fixtures ─────────────────────────────────────────────────────

// Reference taxonomy — supplies each certification's category.
const certificationsByCategory: CertificationsByCategory[] = [
  {
    category: { id: 'cc-admin', name: 'Administrator', slug: 'administrator', sortOrder: 0 },
    certifications: [{ id: 'cert-admin', name: 'Certified Administrator', slug: 'admin' }],
  },
];

const supportTypes = [
  { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
  { id: 'st-arch', name: 'Architecture', slug: 'architecture' },
] as unknown as SupportType[];

// A fully-populated submitted application. The DB select types carry many
// columns the review doesn't read, so we shape only what's rendered and cast
// through `unknown` — the standard component-test fixture pattern here.
function buildApplication(): ApplicationWithRelations {
  return {
    profile: {
      id: 'profile-1',
      userId: 'user-1',
      applicationStatus: 'submitted',
      yearStartedSalesforce: 2018,
      projectCountMin: 10,
      projectLeadCountMin: 1,
      linkedinUrl: 'jane-doe',
      trailheadUrl: 'jane-trail',
      isSalesforceMvp: true,
      isSalesforceCta: false,
      isCertifiedTrainer: true,
      submittedAt: new Date('2026-01-15T00:00:00.000Z'),
    },
    competencies: [
      {
        id: 'comp-1',
        productId: 'skill-cpq',
        supportTypeId: 'st-fix',
        proficiency: 8,
        product: { id: 'skill-cpq', name: 'CPQ' },
        supportType: { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
      },
      {
        id: 'comp-2',
        productId: 'skill-cpq',
        supportTypeId: 'st-arch',
        proficiency: 5,
        product: { id: 'skill-cpq', name: 'CPQ' },
        supportType: { id: 'st-arch', name: 'Architecture', slug: 'architecture' },
      },
      {
        id: 'comp-3',
        productId: 'skill-cases',
        supportTypeId: 'st-fix',
        proficiency: 7,
        product: { id: 'skill-cases', name: 'Case Mgmt' },
        supportType: { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
      },
    ],
    certifications: [
      {
        id: 'ec-1',
        certificationId: 'cert-admin',
        earnedAt: '2020-01-01',
        expiresAt: null,
        credentialUrl: null,
        certification: { id: 'cert-admin', name: 'Certified Administrator' },
      },
    ],
    languages: [
      {
        id: 'el-1',
        languageId: 'lang-en',
        proficiency: 'native',
        language: { id: 'lang-en', name: 'English', code: 'en', flagEmoji: '🇬🇧' },
      },
    ],
    industries: [
      {
        id: 'ei-1',
        industryId: 'ind-fin',
        industry: { id: 'ind-fin', name: 'Financial Services', slug: 'financial-services' },
      },
    ],
    workHistory: [
      {
        id: 'wh-1',
        role: 'Lead Consultant',
        company: 'Acme Corp',
        startedAt: new Date('2019-03-01T00:00:00.000Z'),
        endedAt: null,
        isCurrent: true,
        responsibilities: 'Led Salesforce delivery.',
      },
    ],
  } as unknown as ApplicationWithRelations;
}

// ── Tests ────────────────────────────────────────────────────────

describe('ApplicationReview', () => {
  function renderReview(
    overrides?: Partial<{
      application: ApplicationWithRelations;
      certificationsByCategory: CertificationsByCategory[];
    }>
  ): void {
    render(
      <ApplicationReview
        application={overrides?.application ?? buildApplication()}
        email="jane@example.com"
        supportTypes={supportTypes}
        certificationsByCategory={overrides?.certificationsByCategory ?? certificationsByCategory}
      />
    );
  }

  it('has no Edit links on the read-only page', () => {
    renderReview();
    expect(screen.queryByRole('button', { name: /^edit/i })).not.toBeInTheDocument();
  });

  it('renders the application header and reviewer email', () => {
    renderReview();
    expect(screen.getByRole('heading', { name: /your application/i })).toBeInTheDocument();
    expect(screen.getByText(/jane@example.com/i)).toBeInTheDocument();
  });

  it('renders a card per product with its dimension ratings', () => {
    renderReview();
    expect(screen.getByText('CPQ')).toBeInTheDocument();
    expect(screen.getByText('Case Mgmt')).toBeInTheDocument();
    expect(screen.getByText('2 products')).toBeInTheDocument();
    expect(screen.getAllByText('Technical Fix').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Architecture').length).toBeGreaterThan(0);
  });

  it('renders certifications with their reference-data category', () => {
    renderReview();
    expect(screen.getByText('Certified Administrator')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
  });

  it('renders languages, industries and distinctions', () => {
    renderReview();
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('Financial Services')).toBeInTheDocument();
    expect(screen.getByText('Salesforce MVP')).toBeInTheDocument();
    expect(screen.queryByText('Certified Trainer')).not.toBeInTheDocument();
  });

  it('renders work history entries', () => {
    renderReview();
    expect(screen.getByText('Lead Consultant')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('renders responsibilities through the rich-text viewer, legacy plain text as a paragraph', () => {
    renderReview();
    expect(screen.getByTestId('rt-viewer')).toHaveTextContent('<p>Led Salesforce delivery.</p>');
  });

  it('omits the products section when there are no competencies', () => {
    const app = buildApplication();
    const noCompetencies = { ...app, competencies: [] } as ApplicationWithRelations;
    renderReview({ application: noCompetencies });
    expect(screen.queryByText(/products and ratings/i)).not.toBeInTheDocument();
  });

  /**
   * WEB-REVIEW FIX ROUND W5 — THE APPLICANT-FACING OUTPUT THIS PR MUST NOT CHANGE.
   *
   * The pre-PR de-duplication replaced this page's local `PROJECT_RANGE_MAP[x ?? 0] ?? '—'` with
   * the shared `projectRangeLabel(x)`, which renders `'—'` for a nullish value. That silently
   * changed a SHIPPED applicant-facing surface: an unanswered project-count question used to read
   * "None". The `?? 0` at both call sites in `application-review.tsx` restores it.
   *
   * MUTATION-PROVEN: drop either `?? 0` and this goes red ("—" in place of "None"), while every
   * populated-fixture test above stays green.
   */
  it('renders "None" — not "—" — for an unanswered project count (the shipped output)', () => {
    const app = buildApplication();
    const unanswered = {
      ...app,
      profile: { ...app.profile, projectCountMin: null, projectLeadCountMin: null },
    } as unknown as ApplicationWithRelations;

    renderReview({ application: unanswered });

    // Both rows: "Projects involved in" and "Projects as Lead".
    expect(screen.getAllByText('None')).toHaveLength(2);
  });

  /**
   * BAL-549 plan §7.6 / FIX ROUND F18 — THE CONTAINMENT PROOF AT THE APPLICANT'S UI LAYER.
   *
   * This is the APPLICANT'S OWN review component and it receives the whole application object,
   * so the staff-only decline note is in reach of any future edit here. The repository no longer
   * projects the column (F1) — this pins the component itself, so the two layers fail closed
   * independently, and the fixture deliberately CARRIES a note to make the assertion real.
   *
   * MUTATION: render `application.profile.declineNote` (or the reason) anywhere in
   * `application-review.tsx` → red.
   */
  it('never renders decline_note — nor the decline reason — even when handed one', () => {
    const app = buildApplication();
    const declined = {
      ...app,
      profile: {
        ...app.profile,
        applicationStatus: 'rejected',
        declineReason: 'credentials_unverified',
        declineNote: 'Staff-only: the certifications could not be verified with the issuer.',
      },
    } as unknown as ApplicationWithRelations;

    const { container } = render(
      <ApplicationReview
        application={declined}
        email="jane@example.com"
        supportTypes={supportTypes}
        certificationsByCategory={certificationsByCategory}
      />
    );

    expect(container.innerHTML).not.toContain('Staff-only');
    expect(container.innerHTML).not.toContain('could not be verified with the issuer');
    expect(container.innerHTML).not.toContain('credentials_unverified');
  });
});
