import type { CompanyWorkspace } from '@balo/shared/workspaces';

/**
 * Shared BAL-496 sidebar workspace fixture. `sidebar.test.tsx` and `sidebar-analytics.test.tsx`
 * both mock `./sidebar-context` wholesale and need an identical single-company workspace to seed
 * `sidebarValue.workspaces` — centralised here so neither file copies the same object literal
 * (keeps new-code duplication under the SonarCloud gate — see `availability.ts` for the
 * precedent). Lives under `src/test/fixtures/**`, classified as test code by
 * `sonar.test.inclusions` and excluded from coverage by the vitest config.
 */
export const SINGLE_COMPANY_WORKSPACE: CompanyWorkspace = {
  type: 'company',
  key: 'company:99999999-9999-4999-8999-999999999999',
  companyId: '99999999-9999-4999-8999-999999999999',
  name: 'Northwind Industrial',
  via: 'membership',
  isPersonal: false,
  role: 'owner',
};
