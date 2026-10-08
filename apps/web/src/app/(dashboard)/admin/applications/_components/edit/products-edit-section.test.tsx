import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import type { SupportType } from '@balo/db';
import { ProductsEditSection } from './products-edit-section';
import type { StaffEditModel } from '../../_lib/staff-edit-model';

const SUPPORT_TYPES = [
  { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' },
  { id: 'st-arch', name: 'Architecture', slug: 'architecture' },
] as unknown as SupportType[];

const PRODUCTS_BY_CATEGORY = [
  {
    category: { id: 'cat1', name: 'Sales Cloud', slug: 'sales-cloud-cat', sortOrder: 0 },
    products: [{ id: 'sales-cloud', name: 'Sales Cloud', slug: 'sales-cloud', sortOrder: 0 }],
  },
  {
    category: { id: 'cat2', name: 'Platform', slug: 'platform-cat', sortOrder: 1 },
    products: [{ id: 'flow', name: 'Flow', slug: 'flow', sortOrder: 0 }],
  },
];

function model(overrides: Partial<StaffEditModel> = {}): StaffEditModel {
  return {
    experience: {
      yearStartedSalesforce: null,
      projectCountMin: null,
      projectLeadCountMin: null,
      isSalesforceMvp: false,
      isSalesforceCta: false,
      isCertifiedTrainer: false,
    },
    languages: [],
    industryIds: [],
    products: ['sales-cloud'],
    ratings: {
      'sales-cloud': {
        'st-fix': { balo: 7, self: 8 },
        'st-arch': { balo: 5, self: 5 },
      },
    },
    certificationIds: [],
    ...overrides,
  };
}

describe('ProductsEditSection', () => {
  it('strikes a removed product and shows Undo plus the removal info note', async () => {
    const user = userEvent.setup();
    const initial = model();
    let draft = model();
    const handleChange = vi.fn((next: StaffEditModel) => {
      draft = next;
    });

    const { rerender } = render(
      <ProductsEditSection
        draft={draft}
        initial={initial}
        update={(fn) => handleChange(fn(draft))}
        productsByCategory={PRODUCTS_BY_CATEGORY}
        supportTypes={SUPPORT_TYPES}
        disabled={false}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Remove Sales Cloud' }));
    expect(draft.products).toEqual([]);

    rerender(
      <ProductsEditSection
        draft={draft}
        initial={initial}
        update={(fn) => handleChange(fn(draft))}
        productsByCategory={PRODUCTS_BY_CATEGORY}
        supportTypes={SUPPORT_TYPES}
        disabled={false}
      />
    );

    expect(
      screen
        .getByRole('button', { name: 'Undo removing Sales Cloud' })
        .closest('span')
        ?.querySelector('s')
    ).toHaveTextContent('Sales Cloud');
    expect(screen.getByText(/Removing a product deletes its ratings/)).toBeInTheDocument();
  });

  it('marks a product added from the picker as New', async () => {
    const user = userEvent.setup();
    const initial = model();
    let draft = model();
    const handleChange = vi.fn((next: StaffEditModel) => {
      draft = next;
    });

    const { rerender } = render(
      <ProductsEditSection
        draft={draft}
        initial={initial}
        update={(fn) => handleChange(fn(draft))}
        productsByCategory={PRODUCTS_BY_CATEGORY}
        supportTypes={SUPPORT_TYPES}
        disabled={false}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Add product' }));
    await user.click(await screen.findByText('Flow'));

    expect(draft.products).toContain('flow');
    expect(draft.ratings.flow).toEqual({
      'st-fix': { self: null, balo: 0 },
      'st-arch': { self: null, balo: 0 },
    });

    rerender(
      <ProductsEditSection
        draft={draft}
        initial={initial}
        update={(fn) => handleChange(fn(draft))}
        productsByCategory={PRODUCTS_BY_CATEGORY}
        supportTypes={SUPPORT_TYPES}
        disabled={false}
      />
    );

    expect(screen.getByText('New')).toBeInTheDocument();
  });
});
