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

import { StepProducts } from './step-products';
import { ExpertApplicationProvider } from './expert-application-context';

// ── Fixtures ─────────────────────────────────────────────────────

// Two categories, each with a `products` array — drives the filtering useMemo
// (lines ~59,61), the product-name map loop (line ~68), and the per-category
// ChipPicker render (line ~191).
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

// ── Tests ────────────────────────────────────────────────────────

describe('StepProducts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders every category and its products from reference data', () => {
    renderStep();
    expect(screen.getByText('Sales Cloud')).toBeInTheDocument();
    expect(screen.getByText('Service Cloud')).toBeInTheDocument();
    expect(screen.getByText('CPQ')).toBeInTheDocument();
    expect(screen.getByText('Lead Mgmt')).toBeInTheDocument();
    expect(screen.getByText('Case Mgmt')).toBeInTheDocument();
  });

  it('filters products by the search query (exercises the filtering useMemo)', async () => {
    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByPlaceholderText(/search products/i), 'cpq');

    expect(screen.getByText('CPQ')).toBeInTheDocument();
    // A product that does not match the query is filtered out.
    expect(screen.queryByText('Lead Mgmt')).not.toBeInTheDocument();
    // A whole category with no matching products is dropped.
    expect(screen.queryByText('Service Cloud')).not.toBeInTheDocument();
  });

  it('shows the empty state when no product matches the query', async () => {
    const user = userEvent.setup();
    renderStep();

    await user.type(screen.getByPlaceholderText(/search products/i), 'zzz-no-match');
    expect(screen.getByText(/no products match your search/i)).toBeInTheDocument();
  });

  it('selects a product and surfaces it as a removable pill using the skill-name map', async () => {
    const user = userEvent.setup();
    renderStep();

    // Click the CPQ chip to select it.
    await user.click(screen.getByText('CPQ'));

    // The productNameMap (line ~68) resolves the id → "CPQ" for the pill label.
    expect(screen.getByText(/1 product selected/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove cpq/i })).toBeInTheDocument();
  });

  it('removes a selected product when its pill remove button is clicked', async () => {
    const user = userEvent.setup();
    renderStep();

    await user.click(screen.getByText('CPQ'));
    expect(screen.getByText(/1 product selected/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /remove cpq/i }));
    expect(screen.queryByText(/1 product selected/i)).not.toBeInTheDocument();
  });
});
