import type { PublicExpertProfile } from '@balo/db';
import { publicDisplayRatePerMinute } from '@balo/shared/pricing';
import { parseRatingAverage } from '@balo/shared/reviews';
import { deriveInitials } from '@/lib/search/expert-card-mapper';
import type {
  AgencyView,
  CertView,
  CompetencyView,
  ExpertProfileView,
  LanguageView,
  WorkHistoryView,
} from '@/components/expert/profile/types';
import { proficiencyToLevel, proficiencyToPct } from './proficiency';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function formatMonthYear(date: Date): string {
  const month = MONTHS[date.getUTCMonth()] ?? '';
  return `${month} ${date.getUTCFullYear()}`.trim();
}

/** "Apr 2025 — Present" / "Nov 2017 — Apr 2020". */
export function formatPeriod(startedAt: Date, endedAt: Date | null, isCurrent: boolean): string {
  const start = formatMonthYear(startedAt);
  if (isCurrent || endedAt === null) return `${start} — Present`;
  return `${start} — ${formatMonthYear(endedAt)}`;
}

/**
 * "5 yrs" / "2 yrs 5 mos" / "8 mos". Rounds the span between start and
 * end (or now for an open-ended past role) to whole months.
 */
export function formatDuration(startedAt: Date, endedAt: Date | null): string {
  const end = endedAt ?? new Date();
  let totalMonths =
    (end.getUTCFullYear() - startedAt.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - startedAt.getUTCMonth());
  if (totalMonths < 0) totalMonths = 0;

  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;

  const parts: string[] = [];
  if (years > 0) parts.push(`${years} ${years === 1 ? 'yr' : 'yrs'}`);
  if (months > 0) parts.push(`${months} ${months === 1 ? 'mo' : 'mos'}`);
  if (parts.length === 0) return '< 1 mo';
  return parts.join(' ');
}

function mapCompetencies(competencies: PublicExpertProfile['competencies']): CompetencyView[] {
  // A product may appear under several support types — collapse to one bar at the
  // MAX proficiency across them.
  const maxByProductId = new Map<string, { id: string; name: string; proficiency: number }>();
  for (const row of competencies) {
    const existing = maxByProductId.get(row.product.id);
    if (!existing || row.proficiency > existing.proficiency) {
      maxByProductId.set(row.product.id, {
        id: row.product.id,
        name: row.product.name,
        proficiency: row.proficiency,
      });
    }
  }

  return [...maxByProductId.values()]
    .map(({ id, name, proficiency }) => {
      const level = proficiencyToLevel(proficiency);
      return {
        id,
        name,
        proficiency,
        level: level.label,
        tone: level.tone,
        pct: proficiencyToPct(proficiency),
      };
    })
    .sort((a, b) => b.proficiency - a.proficiency);
}

function mapAgency(profile: PublicExpertProfile): AgencyView | null {
  const { agency } = profile;
  if (profile.agencyId === null || !agency) return null;
  return {
    name: agency.name,
    slug: agency.slug,
    logoUrl: agency.logoUrl,
    initials: deriveInitials(agency.name),
  };
}

function mapWorkHistory(workHistory: PublicExpertProfile['workHistory']): WorkHistoryView[] {
  return workHistory.map((wh) => ({
    role: wh.role,
    company: wh.company,
    periodLabel: formatPeriod(wh.startedAt, wh.endedAt, wh.isCurrent),
    durationLabel: wh.isCurrent ? '' : formatDuration(wh.startedAt, wh.endedAt),
    isCurrent: wh.isCurrent,
    responsibilities: wh.responsibilities,
  }));
}

/**
 * Pure mapper: DB graph → fully serializable view-model. No env access, no
 * Date objects leak across the client boundary, never fabricates rating /
 * reviews / response-time data.
 *
 * ⚠ BAL-422 — THE RATING IS NOW REAL, AND STILL NEVER FABRICATED. `ratingAverage` is the
 * stored aggregate or `null`; `null` means NO REVIEWS and the hero omits the stat entirely
 * rather than rendering `0.0`. The parse is the point: `expert_profiles.rating_average` is
 * `numeric(2,1)`, so `findPublicProfileByUsername`'s relational `columns:` allow-list — which
 * cannot reshape — hands back the STRING `'4.3'`. `parseRatingAverage` (`@balo/shared/reviews`)
 * is the ONE parse; never `Number()` it inline.
 *
 * ⚠ `topRated` STAYS `false`. It is a separate editorial badge with no defined threshold, and
 * deriving it from `ratingAverage` here would invent a rule nobody decided.
 *
 * ⚠ BAL-493 / D1 — THIS IS A PUBLIC SERIALIZER BOUNDARY. `profile.rateCents` is the
 * UN-MARKED-UP consultant rate (pinned as such by `packages/db`'s
 * `experts.integration.test.ts`); the Balo fee is applied HERE, once, so the public profile
 * quotes the same client all-in rate as `/experts`. Never move this into the repository.
 *
 * ⚠ The fee is SESSION/ENGAGEMENT grain, not expert grain — there is no per-expert fee column
 * (`credit_sessions.balo_fee_bps` defaults to 2500; `engagements.balo_fee_bps` is NULL for
 * cases). `rate` is computed at `DEFAULT_BALO_FEE_BPS` and is a "FROM" figure; copy must read
 * "From A$…/min", never an exact promise. No margin, fee-bps or expert-earnings field may join
 * this view-model — pinned by `profile-view.test.ts`'s AC-5 boundary describe.
 */
export function mapProfileToView(profile: PublicExpertProfile): ExpertProfileView {
  const { user } = profile;
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || 'Salesforce Expert';
  const firstName = user.firstName?.trim() || 'this expert';

  const currentYear = new Date().getUTCFullYear();
  const yearsExperience =
    profile.yearStartedSalesforce == null
      ? null
      : Math.max(0, currentYear - profile.yearStartedSalesforce);

  const certifications: CertView[] = profile.certifications.map((c) => ({
    id: c.certification.id,
    name: c.certification.name,
    logoUrl: c.certification.logoUrl,
  }));

  const languages: LanguageView[] = profile.languages.map((l) => ({
    name: l.language.name,
    flagEmoji: l.language.flagEmoji,
  }));

  return {
    expertId: profile.id,
    agencyId: profile.agencyId,
    name,
    firstName,
    initials: deriveInitials(name),
    headline: profile.headline,
    bio: profile.bio,
    avatarKey: user.avatarUrl,
    countryCode: user.countryCode,
    country: user.country,
    // BAL-493 / D1 — client all-in, Balo fee included at the DEFAULT bps. See the docblock.
    rate: publicDisplayRatePerMinute(profile.rateCents),
    yearsExperience,
    consultationCount: profile.consultationCount,
    certCount: certifications.length,
    availableForWork: profile.availableForWork,
    baloVerified: true,
    // Still deferred — an editorial badge with no decided threshold. NOT derived from
    // `ratingAverage`; picking a cutoff here would invent a rule nobody agreed.
    topRated: false,
    // BAL-422 — `numeric` ⇒ a STRING off the driver, so the one shared parse.
    ratingAverage: parseRatingAverage(profile.ratingAverage),
    ratingCount: profile.ratingCount,
    competencies: mapCompetencies(profile.competencies),
    certifications,
    languages,
    languagesLabel: languages.map((l) => l.name).join(', '),
    agency: mapAgency(profile),
    workHistory: mapWorkHistory(profile.workHistory),
  };
}
