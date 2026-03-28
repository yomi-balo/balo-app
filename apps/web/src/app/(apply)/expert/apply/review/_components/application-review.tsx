'use client';

import {
  Briefcase,
  Award,
  Check,
  Globe,
  Building2,
  Compass,
  GraduationCap,
  Sparkles,
  Wrench,
  ExternalLink,
  Clock,
  ArrowLeft,
  Linkedin,
  ClipboardList,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { motion } from 'motion/react';
import Link from 'next/link';
import type {
  ApplicationWithRelations,
  SkillsByCategory,
  CertificationsByCategory,
} from '@balo/db';
import type { SupportType } from '@balo/db';

// ── Design Tokens (matching design reference) ──────────────────

const colors = {
  bg: '#F8FAFB',
  surface: '#FFFFFF',
  surfaceSubtle: '#F1F4F8',
  border: '#E0E4EB',
  borderSubtle: '#EAEFF5',
  text: '#111827',
  textSecondary: '#4B5563',
  textTertiary: '#9CA3AF',
  primary: '#2563EB',
  primaryLight: '#EFF6FF',
  primaryBorder: '#BFDBFE',
  primaryGlow: 'rgba(37,99,235,0.12)',
  accent: '#7C3AED',
  accentLight: '#F5F3FF',
  accentBorder: '#DDD6FE',
  success: '#059669',
  successLight: '#ECFDF5',
  successBorder: '#A7F3D0',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  warningBorder: '#FDE68A',
  cyan: '#0891B2',
  cyanLight: '#ECFEFF',
  cyanBorder: '#A5F3FC',
  amber: '#D97706',
  amberLight: '#FFFBEB',
  amberBorder: '#FDE68A',
  emerald: '#059669',
  emeraldLight: '#ECFDF5',
  emeraldBorder: '#A7F3D0',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientSubtle: 'linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%)',
};

const SECTION_COLORS: Record<string, { text: string; bg: string }> = {
  primary: { text: '#2563EB', bg: 'rgba(37,99,235,0.1)' },
  violet: { text: '#7C3AED', bg: 'rgba(124,58,237,0.1)' },
  cyan: { text: '#0891B2', bg: 'rgba(8,145,178,0.1)' },
  amber: { text: '#D97706', bg: 'rgba(217,119,6,0.1)' },
  emerald: { text: '#059669', bg: 'rgba(5,150,105,0.1)' },
  pink: { text: '#DB2777', bg: 'rgba(219,39,119,0.1)' },
  indigo: { text: '#4F46E5', bg: 'rgba(79,70,229,0.1)' },
};

const PROJECT_RANGE_MAP: Record<number, string> = {
  0: 'None',
  1: '1–9',
  10: '10–25',
  26: '26–50',
  50: '50+',
};

const SUPPORT_TYPE_CONFIG: Record<string, { icon: LucideIcon; color: string }> = {
  'technical-fix': { icon: Wrench, color: '#2563EB' },
  architecture: { icon: Building2, color: '#7C3AED' },
  strategy: { icon: Compass, color: '#0891B2' },
  training: { icon: GraduationCap, color: '#059669' },
};

const PROFICIENCY_BADGE_STYLES: Record<string, { bg: string; border: string; color: string }> = {
  native: { bg: colors.successLight, border: colors.successBorder, color: colors.success },
  advanced: { bg: colors.primaryLight, border: colors.primaryBorder, color: colors.primary },
  intermediate: { bg: colors.warningLight, border: colors.warningBorder, color: colors.warning },
  beginner: { bg: colors.surfaceSubtle, border: colors.border, color: colors.textSecondary },
};

// ── Animation helpers ──────────────────────────────────────────

const slideUp = {
  initial: { y: 16, opacity: 0 },
  animate: { y: 0, opacity: 1 },
};

function staggerDelay(
  i: number,
  base = 0.06
): { transition: { delay: number; duration: number; ease: 'easeOut' } } {
  return { transition: { delay: i * base, duration: 0.4, ease: 'easeOut' as const } };
}

// ── Shared Components ──────────────────────────────────────────

function SectionLabel({
  children,
  icon: Icon,
  colorKey = 'primary',
}: Readonly<{
  children: React.ReactNode;
  icon: LucideIcon;
  colorKey?: string;
}>): React.JSX.Element {
  const sc = SECTION_COLORS[colorKey] ?? { text: '#2563EB', bg: 'rgba(37,99,235,0.1)' };
  return (
    <div className="mb-4 flex items-center gap-2">
      <div
        className="flex h-[26px] w-[26px] items-center justify-center rounded-[7px]"
        style={{ backgroundColor: sc.bg }}
      >
        <Icon className="h-3.5 w-3.5" style={{ color: sc.text }} aria-hidden="true" />
      </div>
      <p
        className="text-[11px] font-semibold tracking-[0.08em] uppercase"
        style={{ color: sc.text }}
      >
        {children}
      </p>
    </div>
  );
}

function DataRow({
  label,
  value,
  icon: IconComp,
}: Readonly<{
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
}>): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="flex items-center gap-2 text-[13px]" style={{ color: colors.textSecondary }}>
        {IconComp && (
          <IconComp
            className="h-3.5 w-3.5"
            style={{ color: colors.textTertiary }}
            aria-hidden="true"
          />
        )}
        {label}
      </span>
      <span className="text-sm font-medium" style={{ color: colors.text }}>
        {value}
      </span>
    </div>
  );
}

