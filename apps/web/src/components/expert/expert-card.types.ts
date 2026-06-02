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
  rate: number | null; // dollars/min; now nullable (was number)
  nextAvailableAt: string | null; // ISO 8601 | null — replaces `available: boolean`
  languages: ExpertCardLanguage[];
  agency: ExpertCardAgency | null;
  distinctions: ExpertCardDistinctions;
  rating: number | null; // kept; ALWAYS null in v1 — short-circuits all rating UI
  reviewCount: number; // kept; gates rating UI
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
