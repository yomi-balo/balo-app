import type { ProjectTermsVersionEntry } from '../project-terms-versions';

export type PublishPlan =
  | { kind: 'up_to_date' }
  | { kind: 'append'; entry: ProjectTermsVersionEntry }
  | { kind: 'refuse'; reason: string };

/**
 * What `legal:publish` does with the current agreement. A listed version is frozen: the same hash
 * is a no-op and a different hash is refused. An unlisted version is appended only when it is
 * later than the last listed one, so the list stays ascending.
 */
export function planProjectTermsPublish(
  current: ProjectTermsVersionEntry,
  listed: readonly ProjectTermsVersionEntry[]
): PublishPlan {
  const existing = listed.find((entry) => entry.version === current.version);
  if (existing) {
    return existing.sha256 === current.sha256
      ? { kind: 'up_to_date' }
      : {
          kind: 'refuse',
          reason: `Version ${current.version} is already published and an edit changed the text: set a new PROJECT_TERMS_VERSION. A listed entry and its PDF are never rewritten.`,
        };
  }
  const last = listed.at(-1);
  if (last && current.version <= last.version) {
    return {
      kind: 'refuse',
      reason: `Version ${current.version} is not later than the last published version ${last.version}: set PROJECT_TERMS_VERSION to a later date.`,
    };
  }
  return { kind: 'append', entry: current };
}
