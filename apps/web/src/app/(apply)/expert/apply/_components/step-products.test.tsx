import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import type { ReferenceData } from '../_actions/load-draft';

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

// Stub motion to render plain elements. Reduced-motion is forced on so the
// shared TaxonomyMultiSelect (and its chip/token children) skip entry/tap
// animations — keeping assertions deterministic.
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
    useReducedMotion: () => true,
  };
});

import { StepProducts } from './step-products';
import { ExpertApplicationProvider } from './expert-application-context';

// ── Fixtures ─────────────────────────────────────────────────────

// Two categories drive the shared component's multi-group path: popup group
// headers, category-tagged pills, and the search filter that can drop a whole
// group.
const referenceData: ReferenceData = {
  productsByCategory: [
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
  ],
  supportTypes: [],
  certificationsByCategory: [],
  languages: [],
  industries: [],
  vertical: { id: 'vertical-1' } as ReferenceData['vertical'],
};

function renderStep(): void {
  const headingRef = createRef<HTMLHeadingElement>();
  render(
    <ExpertApplicationProvider
      draft={null}
      referenceData={referenceData}
      user={{ id: 'user-1', email: 'jane@example.com' }}
    >
      <StepProducts headingRef={headingRef} />
    </ExpertApplicationProvider>
  );
}

const BROWSE_TESTID = 'taxonomy-browse-apply-products';

/** Open the overlay browse popup by clicking the anchored search control. */
async function openBrowse(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByPlaceholderText(/search products/i));
}

// ── Tests ────────────────────────────────────────────────────────

describe('StepProducts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders collapsed at rest — search control visible, no browse tree or chips', () => {
    renderStep();
    expect(screen.getByPlaceholderText(/search products/i)).toBeInTheDocument();
    expect(screen.queryByTestId(BROWSE_TESTID)).not.toBeInTheDocument();
    // The "always-open" defect is gone: products are not on the page until opened.
    expect(screen.queryByRole('button', { name: 'CPQ' })).not.toBeInTheDocument();
  });

  it('reveals every category and its products in the overlay once opened', async () => {
    const user = userEvent.setup();
    renderStep();

    await openBrowse(user);

    expect(screen.getByTestId(BROWSE_TESTID)).toBeInTheDocument();
    expect(screen.getByText('Sales Cloud')).toBeInTheDocument();
    expect(screen.getByText('Service Cloud')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'CPQ' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Lead Mgmt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Case Mgmt' })).toBeInTheDocument();
  });

  it('filters products by the search query, dropping non-matching groups', async () => {
    const user = userEvent.setup();
    renderStep();

    await openBrowse(user);
    await user.type(screen.getByPlaceholderText(/search products/i), 'cpq');

    expect(screen.getByRole('button', { name: 'CPQ' })).toBeInTheDocument();
    // A product that does not match the query is filtered out…
    expect(screen.queryByRole('button', { name: 'Lead Mgmt' })).not.toBeInTheDocument();
    // …and a whole category with no matching products is dropped.
    expect(screen.queryByText('Service Cloud')).not.toBeInTheDocument();
  });

  it('shows the no-match message when nothing matches the query', async () => {
    const user = userEvent.setup();
    renderStep();

    await openBrowse(user);
    await user.type(screen.getByPlaceholderText(/search products/i), 'zzz-no-match');

    expect(screen.getByText(/no products match/i)).toBeInTheDocument();
  });

  it('selecting a product writes productIds and surfaces a removable pill', async () => {
    const user = userEvent.setup();
    renderStep();

    await openBrowse(user);
    await user.click(screen.getByRole('button', { name: 'CPQ' }));

    // Selection is reflected in the selected band (driven by the RHF productIds field).
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove cpq/i })).toBeInTheDocument();
  });

  it('removes a selected product when its pill remove button is clicked', async () => {
    const user = userEvent.setup();
    renderStep();

    await openBrowse(user);
    await user.click(screen.getByRole('button', { name: 'CPQ' }));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /remove cpq/i }));
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
  });

  it('clears all selected products via Clear all', async () => {
    const user = userEvent.setup();
    renderStep();

    await openBrowse(user);
    await user.click(screen.getByRole('button', { name: 'CPQ' }));
    await user.click(screen.getByRole('button', { name: 'Lead Mgmt' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /clear all/i }));
    // The whole selected band (which owns "Clear all") unmounts once empty.
    expect(screen.queryByRole('button', { name: /clear all/i })).not.toBeInTheDocument();
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
  });
});
