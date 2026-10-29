import type { ProfileReviewEntryView } from '@/components/expert/profile/types';

/** Entries shown before "Show N more reviews". */
export const INITIAL_VISIBLE = 3;

export type ReviewsFilter = 'all' | 'project' | 'case';

export type ReviewBucket = 1 | 2 | 3 | 4 | 5;

/** Star buckets, highest first, as the distribution renders them. */
export const REVIEW_BUCKETS: readonly ReviewBucket[] = [5, 4, 3, 2, 1];

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function kindCounts(entries: readonly ProfileReviewEntryView[]): {
  projects: number;
  consultations: number;
} {
  const projects = entries.filter((entry) => entry.engagementKind === 'project').length;
  return { projects, consultations: entries.length - projects };
}

/** "1 project", "2 projects and 1 consultation". Empty when there are no entries. */
export function kindPhrase(entries: readonly ProfileReviewEntryView[]): string {
  const { projects, consultations } = kindCounts(entries);
  const parts: string[] = [];
  if (projects > 0) parts.push(plural(projects, 'project', 'projects'));
  if (consultations > 0) parts.push(plural(consultations, 'consultation', 'consultations'));
  return parts.join(' and ');
}

/** Engagements per star bucket; each engagement lands in `Math.round(rating)`. */
export function distribution(
  entries: readonly ProfileReviewEntryView[]
): Record<ReviewBucket, number> {
  const counts: Record<ReviewBucket, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const entry of entries) {
    const bucket = Math.min(5, Math.max(1, Math.round(entry.rating))) as ReviewBucket;
    counts[bucket] += 1;
  }
  return counts;
}

export function filterEntries(
  entries: readonly ProfileReviewEntryView[],
  filter: ReviewsFilter
): ProfileReviewEntryView[] {
  if (filter === 'all') return [...entries];
  return entries.filter((entry) => entry.engagementKind === filter);
}

export function showMoreLabel(remaining: number): string {
  return `Show ${remaining} more ${remaining === 1 ? 'review' : 'reviews'}`;
}

export function engagementsLabel(count: number): string {
  return plural(count, 'engagement', 'engagements');
}
