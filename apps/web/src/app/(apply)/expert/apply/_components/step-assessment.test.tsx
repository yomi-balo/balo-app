import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import type { ReferenceData } from '../_actions/load-draft';
import type { ApplicationWithRelations, SupportType } from '@balo/db';

// ── Mocks ────────────────────────────────────────────────────────

// Togglable reduced-motion state so a dedicated test can execute the
// `reduce ? …` true-branch in assessment-card.tsx for coverage. Default false.
const motionState = vi.hoisted(() => ({ reduce: false }));

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
    useReducedMotion: () => motionState.reduce,
  };
});

import { StepAssessment } from './step-assessment';
import { ExpertApplicationProvider } from './expert-application-context';

// ── Fixtures ─────────────────────────────────────────────────────

const supportTypes = [
  { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
  { id: 'st-arch', name: 'Architecture', slug: 'architecture' },
] as unknown as SupportType[];

// Categories with products — drives the productNameMap loop (line ~61).
const referenceData: ReferenceData = {
  productsByCategory: [
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

// Draft with a selected, rated competency — so `hydrateProductsData` populates
// productsData.productIds and an assessment card renders for it.
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
  competencies: [
    { id: 'c1', productId: 'skill-cpq', supportTypeId: 'st-fix', proficiency: 6 },
    { id: 'c2', productId: 'skill-cpq', supportTypeId: 'st-arch', proficiency: 0 },
  ],
  certifications: [],
  languages: [],
  industries: [],
  workHistory: [],
} as unknown as ApplicationWithRelations;

// A fully-hydrated draft: profile + languages + industries populated AND a
// competency with a non-zero proficiency. This drives `findFirstIncompleteStep`
// past the early profile/products guards so the proficiency-map loop (context
// lines 98-106) actually executes against `draft.competencies`.
const completeDraft = {
  profile: {
    id: 'profile-2',
    userId: 'user-1',
    applicationStatus: 'draft',
    yearStartedSalesforce: 2018,
    linkedinUrl: null,
    trailheadUrl: null,
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
  },
  competencies: [
    { id: 'c1', productId: 'skill-cpq', supportTypeId: 'st-fix', proficiency: 7 },
    { id: 'c2', productId: 'skill-cpq', supportTypeId: 'st-arch', proficiency: 0 },
  ],
  certifications: [],
  languages: [{ languageId: 'lang-en', proficiency: 'native' }],
  industries: [{ industryId: 'ind-fin' }],
  workHistory: [],
} as unknown as ApplicationWithRelations;

// Two products, both fully unrated (every competency at proficiency 0) → both
// incomplete on entry. Drives auto-expand, Done-advance, and single-open cases.
// productsData.productIds = ['skill-cpq', 'skill-leads'] (competency order).
const twoIncompleteDraft = {
  profile: {
    id: 'profile-3',
    userId: 'user-1',
    applicationStatus: 'draft',
    yearStartedSalesforce: null,
    linkedinUrl: null,
    trailheadUrl: null,
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
  },
  competencies: [
    { id: 'c1', productId: 'skill-cpq', supportTypeId: 'st-fix', proficiency: 0 },
    { id: 'c2', productId: 'skill-cpq', supportTypeId: 'st-arch', proficiency: 0 },
    { id: 'c3', productId: 'skill-leads', supportTypeId: 'st-fix', proficiency: 0 },
    { id: 'c4', productId: 'skill-leads', supportTypeId: 'st-arch', proficiency: 0 },
  ],
  certifications: [],
  languages: [],
  industries: [],
  workHistory: [],
} as unknown as ApplicationWithRelations;

// One product, unrated on entry → the lone incomplete card. Drives the terminal
// Done fallback: rating it then clicking Done leaves no next incomplete, so focus
// returns to its own header rather than dropping to <body>.
const singleIncompleteDraft = {
  profile: {
    id: 'profile-4',
    userId: 'user-1',
    applicationStatus: 'draft',
    yearStartedSalesforce: null,
    linkedinUrl: null,
    trailheadUrl: null,
    isSalesforceMvp: false,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
  },
  competencies: [
    { id: 'c1', productId: 'skill-cpq', supportTypeId: 'st-fix', proficiency: 0 },
    { id: 'c2', productId: 'skill-cpq', supportTypeId: 'st-arch', proficiency: 0 },
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
    motionState.reduce = false;
  });

  afterEach(() => {
    motionState.reduce = false;
  });

  it('renders the step heading and dimension guide', () => {
    renderStep(null);
    expect(screen.getByText(/rate your expertise/i)).toBeInTheDocument();
    expect(screen.getByText(/the 4 dimensions/i)).toBeInTheDocument();
  });

  it('renders an assessment card per selected skill, resolving names via the skill map', () => {
    // With a hydrated draft, productsData.productIds = ['skill-cpq'] and the
    // productNameMap (line ~61) resolves 'skill-cpq' → 'CPQ' for the card title.
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

  it('hydrates step statuses from a fully-complete draft (exercises the proficiency-map loop)', () => {
    // With a complete profile + languages + industries + a rated skill, the
    // provider runs the skill-proficiency grouping loop in
    // `findFirstIncompleteStep` (context lines 98-106) instead of bailing at
    // the profile guard. The skill still resolves to a rendered card, and the
    // pre-rated skill counts as assessed.
    renderStep(completeDraft);
    expect(screen.getByText('CPQ')).toBeInTheDocument();
    expect(screen.getByText(/1 of 1 products assessed/i)).toBeInTheDocument();
  });

  it('updates a dimension proficiency via the slider (exercises handleChange map)', async () => {
    const user = userEvent.setup();
    renderStep(draft);

    // CPQ is already rated (proficiency 6) → complete on entry, so the single-open
    // accordion auto-expands the *first incomplete* card — which is none here — and
    // CPQ starts collapsed. Manually expand it to reveal its sliders. The toggle
    // button's accessible name combines the skill name and its status badge
    // ("CPQ ... Completed"), so match by substring.
    await user.click(screen.getByRole('button', { name: /CPQ/ }));

    // Each support type renders a slider thumb (desktop + mobile layouts). Drive
    // the first one with the keyboard so `handleChange` runs its `.map` predicate
    // (line 130), updating only the matching productId/supportTypeId rating.
    const [slider] = screen.getAllByRole('slider');
    expect(slider).toBeDefined();
    if (!slider) throw new Error('expected a slider to be rendered');

    slider.focus();
    await user.keyboard('{ArrowRight}');

    // The CPQ skill already had a non-zero rating, so it stays "assessed".
    expect(screen.getByText(/1 of 1 products assessed/i)).toBeInTheDocument();
  });

  it('auto-expands the first incomplete product on entry, leaving the rest collapsed', () => {
    // Both products unrated → both incomplete. The first (CPQ) auto-opens on mount
    // with no click; the second (Lead Mgmt) stays collapsed (single-open).
    renderStep(twoIncompleteDraft);

    const cpqHeader = screen.getByRole('button', { name: /CPQ/ });
    const leadsHeader = screen.getByRole('button', { name: /Lead Mgmt/ });

    expect(cpqHeader).toHaveAttribute('aria-expanded', 'true');
    expect(leadsHeader).toHaveAttribute('aria-expanded', 'false');
    // The open card reveals its sliders without any interaction.
    expect(screen.getAllByRole('slider').length).toBeGreaterThan(0);
  });

  it('advances to the next incomplete product and moves keyboard focus on Done', async () => {
    const user = userEvent.setup();
    renderStep(twoIncompleteDraft);

    // CPQ is auto-open; its Done button collapses it and advances to Lead Mgmt.
    await user.click(screen.getByRole('button', { name: /done/i }));

    const cpqHeader = screen.getByRole('button', { name: /CPQ/ });
    const leadsHeader = screen.getByRole('button', { name: /Lead Mgmt/ });

    expect(leadsHeader).toHaveAttribute('aria-expanded', 'true');
    expect(cpqHeader).toHaveAttribute('aria-expanded', 'false');
    // Focus follows the advance so keyboard users land on the newly-opened card.
    expect(leadsHeader).toHaveFocus();
  });

  it('keeps a single card open on manual toggle and never auto-overrides the user', async () => {
    const user = userEvent.setup();
    renderStep(twoIncompleteDraft);

    // Opening Lead Mgmt closes the auto-opened CPQ (single-open). Re-query the
    // headers after each click — the motion stub remounts subtrees per render.
    await user.click(screen.getByRole('button', { name: /Lead Mgmt/ }));
    expect(screen.getByRole('button', { name: /Lead Mgmt/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByRole('button', { name: /CPQ/ })).toHaveAttribute('aria-expanded', 'false');

    // Clicking the open card again collapses it, and no other card auto-opens.
    await user.click(screen.getByRole('button', { name: /Lead Mgmt/ }));
    expect(screen.getByRole('button', { name: /Lead Mgmt/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    expect(screen.getByRole('button', { name: /CPQ/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('expands nothing and shows the all-rated note when every product is complete on entry', () => {
    // CPQ is rated on entry (completeDraft) → findFirstIncomplete returns null, so
    // no card auto-expands and the success note renders.
    renderStep(completeDraft);

    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByText(/all products rated/i)).toBeInTheDocument();
  });

  it('still auto-expands the first incomplete product under reduced motion', () => {
    // Exercises the `reduce ? …` true-branch in assessment-card.tsx; behavior is
    // identical to full motion.
    motionState.reduce = true;
    renderStep(twoIncompleteDraft);

    expect(screen.getByRole('button', { name: /CPQ/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('slider').length).toBeGreaterThan(0);
  });

  it('returns focus to the completed card header (not body) on the terminal Done', async () => {
    const user = userEvent.setup();
    renderStep(singleIncompleteDraft);

    // The lone incomplete product auto-opens; rate its first dimension so
    // proficiency > 0 (mirrors the slider test's keyboard interaction).
    const [slider] = screen.getAllByRole('slider');
    expect(slider).toBeDefined();
    if (!slider) throw new Error('expected a slider to be rendered');
    slider.focus();
    await user.keyboard('{ArrowRight}');

    // Terminal Done: no next incomplete → focus falls back to this card's own
    // still-mounted header instead of dropping to <body>.
    await user.click(screen.getByRole('button', { name: /done/i }));

    expect(screen.getByRole('button', { name: /CPQ/ })).toHaveFocus();
    expect(screen.getByText(/all products rated/i)).toBeInTheDocument();
  });
});
