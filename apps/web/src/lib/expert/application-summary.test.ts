import { describe, it, expect } from 'vitest';
import type { ApplicationWithRelations } from '@balo/db';
import type { ReferenceData } from '@/lib/expert-apply/reference-data';
import {
  productHasRating,
  summaryFromApplication,
  summaryFromDraft,
  type SummaryDraft,
} from './application-summary';

const ST_FIX = { id: 'st-fix', name: 'Technical Fix', slug: 'technical-fix' };
const ST_ARCH = { id: 'st-arch', name: 'Architecture', slug: 'architecture' };

const ref = {
  productsByCategory: [
    {
      category: { id: 'c1', name: 'Sales', slug: 'sales', sortOrder: 0 },
      products: [
        { id: 'p-cpq', name: 'CPQ', slug: 'cpq', sortOrder: 0 },
        { id: 'p-leads', name: 'Lead Mgmt', slug: 'lead-mgmt', sortOrder: 1 },
      ],
    },
  ],
  supportTypes: [ST_FIX, ST_ARCH],
  certificationsByCategory: [
    {
      category: { id: 'cc1', name: 'Administrator', slug: 'administrator', sortOrder: 0 },
      certifications: [{ id: 'cert-admin', name: 'Certified Administrator', slug: 'admin' }],
    },
  ],
  languages: [{ id: 'lang-en', name: 'English', code: 'en', flagEmoji: '🇬🇧' }],
  industries: [{ id: 'ind-fin', name: 'Financial Services', slug: 'fin' }],
} as unknown as ReferenceData;

describe('productHasRating', () => {
  const ratings = [
    { productId: 'a', proficiency: 0 },
    { productId: 'b', proficiency: 3 },
  ];

  it('is true when any dimension of the product is above zero', () => {
    expect(productHasRating(ratings, 'b')).toBe(true);
  });

  it('is false when the product only has zero ratings or none at all', () => {
    expect(productHasRating(ratings, 'a')).toBe(false);
    expect(productHasRating(ratings, 'missing')).toBe(false);
  });
});

describe('summaryFromDraft', () => {
  const draft: SummaryDraft = {
    profile: {
      yearStartedSalesforce: 2018,
      projectCountMin: 10,
      projectLeadCountMin: 1,
      linkedinSlug: 'jane-doe',
      isSalesforceMvp: true,
      isSalesforceCta: true,
      languages: [
        { languageId: 'lang-en', proficiency: 'native' },
        { languageId: 'lang-unknown', proficiency: 'beginner' },
      ],
      industryIds: ['ind-fin', 'ind-unknown'],
    },
    products: { productIds: ['p-leads', 'p-cpq', 'p-gone'] },
    assessment: {
      ratings: [
        { productId: 'p-cpq', supportTypeId: 'st-fix', proficiency: 8 },
        { productId: 'p-leads', supportTypeId: 'st-fix', proficiency: 0 },
      ],
    },
    certifications: {
      trailheadSlug: 'jane-trail',
      certifications: [{ certificationId: 'cert-admin' }, { certificationId: 'cert-other' }],
    },
    workHistory: {
      entries: [
        {
          role: 'Lead Consultant',
          company: 'Acme',
          startedAt: '2019-03-01',
          isCurrent: true,
          responsibilities: 'Led delivery.',
        },
      ],
    },
  };

  it('hydrates names and categories from reference data, ordering products by productIds', () => {
    const view = summaryFromDraft(draft, ref);

    expect(view.products.map((p) => p.name)).toEqual(['Lead Mgmt', 'CPQ', 'p-gone']);
    expect(view.certifications).toEqual([
      { id: 'cert-admin', name: 'Certified Administrator', category: 'Administrator' },
      { id: 'cert-other', name: 'cert-other', category: null },
    ]);
  });

  it('gives every product one rating per support type, defaulting to 0', () => {
    const cpq = summaryFromDraft(draft, ref).products.find((p) => p.id === 'p-cpq');

    expect(cpq?.ratings).toEqual([
      { supportTypeId: 'st-fix', slug: 'technical-fix', name: 'Technical Fix', proficiency: 8 },
      { supportTypeId: 'st-arch', slug: 'architecture', name: 'Architecture', proficiency: 0 },
    ]);
  });

  it('flags a product with only zero or no ratings as not rated', () => {
    const rated = Object.fromEntries(
      summaryFromDraft(draft, ref).products.map((p) => [p.id, p.rated])
    );

    expect(rated).toEqual({ 'p-cpq': true, 'p-leads': false, 'p-gone': false });
  });

  it('drops unknown language and industry ids', () => {
    const view = summaryFromDraft(draft, ref);

    expect(view.languages).toEqual([
      { id: 'lang-en', name: 'English', flagEmoji: '🇬🇧', proficiency: 'native' },
    ]);
    expect(view.industries).toEqual([{ id: 'ind-fin', name: 'Financial Services' }]);
  });

  it('builds the LinkedIn and Trailhead urls from the slugs, and null when absent', () => {
    const view = summaryFromDraft(draft, ref);
    const empty = summaryFromDraft(
      {
        ...draft,
        profile: { ...draft.profile, linkedinSlug: '' },
        certifications: {},
      },
      ref
    );

    expect(view.experience.linkedinUrl).toBe('https://linkedin.com/in/jane-doe');
    expect(view.trailheadUrl).toBe('https://trailblazer.me/id/jane-trail');
    expect(empty.experience.linkedinUrl).toBeNull();
    expect(empty.trailheadUrl).toBeNull();
  });

  it('lists MVP and CTA distinctions only', () => {
    expect(summaryFromDraft(draft, ref).distinctions).toEqual(['Salesforce MVP', 'Salesforce CTA']);
    expect(
      summaryFromDraft({ ...draft, profile: { isSalesforceMvp: undefined } }, ref).distinctions
    ).toEqual([]);
  });

  it('labels a current position with Present and carries the responsibilities', () => {
    const [entry] = summaryFromDraft(draft, ref).workHistory;

    expect(entry?.periodLabel).toMatch(/ — Present$/);
    expect(entry?.responsibilities).toBe('Led delivery.');
    expect(entry?.key).toBe('Lead Consultant|Acme|2019-03-01');
  });

  it('returns an empty summary for an empty draft', () => {
    const view = summaryFromDraft(
      { profile: {}, products: {}, assessment: {}, certifications: {}, workHistory: {} },
      ref
    );

    expect(view.products).toEqual([]);
    expect(view.languages).toEqual([]);
    expect(view.experience.yearStarted).toBeNull();
  });
});

