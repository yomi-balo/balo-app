'use client';

import { useState, useMemo } from 'react';
import { motion } from 'motion/react';
import {
  Check,
  Star,
  Heart,
  MapPin,
  Briefcase,
  Award,
  Monitor,
  User,
  Video,
  Wrench,
  Blocks,
  Shield,
  Compass,
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
  SkillType,
  ExpertiseItem,
} from './expert-card.types';
import {
  getGradientFromId,
  getOrderedExpertise,
  buildTagline,
  highlightTagline,
} from './expert-card.utils';

// ── Skill icon mapping ───────────────────────────────────────────

const SKILL_ICON_MAP: Record<SkillType, LucideIcon> = {
  technical: Wrench,
  architecture: Blocks,
  admin: Shield,
  strategy: Compass,
};

const SKILL_LABELS: Record<SkillType, string> = {
  technical: 'Technical',
  architecture: 'Architecture',
  admin: 'Admin',
  strategy: 'Strategy',
};

const MAX_VISIBLE_PILLS = 3;

// ── Header Section (dark gradient with centered avatar) ──────────

function CardHeader({ expert }: { expert: ExpertCardData }): React.JSX.Element {
  const [photoError, setPhotoError] = useState(false);
  const showPhoto = !!expert.avatarKey && !photoError;
  const gradient = getGradientFromId(expert.id);

  return (
    <div className="relative bg-gradient-to-br from-[#0F1729] to-[#1E293B] px-4 pt-4 pb-5 dark:from-[#0a0f1a] dark:to-[#151d2e]">
      {/* Availability pill */}
      {expert.available && (
        <div className="bg-success/20 absolute top-3 left-3 flex items-center gap-1.5 rounded-full px-2.5 py-1">
          <span className="relative flex h-2 w-2">
            <span className="bg-success absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
            <span className="bg-success relative inline-flex h-2 w-2 rounded-full" />
          </span>
          <span className="text-success text-[10px] font-semibold">Available</span>
        </div>
      )}

      {/* Favorite icon */}
      <div className="absolute top-3 right-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10">
          <Heart className="h-4 w-4 text-white/70" />
        </div>
      </div>

      {/* Centered avatar with gradient ring */}
      <div className="mt-4 flex justify-center">
        <div className="rounded-full bg-gradient-to-br from-blue-500 to-violet-600 p-[3px]">
          <div className="rounded-full border-[3px] border-[#0F1729] dark:border-[#0a0f1a]">
            {showPhoto ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={getAvatarUrl(expert.avatarKey, 'thumbnail')!}
                alt={expert.name}
                className="h-[88px] w-[88px] rounded-full object-cover"
                onError={() => setPhotoError(true)}
              />
            ) : (
              <div
                className={cn(
                  'flex h-[88px] w-[88px] items-center justify-center rounded-full bg-gradient-to-br',
                  gradient.from,
                  gradient.to
                )}
              >
                <span className="text-2xl font-semibold text-white select-none">
                  {expert.initials}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Name + Rate row */}
      <div className="mt-3 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <p className="text-[15px] font-semibold text-white">{expert.name}</p>
            <Check className="text-success h-4 w-4" aria-label="Verified expert" />
          </div>
          {/* Rating */}
          {expert.reviewCount > 0 && (
            <div className="mt-0.5 flex items-center gap-1">
              {[1, 2, 3, 4, 5].map((i) => (
                <Star
                  key={i}
                  className={cn(
                    'h-3 w-3',
                    i <= Math.round(expert.rating ?? 0)
                      ? 'fill-warning text-warning'
                      : 'fill-white/20 text-white/20'
                  )}
                />
              ))}
              <span className="ml-0.5 text-[11px] font-semibold text-white">
                {expert.rating?.toFixed(1)}
              </span>
              <span className="text-[11px] text-white/50">({expert.reviewCount})</span>
            </div>
          )}
        </div>
        <div className="text-right">
          <p className="font-mono text-xl font-bold text-white tabular-nums">
            A${expert.rate.toFixed(2)}
          </p>
          <p className="text-[10px] text-white/50">per minute</p>
        </div>
      </div>
    </div>
  );
}

// ── Title + Tagline Section ─────────────────────────────────────

