export type SkillType = 'technical' | 'architecture' | 'admin' | 'strategy';

export interface ExpertiseItem {
  product: string;
  skills: SkillType[];
}

export interface ExpertCardLanguage {
  name: string;
  flagEmoji: string | null;
}

export interface ExpertCardAgency {
  name: string;
  logoUrl: string | null;
}

export interface ExpertCardDistinctions {
  isSalesforceMvp: boolean;
  isSalesforceCta: boolean;
  isCertifiedTrainer: boolean;
}

/**
 * Web-local mirror of apps/api/src/routes/experts/types.ts → ExpertSearchResult,
 * plus `initials` (derived web-side) and `expertise` (NOT in the DTO — sourced
 * separately). Do NOT import from apps/api (cross-app import is forbidden).
 */
export interface ExpertCardData {
  id: string;
  username: string | null;
  name: string;
  initials: string; // derived web-side from name; DTO has no initials
  avatarUrl: string | null; // was avatarKey — R2 key OR http URL; getAvatarUrl() handles both
  headline: string | null; // was title
  bio: string | null;
  countryCode: string | null; // replaces `location: string`
  /**
   * CLIENT ALL-IN rate per minute, in dollars, **Balo service fee INCLUDED** — computed at
   * `DEFAULT_BALO_FEE_BPS` by `publicDisplayRatePerMinute` (`@balo/shared/pricing`) at the
   * public serializer, NOT a bare `rate_cents / 100` (BAL-493 / D1: that published a rate
   * lower than the client is charged).
   *
   * ⚠ A **"FROM" FIGURE.** The fee is session/engagement grain — there is no per-expert fee
   * column — so a session opened at a non-default fee charges differently. Render it as
   * "From A$…/min", never as an exact promise.
   *
   * `null` when no rate is set (nullable since BAL-247; was `number`); `0` stays `0`.
   */
  rate: number | null;
  nextAvailableAt: string | null; // ISO 8601 | null — replaces `available: boolean`
  languages: ExpertCardLanguage[];
  agency: ExpertCardAgency | null;
  distinctions: ExpertCardDistinctions;
  rating: number | null; // BAL-422; null ⇒ NO REVIEWS (never 0.0) — RatingBadge renders nothing
  ratingCount: number; // BAL-422; ENGAGEMENTS reviewed, not rows. Always shown WITH `rating`
  yearsExperience: number | null; // was yearsExp
  consultationCount: number;
  expertise: ExpertiseItem[]; // web-only; NOT in DTO
}

export interface ExpertCardProps {
  expert: ExpertCardData;
  orderBy?: string[];
  variant?: 'grid' | 'list';
  onBook?: () => void;
  onViewProfile?: () => void;
}