describe('summaryFromApplication', () => {
  const app = {
    profile: {
      yearStartedSalesforce: 2018,
      projectCountMin: 10,
      projectLeadCountMin: 1,
      linkedinUrl: 'jane-doe',
      trailheadUrl: 'https://trailblazer.me/id/jane-trail',
      isSalesforceMvp: true,
      isSalesforceCta: false,
    },
    competencies: [
      {
        productId: 'p-cpq',
        supportTypeId: 'st-fix',
        proficiency: 8,
        product: { id: 'p-cpq', name: 'CPQ' },
        supportType: ST_FIX,
      },
      {
        productId: 'p-cpq',
        supportTypeId: 'st-arch',
        proficiency: 5,
        product: { id: 'p-cpq', name: 'CPQ' },
        supportType: ST_ARCH,
      },
      {
        productId: 'p-leads',
        supportTypeId: 'st-fix',
        proficiency: 0,
        product: { id: 'p-leads', name: 'Lead Mgmt' },
        supportType: ST_FIX,
      },
    ],
    certifications: [
      {
        certificationId: 'cert-admin',
        certification: { id: 'cert-admin', name: 'Certified Administrator' },
      },
    ],
    languages: [
      {
        proficiency: 'advanced',
        language: { id: 'lang-en', name: 'English', code: 'en', flagEmoji: null },
      },
    ],
    industries: [{ industry: { id: 'ind-fin', name: 'Financial Services', slug: 'fin' } }],
    workHistory: [
      {
        id: 'wh-1',
        role: 'Consultant',
        company: 'Acme',
        startedAt: new Date('2019-03-01T00:00:00.000Z'),
        endedAt: new Date('2021-06-01T00:00:00.000Z'),
        isCurrent: false,
        responsibilities: null,
      },
    ],
  } as unknown as ApplicationWithRelations;

  const view = summaryFromApplication(app, ref);

  it('collapses competencies into one product per id with a rating for every dimension', () => {
    expect(view.products.map((p) => [p.id, p.rated])).toEqual([
      ['p-cpq', true],
      ['p-leads', false],
    ]);
    expect(view.products[0]?.ratings.map((r) => r.proficiency)).toEqual([8, 5]);
    expect(view.products[1]?.ratings.map((r) => r.proficiency)).toEqual([0, 0]);
  });

  it('normalises stored slugs and keeps stored urls', () => {
    expect(view.experience.linkedinUrl).toBe('https://linkedin.com/in/jane-doe');
    expect(view.trailheadUrl).toBe('https://trailblazer.me/id/jane-trail');
  });

  it('drops a stored value that is not an http(s) url', () => {
    const unsafe = summaryFromApplication(
      {
        ...app,
        profile: {
          ...app.profile,
          linkedinUrl: 'javascript:alert(1)',
          trailheadUrl: 'data:text/html,x',
        },
      } as unknown as ApplicationWithRelations,
      ref
    );

    expect(unsafe.experience.linkedinUrl).toBeNull();
    expect(unsafe.trailheadUrl).toBeNull();
  });

  it('maps relations, categories and distinctions without a Trainer entry', () => {
    expect(view.distinctions).toEqual(['Salesforce MVP']);
    expect(view.certifications[0]).toEqual({
      id: 'cert-admin',
      name: 'Certified Administrator',
      category: 'Administrator',
    });
    expect(view.languages[0]).toMatchObject({ name: 'English', proficiency: 'advanced' });
    expect(view.industries).toEqual([{ id: 'ind-fin', name: 'Financial Services' }]);
  });

  it('labels a finished position with its start and end', () => {
    expect(view.workHistory[0]?.periodLabel).toBe('Mar 2019 — Jun 2021');
    expect(view.workHistory[0]?.key).toBe('wh-1');
  });
});
