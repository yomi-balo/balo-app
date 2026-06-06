import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import { createRef } from 'react';
import type { ReferenceData } from '../_actions/load-draft';
import type { ApplicationWithRelations, SupportType } from '@balo/db';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../_actions/save-draft', () => ({
  saveDraftAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../_actions/submit-application', () => ({
  submitApplicationAction: vi.fn().mockResolvedValue({ success: true }),
}));

// Stub motion to render plain elements.
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

import { StepAssessment } from './step-assessment';
import { ExpertApplicationProvider } from './expert-application-context';

// ── Fixtures ─────────────────────────────────────────────────────

const supportTypes = [
  { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
  { id: 'st-arch', name: 'Architecture', slug: 'architecture' },
] as unknown as SupportType[];

// Categories with products — drives the skillNameMap loop (line ~61).
const referenceData: ReferenceData = {
  skillsByCategory: [
    {
      category: { id: 'cat-sales', name: 'Sales Cloud', slug: 'sales-cloud', sortOrder: 0 },
      products: [
        { id: 'skill-cpq', name: 'CPQ', slug: 'cpq', sortOrder: 0 },
        { id: 'skill-leads', name: 'Lead Mgmt', slug: 'lead-mgmt', sortOrder: 1 },
      ],
    },
  ],
  supportTypes,
  certificationsByCategory: [],
  languages: [],
  industries: [],
  vertical: { id: 'vertical-1' } as ReferenceData['vertical'],
};

// Draft with a selected, rated skill — so `hydrateProductsData` populates
// productsData.skillIds and an assessment card renders for it.
const draft = {
  profile: {
    id: 'profile-1',
    userId: 'user-1',
    applicationStatus: 'draft',
    yearStartedSalesforce: null,
    linkedinUrl: null,
    trailheadUrl: null,
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
  },
  skills: [
    { id: 'c1', skillId: 'skill-cpq', supportTypeId: 'st-fix', proficiency: 6 },
    { id: 'c2', skillId: 'skill-cpq', supportTypeId: 'st-arch', proficiency: 0 },
  ],
  certifications: [],
  languages: [],
  industries: [],
  workHistory: [],
} as unknown as ApplicationWithRelations;

function renderStep(draftArg: ApplicationWithRelations | null): void {
  const headingRef = createRef<HTMLHeadingElement>();
  render(
    <ExpertApplicationProvider
      draft={draftArg}
      referenceData={referenceData}
      user={{ id: 'user-1', email: 'jane@example.com' }}
    >
      <StepAssessment headingRef={headingRef} />
    </ExpertApplicationProvider>
  );
}

// ── Tests ────────────────────────────────────────────────────────

describe('StepAssessment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the step heading and dimension guide', () => {
    renderStep(null);
    expect(screen.getByText(/rate your expertise/i)).toBeInTheDocument();
    expect(screen.getByText(/the 4 dimensions/i)).toBeInTheDocument();
  });

  it('renders an assessment card per selected skill, resolving names via the skill map', () => {
    // With a hydrated draft, productsData.skillIds = ['skill-cpq'] and the
    // skillNameMap (line ~61) resolves 'skill-cpq' → 'CPQ' for the card title.
    renderStep(draft);
    expect(screen.getByText('CPQ')).toBeInTheDocument();
  });

  it('shows progress reflecting the number of selected products', () => {
    renderStep(draft);
    expect(screen.getByText(/1 products assessed/i)).toBeInTheDocument();
  });

  it('renders zero assessment cards when no skills are selected', () => {
    renderStep(null);
    // No draft → no selected skills → "0 of 0 products assessed".
    expect(screen.getByText(/0 of 0 products assessed/i)).toBeInTheDocument();
    expect(screen.queryByText('CPQ')).not.toBeInTheDocument();
  });
});
