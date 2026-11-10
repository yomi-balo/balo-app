// Balo-staff company-detail edits (industry, name on public reviews). Server-only and
// staff-only — the outcome is decided in the write transaction. Fired by apps/web AFTER
// the tx commits, and only when the value actually changed. No company id or name goes in
// the properties; `distinct_id` is the acting staff user, required by `trackServer`.
export const ADMIN_COMPANY_SERVER_EVENTS = {
  INDUSTRY_SET: 'admin_company_industry_set',
  REVIEW_NAME_TOGGLED: 'admin_company_review_name_toggled',
} as const;

export interface AdminCompanyServerEventMap {
  [ADMIN_COMPANY_SERVER_EVENTS.INDUSTRY_SET]: {
    cleared: boolean;
    distinct_id: string;
  };
  [ADMIN_COMPANY_SERVER_EVENTS.REVIEW_NAME_TOGGLED]: {
    hidden: boolean;
    distinct_id: string;
  };
}
