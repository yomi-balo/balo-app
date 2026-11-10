import type {
  ReviewCaptureDefaults,
  ReviewCaptureIdentity,
  ReviewCaptureSeeds,
} from '@balo/shared/reviews';

/**
 * The one `ReviewCaptureSeeds` fixture — a first-time reviewer, Sam K. of Northwind Logistics,
 * on a project, with the company name allowed on reviews and no industry. Every test that needs
 * `rating.capture` builds it here and overrides only what it asserts on.
 */
export function buildReviewCaptureSeeds(overrides?: {
  identity?: Partial<ReviewCaptureIdentity>;
  defaults?: Partial<ReviewCaptureDefaults>;
}): ReviewCaptureSeeds {
  return {
    identity: {
      engagementKind: 'project',
      reviewerFirstName: 'Sam',
      reviewerLastInitial: 'K',
      companyName: 'Northwind Logistics',
      companyNameAllowed: true,
      industryName: null,
      ...overrides?.identity,
    },
    defaults: {
      role: '',
      showCompany: true,
      bodyVisibility: 'public',
      ...overrides?.defaults,
    },
  };
}
