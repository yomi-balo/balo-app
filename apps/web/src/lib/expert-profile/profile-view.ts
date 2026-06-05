import type { PublicExpertProfile } from '@balo/db';
import { deriveInitials } from '@/lib/search/expert-card-mapper';
import type {
  AgencyView,
  CertView,
  ExpertProfileView,
  LanguageView,
  SkillView,
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

function mapSkills(skills: PublicExpertProfile['skills']): SkillView[] {
  // A skill may appear under several support types — collapse to one bar at the
  // MAX proficiency across them.
  const maxBySkillId = new Map<string, { id: string; name: string; proficiency: number }>();
  for (const row of skills) {
    const existing = maxBySkillId.get(row.skill.id);
    if (!existing || row.proficiency > existing.proficiency) {
      maxBySkillId.set(row.skill.id, {
        id: row.skill.id,
        name: row.skill.name,
        proficiency: row.proficiency,
      });
    }
  }

  return [...maxBySkillId.values()]
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
    rate: profile.rateCents == null ? null : profile.rateCents / 100,
    yearsExperience,
    // Deferred: no confirmed-count source wired yet — 0 for everyone (consultations feature).
    consultationCount: 0,
    certCount: certifications.length,
    availableForWork: profile.availableForWork,
    baloVerified: true,
    // Deferred: derive from rating once a reviews feature lands.
    topRated: false,
    skills: mapSkills(profile.skills),
    certifications,
    languages,
    languagesLabel: languages.map((l) => l.name).join(', '),
    agency: mapAgency(profile),
    workHistory: mapWorkHistory(profile.workHistory),
  };
}
