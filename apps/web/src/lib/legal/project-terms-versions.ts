import versionsJson from './project-terms-versions.json';

/**
 * One published version of the Projects MSA. `sha256` is `projectTermsFingerprint()` at publish
 * time. The list is append-only: a listed entry and its PDF are never edited.
 */
export interface ProjectTermsVersionEntry {
  version: string;
  sha256: string;
}

/**
 * Every published version, oldest first. Written only by `pnpm --filter web legal:publish`.
 * Kept free of the agreement text (`project-terms.ts`) and of `node:*`, so client bundles can
 * import it.
 */
export const PROJECT_TERMS_VERSIONS: readonly ProjectTermsVersionEntry[] = versionsJson;

/** The public page that renders the current text. */
export const PROJECT_TERMS_PAGE_PATH = '/legal/project-terms';

/** File name of a version's frozen PDF under `public/legal/`. */
export function projectTermsPdfFileName(version: string): string {
  return `balo-projects-msa-${version}.pdf`;
}

/** Public path of a version's PDF, or null when that version is not a listed one. */
export function projectTermsPdfHref(version: string): string | null {
  return PROJECT_TERMS_VERSIONS.some((entry) => entry.version === version)
    ? `/legal/${projectTermsPdfFileName(version)}`
    : null;
}