function Card({
  children,
  className: extraClassName,
  style: extraStyle,
  hover,
}: Readonly<{
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  hover?: boolean;
}>): React.JSX.Element {
  return (
    <div
      className={`rounded-[14px] border transition-all duration-200 ${hover ? 'hover:border-[#BFDBFE] hover:shadow-[0_4px_16px_rgba(37,99,235,0.12)]' : ''} ${extraClassName ?? ''}`}
      style={{
        background: colors.surface,
        borderColor: colors.border,
        ...extraStyle,
      }}
    >
      {children}
    </div>
  );
}

function Chip({ label, color }: Readonly<{ label: string; color?: string }>): React.JSX.Element {
  return (
    <span
      className="inline-block rounded-[20px] px-3.5 py-1.5 text-[13px] font-medium"
      style={{
        background: color ? `${color}08` : colors.surfaceSubtle,
        border: `1.5px solid ${color ? `${color}30` : colors.border}`,
        color: color ?? colors.textSecondary,
      }}
    >
      {label}
    </span>
  );
}

function Badge({
  children,
  variant = 'default',
}: Readonly<{
  children: React.ReactNode;
  variant?: string;
}>): React.JSX.Element {
  const s = PROFICIENCY_BADGE_STYLES[variant] ?? {
    bg: colors.surfaceSubtle,
    border: colors.border,
    color: colors.textSecondary,
  };
  return (
    <span
      className="rounded-xl px-2.5 py-0.5 text-[11px] font-semibold capitalize"
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        color: s.color,
      }}
    >
      {children}
    </span>
  );
}

