import { describe, it, expect } from 'vitest';
import {
  formatReviewAttribution,
  type ReviewAttributionInput,
  type ReviewBodyVisibility,
} from '@balo/shared/reviews';
import { buildAttributionLine } from './attribution-line';

const COMPANY_STATES = [
  { label: 'company shown', showCompany: true, companyNameAllowed: true, companyName: 'Northwind' },
  { label: 'unticked', showCompany: false, companyNameAllowed: true, companyName: 'Northwind' },
  { label: 'not allowed', showCompany: true, companyNameAllowed: false, companyName: 'Northwind' },
  { label: 'name empty', showCompany: true, companyNameAllowed: true, companyName: '' },
] as const;

/** Every combination of the formatter's fallback matrix (AC9), as AC6 needs it. */
const OPTIONAL_TEXT = (value: string): readonly [string, null] => [value, null];

const MATRIX: readonly { label: string; input: ReviewAttributionInput }[] = OPTIONAL_TEXT(
  'Sam'
).flatMap((firstName) =>
  OPTIONAL_TEXT('K').flatMap((lastInitial) =>
    OPTIONAL_TEXT('RevOps Lead').flatMap((role) =>
      COMPANY_STATES.flatMap((company) =>
        OPTIONAL_TEXT('Logistics').map((industryName) => ({
          label: [
            `first=${firstName ?? 'missing'}`,
            `initial=${lastInitial ?? 'missing'}`,
            `role=${role ?? 'missing'}`,
            company.label,
            `industry=${industryName ?? 'missing'}`,
          ].join(' · '),
          input: {
            firstName,
            lastInitial,
            role,
            companyName: company.companyName,
            industryName,
            showCompany: company.showCompany,
            companyNameAllowed: company.companyNameAllowed,
          },
        }))
      )
    )
  )
);

describe('buildAttributionLine', () => {
  it('covers the whole matrix', () => {
    expect(MATRIX).toHaveLength(2 * 2 * 2 * COMPANY_STATES.length * 2);
  });

  it.each(MATRIX)('states exactly the formatter’s name and descriptor — $label', ({ input }) => {
    const attribution = formatReviewAttribution(input);
    const { text } = buildAttributionLine({
      expertName: 'Amara',
      attribution,
      hasNote: false,
      bodyVisibility: 'public',
    });

    const asShown =
      attribution.descriptor === null
        ? attribution.name
        : `${attribution.name}, ${attribution.descriptor}`;
    expect(text).toBe(`Your rating shows on Amara’s profile as ${asShown}.`);
  });

  it.each([
    {
      hasNote: false,
      bodyVisibility: 'public',
      privateNote: false,
      text: 'Your rating shows on Amara’s profile as Sam K., RevOps Lead @Northwind.',
    },
    {
      hasNote: true,
      bodyVisibility: 'public',
      privateNote: false,
      text: 'Your rating and note show on Amara’s profile as Sam K., RevOps Lead @Northwind.',
    },
    {
      hasNote: true,
      bodyVisibility: 'private',
      privateNote: true,
      text: 'Your rating shows on Amara’s profile as Sam K., RevOps Lead @Northwind. Only the Balo team sees your note.',
    },
    {
      hasNote: false,
      bodyVisibility: 'private',
      privateNote: false,
      text: 'Your rating shows on Amara’s profile as Sam K., RevOps Lead @Northwind.',
    },
  ] satisfies readonly {
    hasNote: boolean;
    bodyVisibility: ReviewBodyVisibility;
    privateNote: boolean;
    text: string;
  }[])(
    'uses the design copy for note=$hasNote visibility=$bodyVisibility',
    ({ hasNote, bodyVisibility, privateNote, text }) => {
      const result = buildAttributionLine({
        expertName: 'Amara',
        attribution: formatReviewAttribution({
          firstName: 'Sam',
          lastInitial: 'K',
          role: 'RevOps Lead',
          companyName: 'Northwind',
          industryName: null,
          showCompany: true,
          companyNameAllowed: true,
        }),
        hasNote,
        bodyVisibility,
      });
      expect(result).toEqual({ text, privateNote });
    }
  );

  it('stands on the name alone when there is no descriptor', () => {
    const result = buildAttributionLine({
      expertName: 'Amara',
      attribution: { name: 'Verified client', descriptor: null, initials: null },
      hasNote: false,
      bodyVisibility: 'public',
    });
    expect(result.text).toBe('Your rating shows on Amara’s profile as Verified client.');
  });
});
