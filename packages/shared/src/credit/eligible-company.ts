/**
 * BAL-401 — a NARROW projection of a billing company the acting member may draw a credit
 * session against (holds CONSUME_CREDITS). Deliberately excludes creditBalance / isPersonal /
 * any other company column so the api→web `company_selection_required` payload never leaks
 * company internals. Defined ONCE here (imported by the apps/api service + apps/web action &
 * transport) so the shape is not duplicated across the boundary (SonarCloud new-code
 * duplication gate, >3%).
 */
export interface EligibleCompany {
  id: string;
  name: string;
  logoUrl: string | null;
}
