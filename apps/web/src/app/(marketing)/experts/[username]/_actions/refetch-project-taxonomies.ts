'use server';
import 'server-only';

import {
  loadProjectRequestTaxonomies,
  type ProjectRequestTaxonomies,
} from '@/lib/project-request/load-project-taxonomy';

/**
 * Thin Server Action backing the taxonomy picker's Retry button. The taxonomy is
 * public reference data shown on the public expert profile, so it is NOT gated —
 * gating would break unauthenticated browse. `loadProjectRequestTaxonomies`
 * already degrades to EMPTY on error and never throws.
 */
export async function refetchProjectTaxonomiesAction(): Promise<ProjectRequestTaxonomies> {
  return loadProjectRequestTaxonomies();
}
