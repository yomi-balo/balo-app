import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import type {
  ApplicationWithRelations,
  ProductsByCategory,
  CertificationsByCategory,
  SupportType,
} from '@balo/db';

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

import { ApplicationReview } from './application-review';

// ── Fixtures ─────────────────────────────────────────────────────

// Reference taxonomy — drives the `for (const product of cat.products)` and
// `for (const cert of cat.certifications)` category-map loops (lines ~290, ~318).
const productsByCategory: ProductsByCategory[] = [
  {
    category: { id: 'cat-sales', name: 'Sales Cloud', slug: 'sales-cloud', sortOrder: 0 },
    products: [
      { id: 'skill-cpq', name: 'CPQ', slug: 'cpq', sortOrder: 0 },
      { id: 'skill-leads', name: 'Lead Mgmt', slug: 'lead-mgmt', sortOrder: 1 },
    ],
  },
  {
    category: { id: 'cat-service', name: 'Service Cloud', slug: 'service-cloud', sortOrder: 1 },
    products: [{ id: 'skill-cases', name: 'Case Mgmt', slug: 'case-mgmt', sortOrder: 0 }],
  },
];

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
      productsByCategory: ProductsByCategory[];
      certificationsByCategory: CertificationsByCategory[];
    }>
  ): void {
    render(
      <ApplicationReview
        application={overrides?.application ?? buildApplication()}
        email="jane@example.com"
        productsByCategory={overrides?.productsByCategory ?? productsByCategory}
        supportTypes={supportTypes}
        certificationsByCategory={overrides?.certificationsByCategory ?? certificationsByCategory}
      />
    );
  }

  it('renders the application header and reviewer email', () => {
    renderReview();
    expect(screen.getByRole('heading', { name: /your application/i })).toBeInTheDocument();
    expect(screen.getByText(/jane@example.com/i)).toBeInTheDocument();
  });

  it('groups selected products under their reference-data categories', () => {
    // Exercises the skill→category loop over cat.products (line ~290) and the
    // products-by-category render.
    renderReview();
    expect(screen.getByText('Sales Cloud')).toBeInTheDocument();
    expect(screen.getByText('Service Cloud')).toBeInTheDocument();
    // CPQ + Case Mgmt each appear in the products list and as assessment card titles.
    expect(screen.getAllByText('CPQ').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Case Mgmt').length).toBeGreaterThan(0);
  });

  it('renders the self-assessment cards for each rated skill', () => {
    renderReview();
    expect(screen.getByText(/self-assessment/i)).toBeInTheDocument();
    // Support-type labels render per skill card.
    expect(screen.getAllByText('Technical Fix').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Architecture').length).toBeGreaterThan(0);
  });

  it('renders certifications using the cert→category map (line ~318)', () => {
    renderReview();
    expect(screen.getByText('Certified Administrator')).toBeInTheDocument();
    expect(screen.getByText('Administrator')).toBeInTheDocument();
  });

  it('renders languages, industries and distinctions', () => {
    renderReview();
    expect(screen.getByText('English')).toBeInTheDocument();
    expect(screen.getByText('Financial Services')).toBeInTheDocument();
    expect(screen.getByText('Salesforce MVP')).toBeInTheDocument();
    expect(screen.getByText('Certified Trainer')).toBeInTheDocument();
  });

  it('renders work history entries', () => {
    renderReview();
    expect(screen.getByText('Lead Consultant')).toBeInTheDocument();
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Current')).toBeInTheDocument();
  });

  it('falls back to "Other" category when a product is not in reference data', () => {
    // Empty taxonomy → productCategoryMap is empty → every product groups under "Other".
    renderReview({ productsByCategory: [] });
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('omits the products section when there are no competencies', () => {
    const app = buildApplication();
    const noCompetencies = { ...app, competencies: [] } as ApplicationWithRelations;
    renderReview({ application: noCompetencies });
    expect(screen.queryByText(/product expertise/i)).not.toBeInTheDocument();
  });
});