function MiniBar({
  value,
  max = 10,
  color,
}: Readonly<{ value: number; max?: number; color: string }>): React.JSX.Element {
  const pct = (value / max) * 100;
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div
        className="h-1.5 min-w-[60px] flex-1 overflow-hidden rounded-[3px]"
        style={{ background: colors.border }}
      >
        <div
          className="h-full rounded-[3px] transition-[width] duration-300 ease-out"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, ${color}90, ${color})`,
          }}
        />
      </div>
      <span
        className="min-w-[24px] text-right text-xs font-semibold"
        style={{ color: value > 0 ? color : colors.textTertiary }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Props ──────────────────────────────────────────────────────

interface ApplicationReviewProps {
  application: ApplicationWithRelations;
  email: string;
  skillsByCategory: SkillsByCategory[];
  supportTypes: SupportType[];
  certificationsByCategory: CertificationsByCategory[];
}

// ── Main Component ─────────────────────────────────────────────

export function ApplicationReview({
  application,
  email,
  skillsByCategory,
  supportTypes,
  certificationsByCategory,
}: Readonly<ApplicationReviewProps>): React.JSX.Element {
  const { profile, skills, certifications, languages, industries, workHistory } = application;

  // Build a skill-to-category map from reference data
  const skillCategoryMap = new Map<string, string>();
  for (const cat of skillsByCategory) {
    for (const skill of cat.skills) {
      skillCategoryMap.set(skill.id, cat.category.name);
    }
  }

  // Group selected skills by category for products section
  const uniqueSkillIds = [...new Set(skills.map((s) => s.skillId))];
  const productsByCategory = new Map<string, string[]>();
  for (const skillId of uniqueSkillIds) {
    const categoryName = skillCategoryMap.get(skillId) ?? 'Other';
    const skillName = skills.find((s) => s.skillId === skillId)?.skill.name ?? '';
    if (!productsByCategory.has(categoryName)) {
      productsByCategory.set(categoryName, []);
    }
    productsByCategory.get(categoryName)!.push(skillName);
  }

  // Group skills for assessment: { skillName → { supportTypeSlug → proficiency } }
  const assessmentMap = new Map<string, { name: string; ratings: Map<string, number> }>();
  for (const s of skills) {
    if (!assessmentMap.has(s.skillId)) {
      assessmentMap.set(s.skillId, { name: s.skill.name, ratings: new Map() });
    }
    assessmentMap.get(s.skillId)!.ratings.set(s.supportType.slug, s.proficiency);
  }

  // Build cert-to-category map
  const certCategoryMap = new Map<string, string>();
  for (const cat of certificationsByCategory) {
    for (const cert of cat.certifications) {
      certCategoryMap.set(cert.id, cat.category.name);
    }
  }

  // Build distinctions list
  const distinctions: string[] = [];
  if (profile.isSalesforceMvp) distinctions.push('Salesforce MVP');
  if (profile.isSalesforceCta) distinctions.push('Salesforce CTA');
  if (profile.isCertifiedTrainer) distinctions.push('Certified Trainer');

  const submittedDate = profile.submittedAt
    ? new Date(profile.submittedAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'N/A';

  const totalProducts = uniqueSkillIds.length;

  return (
    <div className="mx-auto max-w-[780px] py-8 pb-20">
      {/* Page header */}
      <motion.div {...slideUp} transition={{ duration: 0.4, ease: 'easeOut' }} className="mb-8">
        <div className="mb-2 flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-[11px]"
            style={{
              background: SECTION_COLORS['indigo']!.bg,
              border: `1px solid ${SECTION_COLORS['indigo']!.text}25`,
            }}
          >
            <ClipboardList
              className="h-5 w-5"
              style={{ color: SECTION_COLORS['indigo']!.text }}
              aria-hidden="true"
            />
          </div>
          <h1 className="text-[26px] font-bold tracking-tight" style={{ color: colors.text }}>
            Your Application
          </h1>
        </div>
        <p className="ml-[52px] text-sm leading-relaxed" style={{ color: colors.textSecondary }}>
          Here&apos;s a summary of your expert application. You&apos;ll be notified once it&apos;s
          reviewed.
        </p>
      </motion.div>

      {/* Status Banner */}
      <motion.div
        {...slideUp}
        transition={{ duration: 0.4, ease: 'easeOut', delay: 0.06 }}
        className="mb-9"
      >
        <div
          className="flex items-center gap-3.5 rounded-[14px] px-6 py-4"
          style={{
            background: `linear-gradient(135deg, ${colors.primaryLight}, ${colors.accentLight})`,
            border: `1px solid ${colors.primaryBorder}80`,
          }}
        >
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]"
            style={{
              background: colors.gradient,
              boxShadow: `0 2px 8px ${colors.primaryGlow}`,
            }}
          >
            <Clock className="h-5 w-5 text-white" aria-hidden="true" />
          </div>
          <div>
            <p className="text-sm font-semibold" style={{ color: colors.text }}>
              Application under review
            </p>
            <p
              className="mt-0.5 text-[13px] leading-relaxed"
              style={{ color: colors.textSecondary }}
            >
              Submitted on {submittedDate}. We&apos;ll email you at{' '}
              <strong style={{ color: colors.text }}>{email}</strong> within 2–3 business days.
            </p>
          </div>
        </div>
      </motion.div>

      {/* Sections */}
      <div className="flex flex-col gap-9">
        {/* Profile */}
        <motion.div {...slideUp} {...staggerDelay(2)}>
          <SectionLabel icon={Briefcase} colorKey="primary">
            Experience
          </SectionLabel>
          <Card className="px-6 py-5">
            <div className="grid grid-cols-1 gap-x-8 gap-y-0.5 sm:grid-cols-2">
              <DataRow label="Year started" value={profile.yearStartedSalesforce ?? '—'} />
              <DataRow
                label="Projects involved in"
                value={PROJECT_RANGE_MAP[profile.projectCountMin ?? 0] ?? '—'}
              />
              <DataRow
                label="Projects as Lead"
                value={PROJECT_RANGE_MAP[profile.projectLeadCountMin ?? 0] ?? '—'}
              />
            </div>
            {profile.linkedinUrl && (
              <div className="mt-2 pt-3" style={{ borderTop: `1px solid ${colors.borderSubtle}` }}>
                <DataRow
                  label="LinkedIn"
                  icon={Linkedin}
                  value={
                    <a
                      href={
                        profile.linkedinUrl.startsWith('http')
                          ? profile.linkedinUrl
                          : `https://linkedin.com/in/${profile.linkedinUrl}`
                      }
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 font-medium"
                      style={{ color: colors.primary }}
                    >
                      {profile.linkedinUrl.startsWith('http')
                        ? profile.linkedinUrl.replace(/^https?:\/\/(www\.)?/, '').split('?')[0]
                        : `linkedin.com/in/${profile.linkedinUrl}`}
                      <ExternalLink
                        className="h-3 w-3"
                        style={{ color: colors.primary }}
                        aria-hidden="true"
                      />
                    </a>
                  }
                />
              </div>
            )}
          </Card>
        </motion.div>

        {/* Languages */}
        {languages.length > 0 && (
          <motion.div {...slideUp} {...staggerDelay(3)}>
            <SectionLabel icon={Globe} colorKey="cyan">
              Languages
            </SectionLabel>
            <Card className="overflow-hidden">
              {languages.map((lang, i) => (
                <div
                  key={lang.id}
                  className="flex items-center gap-3 px-5 py-3.5"
                  style={{
                    borderBottom:
                      i < languages.length - 1 ? `1px solid ${colors.borderSubtle}` : 'none',
                  }}
                >
                  <span className="w-7 text-xl">{lang.language.flagEmoji ?? '🌐'}</span>
                  <span className="flex-1 text-sm font-medium" style={{ color: colors.text }}>
                    {lang.language.name}
                  </span>
                  <Badge variant={lang.proficiency}>{lang.proficiency}</Badge>
                </div>
              ))}
            </Card>
          </motion.div>
        )}

        {/* Industries & Distinctions */}
        <motion.div {...slideUp} {...staggerDelay(4)}>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {/* Industries */}
            <div>
              <SectionLabel icon={Building2} colorKey="emerald">
                Industries
              </SectionLabel>
              <div className="flex flex-wrap gap-2">
                {industries.map((ind) => (
                  <Chip key={ind.id} label={ind.industry.name} color={colors.emerald} />
                ))}
                {industries.length === 0 && (
                  <p className="text-[13px]" style={{ color: colors.textTertiary }}>
                    None selected
                  </p>
                )}
              </div>
            </div>
            {/* Distinctions */}
            <div>
              <SectionLabel icon={Award} colorKey="amber">
                Distinctions
              </SectionLabel>
              {distinctions.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {distinctions.map((d) => (
                    <span
                      key={d}
                      className="inline-flex items-center gap-2 rounded-[10px] px-4 py-2 text-[13px] font-semibold"
                      style={{
                        background: colors.amberLight,
                        border: `1px solid ${colors.amberBorder}`,
                        color: colors.amber,
                      }}
                    >
                      <Award
                        className="h-3.5 w-3.5"
                        style={{ color: colors.amber }}
                        aria-hidden="true"
                      />
                      {d}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-[13px]" style={{ color: colors.textTertiary }}>
                  None selected
                </p>
              )}
            </div>
          </div>
        </motion.div>

        {/* Products */}
        {totalProducts > 0 && (
          <motion.div {...slideUp} {...staggerDelay(5)}>
            <div className="flex items-center justify-between">
              <SectionLabel icon={Sparkles} colorKey="violet">
                Product Expertise
              </SectionLabel>
              <span
                className="rounded-xl px-3 py-1 text-xs font-semibold"
                style={{
                  background: colors.accentLight,
                  color: colors.accent,
                  border: `1px solid ${colors.accentBorder}`,
                }}
              >
                {totalProducts} product{totalProducts !== 1 ? 's' : ''}
              </span>
            </div>
            <Card className="px-6 py-5">
              {[...productsByCategory.entries()].map(([category, skillNames], ci) => (
                <div
                  key={category}
                  style={{
                    paddingBottom: ci < productsByCategory.size - 1 ? 16 : 0,
                    marginBottom: ci < productsByCategory.size - 1 ? 16 : 0,
                    borderBottom:
                      ci < productsByCategory.size - 1
                        ? `1px solid ${colors.borderSubtle}`
                        : 'none',
                  }}
                >
                  <p
                    className="mt-0 mb-2.5 text-[11px] font-semibold tracking-[0.06em] uppercase"
                    style={{ color: colors.textTertiary }}
                  >
                    {category}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {skillNames.map((name) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1.5 rounded-[20px] px-3 py-1.5 text-[13px] font-medium"
                        style={{
                          background: colors.primaryLight,
                          color: colors.primary,
                          border: `1px solid ${colors.primaryBorder}`,
                        }}
                      >
                        <Check
                          className="h-3 w-3"
                          style={{ color: colors.primary }}
                          aria-hidden="true"
                        />
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </Card>
          </motion.div>
        )}

        {/* Assessment */}
        {assessmentMap.size > 0 && (
          <motion.div {...slideUp} {...staggerDelay(6)}>
            <SectionLabel icon={Compass} colorKey="cyan">
              Self-Assessment
            </SectionLabel>
            <div className="flex flex-col gap-3">
              {[...assessmentMap.entries()].map(([, { name: skillName, ratings }]) => (
                <Card key={skillName} className="px-5 py-4" hover>
                  <p className="mb-3.5 text-[15px] font-semibold" style={{ color: colors.text }}>
                    {skillName}
                  </p>
                  <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
                    {supportTypes.map((st) => {
                      const conf = SUPPORT_TYPE_CONFIG[st.slug] ?? {
                        icon: Wrench,
                        color: '#2563EB',
                      };
                      const StIcon = conf.icon;
                      const val = ratings.get(st.slug) ?? 0;
                      return (
                        <div key={st.id} className="flex items-center gap-2.5">
                          <div
                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                            style={{ background: `${conf.color}12` }}
                          >
                            <StIcon
                              className="h-3 w-3"
                              style={{ color: conf.color }}
                              aria-hidden="true"
                            />
                          </div>
                          <span
                            className="min-w-[72px] shrink-0 text-xs"
                            style={{ color: colors.textSecondary }}
                          >
                            {st.name}
                          </span>
                          <div className="flex-1">
                            <MiniBar value={val} max={10} color={conf.color} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </Card>
              ))}
            </div>
          </motion.div>
        )}

        {/* Certifications */}
        {(certifications.length > 0 || profile.trailheadUrl) && (
          <motion.div {...slideUp} {...staggerDelay(7)}>
            <SectionLabel icon={Award} colorKey="amber">
              Certifications
            </SectionLabel>

            {/* Trailhead link */}
            {profile.trailheadUrl && (
              <div
                className="mb-4 flex items-center gap-2.5 rounded-[10px] px-4 py-3"
                style={{
                  background: colors.surfaceSubtle,
                  border: `1px solid ${colors.borderSubtle}`,
                }}
              >
                <Globe className="h-4 w-4" style={{ color: colors.cyan }} aria-hidden="true" />
                <span className="text-[13px]" style={{ color: colors.textSecondary }}>
                  Trailhead:
                </span>
                <a
                  href={
                    profile.trailheadUrl.startsWith('http')
                      ? profile.trailheadUrl
                      : `https://trailblazer.me/id/${profile.trailheadUrl}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-[13px] font-medium"
                  style={{ color: colors.primary }}
                >
                  {profile.trailheadUrl.startsWith('http')
                    ? profile.trailheadUrl.replace(/^https?:\/\/(www\.)?/, '')
                    : `trailblazer.me/id/${profile.trailheadUrl}`}
                  <ExternalLink
                    className="h-3 w-3"
                    style={{ color: colors.primary }}
                    aria-hidden="true"
                  />
                </a>
              </div>
            )}

            {certifications.length > 0 && (
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {certifications.map((cert) => (
                  <Card key={cert.id} className="flex items-center gap-3 px-4 py-3.5" hover>
                    <div
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                      style={{
                        background: colors.amberLight,
                        border: `1px solid ${colors.amberBorder}`,
                      }}
                    >
                      <Award
                        className="h-4 w-4"
                        style={{ color: colors.amber }}
                        aria-hidden="true"
                      />
                    </div>
                    <div>
                      <p className="text-[13px] font-semibold" style={{ color: colors.text }}>
                        {cert.certification.name}
                      </p>
                      {certCategoryMap.get(cert.certificationId) && (
                        <p className="mt-0.5 text-[11px]" style={{ color: colors.textTertiary }}>
                          {certCategoryMap.get(cert.certificationId)}
                        </p>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {/* Work History */}
        {workHistory.length > 0 && (
          <motion.div {...slideUp} {...staggerDelay(8)}>
            <SectionLabel icon={Briefcase} colorKey="emerald">
              Work History
            </SectionLabel>
            <div className="flex flex-col gap-3">
              {workHistory.map((entry) => (
                <Card key={entry.id} className="px-6 py-5" hover>
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[15px] font-semibold" style={{ color: colors.text }}>
                        {entry.role}
                      </p>
                      <p className="mt-1 text-sm" style={{ color: colors.textSecondary }}>
                        {entry.company}
                      </p>
                    </div>
                    {entry.isCurrent && (
                      <span
                        className="rounded-xl px-2.5 py-0.5 text-[11px] font-semibold"
                        style={{
                          background: colors.successLight,
                          color: colors.success,
                          border: `1px solid ${colors.successBorder}`,
                        }}
                      >
                        Current
                      </span>
                    )}
                  </div>
                  <div
                    className="mt-2 flex items-center gap-1.5 text-xs"
                    style={{ color: colors.textTertiary }}
                  >
                    <Clock
                      className="h-3 w-3"
                      style={{ color: colors.textTertiary }}
                      aria-hidden="true"
                    />
                    {formatDate(entry.startedAt)} —{' '}
                    {entry.isCurrent ? 'Present' : formatDate(entry.endedAt)}
                  </div>
                  {entry.responsibilities && (
                    <p
                      className="mt-3 pt-3 text-[13px] leading-relaxed"
                      style={{
                        color: colors.textSecondary,
                        borderTop: `1px solid ${colors.borderSubtle}`,
                      }}
                    >
                      {entry.responsibilities}
                    </p>
                  )}
                </Card>
              ))}
            </div>
          </motion.div>
        )}
      </div>

      {/* Back to Dashboard */}
      <motion.div {...slideUp} {...staggerDelay(9)} className="mt-12 text-center">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 rounded-[10px] border px-8 py-3 text-[15px] font-semibold transition-all duration-200 hover:shadow-[0_2px_8px_rgba(37,99,235,0.12)]"
          style={{
            borderColor: colors.border,
            background: colors.surface,
            color: colors.text,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = colors.primaryBorder;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = colors.border;
          }}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Dashboard
        </Link>
      </motion.div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────

function formatDate(date: Date | string | null | undefined): string {
  if (!date) return '—';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}
