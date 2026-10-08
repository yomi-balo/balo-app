import { describe, it, expect, vi } from 'vitest';
import { axe } from 'jest-axe';
import { render } from '@/test/utils';
import { ApplicationEditForm } from './application-edit-form';
import type { StaffEditModel, StaffEditReference } from '../../_lib/staff-edit-model';

/**
 * BAL-593 §[F] — follows the established `jest-axe` pattern
 * (`admin/lookup/_components/lookup-drill-in.a11y.test.tsx`): the matcher is already registered
 * globally in `apps/web/src/test/setup.ts`.
 */

const MODEL: StaffEditModel = {
  experience: {
    yearStartedSalesforce: 2018,
    projectCountMin: 10,
    projectLeadCountMin: 1,
    isSalesforceMvp: true,
    isSalesforceCta: false,
    isCertifiedTrainer: false,
  },
  languages: [{ languageId: 'en', proficiency: 'native' }],
  industryIds: ['technology'],
  products: ['sales-cloud'],
  ratings: {
    'sales-cloud': {
      'st-fix': { balo: 7, self: 8 },
      'st-arch': { balo: 5, self: 5 },
    },
  },
  certificationIds: ['admin'],
};

const REFERENCE: StaffEditReference = {
  productsByCategory: [
    {
      category: { id: 'cat1', name: 'Sales Cloud', slug: 'sales-cloud-cat', sortOrder: 0 },
      products: [{ id: 'sales-cloud', name: 'Sales Cloud', slug: 'sales-cloud', sortOrder: 0 }],
    },
  ],
  supportTypes: [
    {
      id: 'st-fix',
      name: 'Technical Fix',
      slug: 'technical-fix',
    } as StaffEditReference['supportTypes'][number],
    {
      id: 'st-arch',
      name: 'Architecture',
      slug: 'architecture',
    } as StaffEditReference['supportTypes'][number],
  ],
  certificationsByCategory: [
    {
      category: { id: 'cert-cat1', name: 'Core', slug: 'core', sortOrder: 0 },
      certifications: [{ id: 'admin', name: 'Administrator', slug: 'admin' }],
    },
  ],
  languages: [
    {
      id: 'en',
      name: 'English',
      code: 'en',
      flagEmoji: '🇬🇧',
    } as StaffEditReference['languages'][number],
  ],
  industries: [
    {
      id: 'technology',
      name: 'Technology',
      slug: 'technology',
    } as StaffEditReference['industries'][number],
  ],
};

describe('ApplicationEditForm — accessibility', () => {
  it('has no violations with a populated draft', async () => {
    const { container } = render(
      <ApplicationEditForm
        initial={MODEL}
        draft={MODEL}
        onChange={vi.fn()}
        reference={REFERENCE}
        disabled={false}
        experienceError={null}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with the experience error shown', async () => {
    const { container } = render(
      <ApplicationEditForm
        initial={MODEL}
        draft={MODEL}
        onChange={vi.fn()}
        reference={REFERENCE}
        disabled={false}
        experienceError="Projects led can't be more than total projects."
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations with an empty draft (every empty-state branch)', async () => {
    const empty: StaffEditModel = {
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
      products: [],
      ratings: {},
      certificationIds: [],
    };
    const { container } = render(
      <ApplicationEditForm
        initial={empty}
        draft={empty}
        onChange={vi.fn()}
        reference={REFERENCE}
        disabled={false}
        experienceError={null}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no violations when disabled', async () => {
    const { container } = render(
      <ApplicationEditForm
        initial={MODEL}
        draft={MODEL}
        onChange={vi.fn()}
        reference={REFERENCE}
        disabled
        experienceError={null}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
