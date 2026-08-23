/**
 * Sibling, non-`'use server'` types module for `refetch-open-cases.ts` — the same
 * `'use server'`-may-export-only-async-functions constraint `types.ts` documents applies here.
 */
export interface RefetchOpenCasesInput {
  expertProfileId: string;
  companyId: string;
}

export type RefetchOpenCasesResult =
  | {
      ok: true;
      openCases: Array<{
        engagementId: string;
        title: string;
        createdAt: string;
        lastActivityAt: string;
        consultationCount: number;
      }>;
      resolvedCaseCount: number;
    }
  | { ok: false };