function TitleSection({
  expert,
  tagline,
  highlightedTagline,
}: {
  expert: ExpertCardData;
  tagline: string;
  highlightedTagline: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="px-4 pt-3 pb-2">
      <div className="line-clamp-2">
        <p className="text-foreground text-[13px] leading-snug font-semibold">
          {expert.title}
          {tagline && (
            <span className="text-muted-foreground ml-1 text-[12px] font-normal">
              {' '}
              <span className="text-muted-foreground/50">&middot;</span> {highlightedTagline}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

// ── Bio Section (blockquote style) ──────────────────────────────

function BioSection({ bio }: { bio: string }): React.JSX.Element {
  return (
    <div className="px-4 pb-3">
      <div className="border-primary/40 bg-primary/5 rounded-r-lg border-l-2 py-2 pr-3 pl-3">
        <p className="text-muted-foreground line-clamp-3 text-[12px] leading-relaxed italic">
          {bio}
        </p>
      </div>
    </div>
  );
}

// ── Stats Strip (icon + label columns) ──────────────────────────

interface StatItemData {
  label: string;
  value: string | number;
  icon: LucideIcon;
}

function StatsStrip({ expert }: { expert: ExpertCardData }): React.JSX.Element {
  const visibleStats: StatItemData[] = [
    { label: expert.location || 'Remote', value: '', icon: MapPin },
    { label: `${expert.yearsExp}y exp`, value: '', icon: Briefcase },
    ...(expert.certifications > 0
      ? [{ label: `${expert.certifications} certs`, value: '', icon: Award }]
      : []),
    ...(expert.consultationCount > 0
      ? [{ label: `${expert.consultationCount} sessions`, value: '', icon: Monitor }]
      : []),
  ];

  return (
    <div className="border-border/50 flex items-center justify-evenly border-y px-4 py-3">
      {visibleStats.map((stat) => (
        <div key={stat.label} className="flex flex-col items-center gap-1">
          <stat.icon className="text-primary h-4 w-4" />
          <span className="text-muted-foreground text-[10px] font-medium">{stat.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Expertise Pills ─────────────────────────────────────────────

function ExpertisePills({ expertise }: { expertise: ExpertiseItem[] }): React.JSX.Element | null {
  if (expertise.length === 0) return null;

  const overflowCount = expertise.length - MAX_VISIBLE_PILLS;
  const visibleExpertise = expertise.slice(0, MAX_VISIBLE_PILLS);

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-col gap-2 px-4 py-3">
        {visibleExpertise.map((item) => (
          <div
            key={item.product}
            className="border-border/60 bg-card flex w-fit items-center gap-1.5 rounded-full border px-3 py-1.5"
          >
            <span className="text-foreground text-xs font-medium">{item.product}</span>
            {item.skills.length > 0 && (
              <span className="flex items-center gap-1">
                {item.skills.map((skill) => {
                  const Icon = SKILL_ICON_MAP[skill];
                  return (
                    <Tooltip key={skill}>
                      <TooltipTrigger asChild>
                        <span className="text-primary/60 hover:text-primary inline-flex h-4 w-4 cursor-help items-center justify-center transition-colors">
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{SKILL_LABELS[skill]}</TooltipContent>
                    </Tooltip>
                  );
                })}
              </span>
            )}
          </div>
        ))}
        {overflowCount > 0 && (
          <button
            type="button"
            className="text-primary flex items-center gap-0.5 text-xs font-medium"
          >
            +{overflowCount} more products
            <ChevronRight className="h-3 w-3" />
          </button>
        )}
      </div>
    </TooltipProvider>
  );
}

// ── CTA Row ─────────────────────────────────────────────────────

function CtaRow({
  onBook,
  onViewProfile,
}: {
  onBook?: () => void;
  onViewProfile?: () => void;
}): React.JSX.Element {
  return (
    <div className="border-border flex items-center gap-2 border-t px-4 py-3">
      {onViewProfile ? (
        <motion.button
          type="button"
          whileTap={{ scale: 0.98 }}
          onClick={onViewProfile}
          className="border-border text-foreground hover:bg-muted flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border text-xs font-medium transition-colors"
        >
          <User className="h-4 w-4" />
          View profile
        </motion.button>
      ) : (
        <span className="border-border text-foreground flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border text-xs font-medium">
          <User className="h-4 w-4" />
          View profile
        </span>
      )}
      {onBook ? (
        <motion.button
          type="button"
          whileTap={{ scale: 0.98 }}
          onClick={onBook}
          className="from-primary flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r to-violet-600 text-xs font-semibold text-white shadow-sm transition-shadow hover:shadow-md dark:to-violet-500"
        >
          <Video className="h-4 w-4" />
          Book a call
        </motion.button>
      ) : (
        <span className="from-primary flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r to-violet-600 text-xs font-semibold text-white shadow-sm dark:to-violet-500">
          <Video className="h-4 w-4" />
          Book a call
        </span>
      )}
    </div>
  );
}

// ── Main ExpertCard ─────────────────────────────────────────────

export function ExpertCard({
  expert,
  orderBy,
  variant = 'card',
  onBook,
  onViewProfile,
}: Readonly<ExpertCardProps>): React.JSX.Element {
  const orderedExpertise = useMemo(
    () => getOrderedExpertise(expert.expertise, orderBy),
    [expert.expertise, orderBy]
  );

  const tagline = useMemo(() => buildTagline(orderedExpertise), [orderedExpertise]);

  const highlightedTagline = useMemo(() => highlightTagline(tagline, orderBy), [tagline, orderBy]);

  const showBio = variant !== 'compact' && !!expert.bio;

  return (
    <motion.div whileHover={{ y: -4 }} transition={{ duration: 0.2, ease: 'easeOut' }}>
      <Card className="dark:hover:shadow-primary/5 gap-0 overflow-hidden rounded-xl border py-0 shadow-sm transition-shadow duration-200 hover:shadow-lg">
        <CardHeader expert={expert} />
        <TitleSection expert={expert} tagline={tagline} highlightedTagline={highlightedTagline} />
        {showBio && <BioSection bio={expert.bio!} />}
        <StatsStrip expert={expert} />
        <ExpertisePills expertise={orderedExpertise} />
        <CtaRow onBook={onBook} onViewProfile={onViewProfile} />
      </Card>
    </motion.div>
  );
}
