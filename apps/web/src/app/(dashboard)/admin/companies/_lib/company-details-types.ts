/** One company on the staff details page, projected for the browser (ISO dates, no repository row). */
export interface CompanyDetailsDto {
  id: string;
  name: string;
  isPersonal: boolean;
  industryId: string | null;
  industryName: string | null;
  /** `null` when the company has no industry; `false` when its current industry has been retired. */
  industryIsActive: boolean | null;
  /** ISO timestamp, or `null` when the company's name may show on reviews. */
  reviewNameHiddenAt: string | null;
}

export interface IndustryOptionDto {
  id: string;
  name: string;
}

export type CompanyDetailsFailureCode =
  | 'denied'
  | 'not_found'
  | 'industry_unavailable'
  | 'personal_workspace';

export type CompanyDetailsActionResult =
  | { success: true; message: string }
  | { success: false; error: string; code?: CompanyDetailsFailureCode };
