'use client';

import { useState, useMemo } from 'react';
import Image from 'next/image';
import { motion } from 'motion/react';
import {
  Star,
  Heart,
  MapPin,
  Award,
  Video,
  User,
  Phone,
  Clock,
  Shield,
  Code,
  Layers,
  Settings,
  Target,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import type {
  ExpertCardProps,
  ExpertCardData,
  ExpertCardAgency,
  ExpertCardDistinctions,
  SkillType,
  ExpertiseItem,
} from './expert-card.types';
import {
  getGradientFromId,
  getOrderedExpertise,
  buildTagline,
  highlightTagline,
  computeAvailability,
  getCountryDisplay,
  getDistinctionList,
  SKILL_LABELS,
} from './expert-card.utils';
import type { AvailabilityTone } from './expert-card.utils';

// ── Skill icon mapping ───────────────────────────────────────────

const SKILL_ICON_MAP: Record<SkillType, LucideIcon> = {
  technical: Code,
  architecture: Layers,
  admin: Settings,
  strategy: Target,
};

// White floating chip styling shared by photo-overlay badges (legible over imagery).
const FLOAT_CHIP = 'bg-white dark:bg-zinc-900 shadow-[0_2px_8px_rgba(0,0,0,0.22)]';

const AVAILABILITY_TONE_COLOR: Record<AvailabilityTone, string> = {
  live: 'text-success',
  soon: 'text-success',
  later: 'text-amber-700 dark:text-warning',
  none: 'text-muted-foreground',
};

// ── Avatar header (photo or initials fallback) ───────────────────

function AvatarHeader({
  expert,
  initialsTextClass,
}: Readonly<{
  expert: ExpertCardData;
  initialsTextClass: string;
}>): React.JSX.Element {
  const [photoError, setPhotoError] = useState(false);
  const gradient = getGradientFromId(expert.id);
  const photoUrl = getAvatarUrl(expert.avatarUrl, 'profile');
  const showPhoto = !!photoUrl && !photoError;

  if (showPhoto) {
    return (
      <Image
        src={photoUrl}
        alt={expert.name}
        fill
        unoptimized
        className="object-cover"
        onError={() => setPhotoError(true)}
      />
    );
  }

  return (
    <div className="absolute inset-0 bg-gradient-to-br from-[#0F1729] to-[#1E293B] dark:from-[#0a0f1a] dark:to-[#151d2e]">
      {/* Dot texture */}
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage: 'radial-gradient(circle, white 1px, transparent 1px)',
          backgroundSize: '26px 26px',
        }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={cn(
            'flex items-center justify-center rounded-full bg-gradient-to-br shadow-[0_4px_18px_rgba(0,0,0,0.3)]',
            initialsTextClass === 'text-3xl' ? 'h-24 w-24' : 'h-[88px] w-[88px]',
            gradient.from,
            gradient.to
          )}
        >
          <span className={cn('font-semibold text-white select-none', initialsTextClass)}>
            {expert.initials}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Availability pill (top-left) ─────────────────────────────────

function AvailabilityPill({
  nextAvailableAt,
}: Readonly<{
  nextAvailableAt: string | null;
}>): React.JSX.Element {
  const { text, tone } = computeAvailability(nextAvailableAt);
  const color = AVAILABILITY_TONE_COLOR[tone];

  return (
    <div
      className={cn(
        'absolute top-3 left-3 z-[3] inline-flex items-center gap-1.5 rounded-full border border-black/5 px-2.5 py-1 text-[11px] font-semibold',
        'bg-white shadow-[0_1px_4px_rgba(0,0,0,0.18)] dark:bg-zinc-900',
        color
      )}
    >
      {tone === 'live' ? (
        <span className="relative flex h-2 w-2">
          <span className="bg-success absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
          <span className="bg-success relative inline-flex h-2 w-2 rounded-full" />
        </span>
      ) : (
        <Clock className="h-[11px] w-[11px]" />
      )}
      <span>{text}</span>
    </div>
  );
}

// ── Agency badge (bottom-right) ──────────────────────────────────

function AgencyBadge({
  agency,
}: Readonly<{ agency: ExpertCardAgency | null }>): React.JSX.Element | null {
  if (!agency) return null;

  if (agency.logoUrl) {
    return (
      <div
        className={cn(
          'absolute right-3 bottom-3 z-[3] flex h-[34px] items-center rounded-[9px] px-1.5 py-1',
          FLOAT_CHIP
        )}
      >
        <Image
          src={agency.logoUrl}
          alt={agency.name}
          width={120}
          height={24}
          unoptimized
          className="block h-6 w-auto rounded"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'absolute right-3 bottom-3 z-[3] flex h-7 items-center rounded-lg px-3',
        FLOAT_CHIP
      )}
    >
      <span className="text-foreground text-xs font-bold">{agency.name}</span>
    </div>
  );
}

// ── Rating badge (bottom-left) — null-gated, never renders in v1 ──

function RatingBadge({
  rating,
  reviewCount,
}: Readonly<{
  rating: number | null;
  reviewCount: number;
}>): React.JSX.Element | null {
  if (rating == null) return null;

  return (
    <div
      className={cn(
        'absolute bottom-3 left-3 z-[3] flex h-7 items-center gap-1 rounded-lg px-2.5',
        FLOAT_CHIP
      )}
    >
      <Star className="fill-warning text-warning h-3 w-3" />
      <span className="text-foreground text-xs font-bold">{rating.toFixed(1)}</span>
      <span className="text-muted-foreground text-[11px]">({reviewCount})</span>
    </div>
  );
}

// ── Heart button (top-right, grid + list) — visual-only ──────────

function HeartButton(): React.JSX.Element {
  const [liked, setLiked] = useState(false);

  return (
    <motion.button
      type="button"
      className={cn(
        'absolute top-3 right-3 z-[3] flex h-[34px] w-[34px] items-center justify-center rounded-full',
        FLOAT_CHIP
      )}
      onClick={() => setLiked((prev) => !prev)}
      whileTap={{ scale: 0.85 }}
      aria-label={liked ? 'Remove from favorites' : 'Add to favorites'}
    >
      <motion.div
        key={liked ? 'liked' : 'unliked'}
        initial={{ scale: 0 }}
        animate={{ scale: [0, 1.2, 1] }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
      >
        <Heart
          className={cn(
            'h-[15px] w-[15px]',
            liked ? 'fill-red-500 text-red-500' : 'text-muted-foreground'
          )}
        />
      </motion.div>
    </motion.button>
  );
}

// ── Distinction badges ───────────────────────────────────────────

function DistinctionBadges({
  distinctions,
}: Readonly<{
  distinctions: ExpertCardDistinctions;
}>): React.JSX.Element | null {
  const list = getDistinctionList(distinctions);
  if (list.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {list.map((d) => (
        <span
          key={d.label}
          className={cn(
            'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-semibold',
            d.cls
          )}
        >
          <Shield className="h-2.5 w-2.5" />
          {d.label}
        </span>
      ))}
    </div>
  );
}

// ── Expertise pills ──────────────────────────────────────────────

function ExpertisePills({
  expertise,
  max,
  showHeading,
  pad,
}: Readonly<{
  expertise: ExpertiseItem[];
  max?: number;
  showHeading?: boolean;
  pad?: boolean;
}>): React.JSX.Element | null {
  if (expertise.length === 0) return null;

  const limit = max ?? 4;
  const heading = showHeading ?? true;
  const padded = pad ?? true;
  const overflowCount = expertise.length - limit;
  const visibleExpertise = expertise.slice(0, limit);
  const padCls = padded ? 'px-4' : 'px-0';

  return (
    <TooltipProvider delayDuration={0}>
      <div>
        {heading && (
          <p className={cn('text-foreground mb-2 text-[13px] font-semibold', padCls)}>
            Top expert in
          </p>
        )}
        <div className={cn('flex flex-wrap gap-2', padCls)}>
          {visibleExpertise.map((item) => (
            <div
              key={item.product}
              className="text-primary border-primary/[0.18] bg-primary/[0.07] flex items-center gap-1.5 rounded-full border px-2.5 py-[5px] text-xs font-semibold"
            >
              <span>{item.product}</span>
              {item.skills.length > 0 && (
                <>
                  <span className="bg-primary/20 h-3 w-px shrink-0" />
                  <span className="flex items-center">
                    {item.skills.map((skill) => {
                      const Icon = SKILL_ICON_MAP[skill];
                      return (
                        <Tooltip key={skill}>
                          <TooltipTrigger asChild>
                            <span className="inline-flex h-[22px] w-[22px] cursor-default items-center justify-center">
                              <Icon className="h-3 w-3" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>{SKILL_LABELS[skill]}</TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </span>
                </>
              )}
            </div>
          ))}
          {overflowCount > 0 && (
            <div className="flex items-center gap-0.5 px-1 py-[5px]">
              <span className="text-primary text-xs font-semibold">
                +{overflowCount} more products
              </span>
              <ChevronRight className="text-primary h-3 w-3" />
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

// ── Rate display (handles null) ──────────────────────────────────

function GridRate({ rate }: Readonly<{ rate: number | null }>): React.JSX.Element {
  if (rate == null) {
    return (
      <div className="shrink-0 text-right">
        <p className="text-foreground font-mono text-[19px] font-bold tabular-nums">&mdash;</p>
        <p className="text-muted-foreground text-[10px]">rate not set</p>
      </div>
    );
  }
  return (
    <div className="shrink-0 text-right">
      <p className="text-foreground font-mono text-[19px] font-bold tabular-nums">
        A${rate.toFixed(2)}
      </p>
      <p className="text-muted-foreground text-[10px]">per minute</p>
    </div>
  );
}

function ListRate({ rate }: Readonly<{ rate: number | null }>): React.JSX.Element {
  if (rate == null) {
    return (
      <p className="text-foreground shrink-0 text-right text-lg font-bold">
        <span className="font-mono">&mdash;</span>
        <span className="text-muted-foreground text-xs font-medium"> rate not set</span>
      </p>
    );
  }
  return (
    <p className="text-foreground shrink-0 text-right text-lg font-bold">
      <span className="font-mono tabular-nums">A${rate.toFixed(2)}</span>
      <span className="text-muted-foreground text-xs font-medium">/min</span>
    </p>
  );
}

// ── Stats strip (grid) ───────────────────────────────────────────

interface StatItemData {
  key: string;
  label: string;
  icon: LucideIcon;
}

function buildGridStats(expert: ExpertCardData): StatItemData[] {
  const country = getCountryDisplay(expert.countryCode);
  const stats: StatItemData[] = [
    { key: 'location', label: country?.name ?? 'Remote', icon: MapPin },
  ];

  if (expert.yearsExperience != null && expert.yearsExperience > 0) {
    stats.push({ key: 'years', label: `${expert.yearsExperience}y exp`, icon: Award });
  }

  if (expert.consultationCount > 0) {
    stats.push({ key: 'sessions', label: `${expert.consultationCount} sessions`, icon: Video });
  } else {
    stats.push({ key: 'new', label: 'New', icon: Phone });
  }

  return stats;
}

function StatsStrip({ expert }: Readonly<{ expert: ExpertCardData }>): React.JSX.Element {
  const stats = buildGridStats(expert);

  return (
    <div className="mx-4">
      <div
        className="border-border/50 grid border-y"
        style={{ gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}
      >
        {stats.map((stat, i) => (
          <div key={stat.key} className="relative flex flex-col items-center gap-1 px-1 py-3">
            {i > 0 && <span className="bg-border/50 absolute top-2 bottom-2 left-0 w-px" />}
            <stat.icon className="text-primary h-[15px] w-[15px]" />
            <span className="text-muted-foreground text-center text-[10.5px] leading-tight font-medium">
              {stat.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── List meta line (flag · name · years · sessions) ──────────────

function buildListMeta(expert: ExpertCardData): string[] {
  const country = getCountryDisplay(expert.countryCode);
  const meta: string[] = [country ? `${country.flag} ${country.name}` : 'Remote'];

  if (expert.yearsExperience != null && expert.yearsExperience > 0) {
    meta.push(`${expert.yearsExperience}y exp`);
  }

  meta.push(expert.consultationCount > 0 ? `${expert.consultationCount} sessions` : 'New expert');

  return meta;
}

// ── Title + tagline ──────────────────────────────────────────────

function buildHeadline(expert: ExpertCardData): string {
  if (expert.headline) return expert.headline;
  return expert.expertise[0]?.product ?? 'Salesforce Expert';
}

// ── CTA buttons ──────────────────────────────────────────────────

function ViewProfileButton({ onClick }: Readonly<{ onClick?: () => void }>): React.JSX.Element {
  const className =
    'border-border text-foreground flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border text-xs font-medium transition-colors hover:bg-muted';
  if (onClick) {
    return (
      <motion.button
        type="button"
        whileTap={{ scale: 0.98 }}
        onClick={onClick}
        className={className}
      >
        <User className="h-4 w-4" />
        View profile
      </motion.button>
    );
  }
  return (
    <span className={className}>
      <User className="h-4 w-4" />
      View profile
    </span>
  );
}

function BookCallButton({ onClick }: Readonly<{ onClick?: () => void }>): React.JSX.Element {
  const className =
    'from-primary flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r to-violet-600 text-xs font-semibold text-white shadow-sm transition-shadow hover:shadow-md dark:to-violet-500';
  if (onClick) {
    return (
      <motion.button
        type="button"
        whileTap={{ scale: 0.98 }}
        onClick={onClick}
        className={className}
      >
        <Video className="h-4 w-4" />
        Book a call
      </motion.button>
    );
  }
  return (
    <span className={className}>
      <Video className="h-4 w-4" />
      Book a call
    </span>
  );
}

// ── Grid variant ─────────────────────────────────────────────────

function GridCard({
  expert,
  orderedExpertise,
  tagline,
  highlightedTagline,
  onBook,
  onViewProfile,
}: Readonly<{
  expert: ExpertCardData;
  orderedExpertise: ExpertiseItem[];
  tagline: string;
  highlightedTagline: React.ReactNode;
  onBook?: () => void;
  onViewProfile?: () => void;
}>): React.JSX.Element {
  return (
    <motion.div
      className="h-full"
      whileHover={{ y: -4 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
    >
      <Card className="dark:hover:shadow-primary/5 flex h-full w-full flex-col gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm transition-shadow duration-200 hover:shadow-lg">
        {/* Photo header */}
        <div className="relative aspect-[5/4]">
          <AvatarHeader expert={expert} initialsTextClass="text-3xl" />
          <AvailabilityPill nextAvailableAt={expert.nextAvailableAt} />
          <HeartButton />
          <AgencyBadge agency={expert.agency} />
          <RatingBadge rating={expert.rating} reviewCount={expert.reviewCount} />
        </div>

        {/* Name + rate strip */}
        <div className="bg-card flex items-start justify-between px-4 pt-3.5 pb-1">
          <div className="min-w-0">
            <p className="text-foreground text-[17px] font-semibold">{expert.name}</p>
            <DistinctionBadges distinctions={expert.distinctions} />
          </div>
          <GridRate rate={expert.rate} />
        </div>

        {/* Stats strip */}
        <div className="pt-2.5 pb-1">
          <StatsStrip expert={expert} />
        </div>

        {/* Title + tagline */}
        <div className="px-4 pt-3 pb-2">
          <div className="line-clamp-2 text-[13px] leading-snug">
            <span className="text-foreground font-semibold">{buildHeadline(expert)}</span>
            {tagline && (
              <span className="text-muted-foreground text-[12px] font-normal">
                {' '}
                <span className="text-muted-foreground/50">&middot;</span> {highlightedTagline}
              </span>
            )}
          </div>
        </div>

        {/* Bio */}
        {expert.bio && (
          <div className="px-4 pb-3">
            <div className="border-l-primary/40 bg-muted/60 rounded-lg border-l-2 py-2 pr-3 pl-3">
              <p className="text-foreground/70 line-clamp-4 text-[12px] leading-relaxed italic">
                {expert.bio}
              </p>
            </div>
          </div>
        )}

        {/* Expertise pills */}
        <ExpertisePills expertise={orderedExpertise} max={4} showHeading pad />

        {/* CTA row */}
        <div className="mx-4 mt-auto flex gap-2 pt-3.5 pb-4">
          <ViewProfileButton onClick={onViewProfile} />
          <BookCallButton onClick={onBook} />
        </div>
      </Card>
    </motion.div>
  );
}

// ── List variant (desktop-only markup) ───────────────────────────

function ListRow({
  expert,
  orderedExpertise,
  tagline,
  highlightedTagline,
  onBook,
  onViewProfile,
}: Readonly<{
  expert: ExpertCardData;
  orderedExpertise: ExpertiseItem[];
  tagline: string;
  highlightedTagline: React.ReactNode;
  onBook?: () => void;
  onViewProfile?: () => void;
}>): React.JSX.Element {
  const meta = buildListMeta(expert);

  return (
    <Card className="dark:hover:shadow-primary/5 flex flex-row gap-0 overflow-hidden rounded-2xl border py-0 shadow-sm transition-shadow duration-200 hover:shadow-lg">
      {/* Photo panel */}
      <div className="relative w-60 shrink-0 self-stretch overflow-hidden">
        <AvatarHeader expert={expert} initialsTextClass="text-[28px]" />
        <AvailabilityPill nextAvailableAt={expert.nextAvailableAt} />
        <HeartButton />
        <AgencyBadge agency={expert.agency} />
        <RatingBadge rating={expert.rating} reviewCount={expert.reviewCount} />
      </div>

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-foreground text-lg font-semibold">{expert.name}</p>
            <div className="text-muted-foreground mt-1 flex flex-wrap gap-2 text-[13px]">
              {meta.map((m, i) => (
                <span key={m} className="flex items-center gap-2">
                  {i > 0 && <span className="text-border">&middot;</span>}
                  <span>{m}</span>
                </span>
              ))}
            </div>
          </div>
          <ListRate rate={expert.rate} />
        </div>

        <p className="text-foreground mt-3 text-sm">
          <span className="font-semibold">{buildHeadline(expert)}</span>
          {tagline && <span className="text-muted-foreground"> &middot; {highlightedTagline}</span>}
        </p>

        <DistinctionBadges distinctions={expert.distinctions} />

        {expert.bio && (
          <p className="text-foreground/70 mt-2.5 line-clamp-2 text-[13px] leading-relaxed">
            {expert.bio}
          </p>
        )}

        <div className="mt-3 mb-4">
          <ExpertisePills expertise={orderedExpertise} max={5} showHeading={false} pad={false} />
        </div>

        <div className="mt-auto flex gap-2.5">
          <div className="flex max-w-[200px] flex-1">
            <ViewProfileButton onClick={onViewProfile} />
          </div>
          <div className="flex max-w-[200px] flex-1">
            <BookCallButton onClick={onBook} />
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── Main ExpertCard ──────────────────────────────────────────────

export function ExpertCard({
  expert,
  orderBy,
  variant = 'grid',
  onBook,
  onViewProfile,
}: Readonly<ExpertCardProps>): React.JSX.Element {
  const orderedExpertise = useMemo(
    () => getOrderedExpertise(expert.expertise, orderBy),
    [expert.expertise, orderBy]
  );

  const tagline = useMemo(() => buildTagline(orderedExpertise), [orderedExpertise]);

  const highlightedTagline = useMemo(() => highlightTagline(tagline, orderBy), [tagline, orderBy]);

  if (variant === 'list') {
    return (
      <ListRow
        expert={expert}
        orderedExpertise={orderedExpertise}
        tagline={tagline}
        highlightedTagline={highlightedTagline}
        onBook={onBook}
        onViewProfile={onViewProfile}
      />
    );
  }

  return (
    <GridCard
      expert={expert}
      orderedExpertise={orderedExpertise}
      tagline={tagline}
      highlightedTagline={highlightedTagline}
      onBook={onBook}
      onViewProfile={onViewProfile}
    />
  );
}
