'use client';

import { useState, useMemo } from 'react';
import { motion } from 'motion/react';
import {
  Check,
  Star,
  Heart,
  MapPin,
  Award,
  Video,
  User,
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
  technical: Code,
  architecture: Layers,
  admin: Settings,
  strategy: Target,
};

const SKILL_LABELS: Record<SkillType, string> = {
  technical: 'Technical / Dev',
  architecture: 'Architecture & Integrations',
  admin: 'Configuration & Admin',
  strategy: 'Strategy & Consulting',
};

const MAX_VISIBLE_PILLS = 3;

// ── Header Section (dark gradient with centered avatar) ──────────

function CardHeader({ expert }: { expert: ExpertCardData }): React.JSX.Element {
  const [photoError, setPhotoError] = useState(false);
  const [liked, setLiked] = useState(false);
  const showPhoto = !!expert.avatarKey && !photoError;
  const gradient = getGradientFromId(expert.id);

  return (
    <div className="relative">
      {/* Background: full-bleed photo or dark gradient with centered initials */}
      {showPhoto ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={getAvatarUrl(expert.avatarKey, 'profile')!}
            alt={expert.name}
            className="aspect-[5/4] w-full object-cover"
            onError={() => setPhotoError(true)}
          />
          {/* Scrim — only covers bottom third for overlay text readability */}
          <div className="absolute right-0 bottom-0 left-0 h-1/3 bg-gradient-to-t from-black/75 to-transparent" />
        </>
      ) : (
        <div className="bg-gradient-to-br from-[#0F1729] to-[#1E293B] px-4 pt-4 pb-5 dark:from-[#0a0f1a] dark:to-[#151d2e]">
          {/* Centered avatar with gradient ring — no-photo state only */}
          <div className="mt-4 flex justify-center">
            <div className="rounded-full bg-gradient-to-br from-blue-500 to-violet-600 p-[3px]">
              <div className="rounded-full border-[3px] border-[#0F1729] dark:border-[#0a0f1a]">
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
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Overlay elements — positioned absolutely over both photo and no-photo states */}
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

      {/* Favorite toggle */}
      <motion.button
        type="button"
        className="absolute top-3 right-3 flex h-8 w-8 items-center justify-center rounded-full bg-gray-600/60 backdrop-blur-sm"
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
          <Heart className={cn('h-4 w-4', liked ? 'fill-red-500 text-red-500' : 'text-white')} />
        </motion.div>
      </motion.button>

      {/* Name + Rate row — overlaid at bottom */}
      <div
        className={cn(
          'flex items-end justify-between px-4 pb-4',
          showPhoto ? 'absolute right-0 bottom-0 left-0' : 'mt-3'
        )}
      >
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
      <div className="line-clamp-2 text-[13px] leading-snug">
        <span className="text-foreground font-semibold">{expert.title}</span>
        {tagline && (
          <span className="text-muted-foreground text-[12px] font-normal">
            {' '}
            <span className="text-muted-foreground/50">&middot;</span> {highlightedTagline}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Bio Section (blockquote style) ──────────────────────────────

function BioSection({ bio }: { bio: string }): React.JSX.Element {
  return (
    <div className="px-4 pb-3">
      <div className="border-l-primary/40 bg-muted/60 rounded-lg border-l-2 py-2 pr-3 pl-3">
        <p className="text-foreground/70 line-clamp-3 text-[12px] leading-relaxed italic">{bio}</p>
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
    { label: `${expert.yearsExp}y exp`, value: '', icon: Award },
    ...(expert.certifications > 0
      ? [{ label: `${expert.certifications} certs`, value: '', icon: Award }]
      : []),
    ...(expert.consultationCount > 0
      ? [{ label: `${expert.consultationCount} sessions`, value: '', icon: Video }]
      : []),
  ];

  return (
    <div className="mx-4">
      <div className="border-border/50 border-y">
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${visibleStats.length}, 1fr)` }}
        >
          {visibleStats.map((stat, i) => (
            <div key={stat.label} className="relative flex flex-col items-center gap-1 py-3">
              {i > 0 && <span className="bg-border/50 absolute top-2 bottom-2 left-0 w-px" />}
              <stat.icon className="text-primary h-4 w-4" />
              <span className="text-muted-foreground text-[10px] font-medium">{stat.label}</span>
            </div>
          ))}
        </div>
      </div>
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
      <div className="flex flex-col gap-[5px] px-4 pt-3 pb-0.5">
        {visibleExpertise.map((item) => (
          <div
            key={item.product}
            className="text-primary border-primary/[0.18] bg-primary/[0.07] flex w-fit items-center gap-1.5 self-start rounded-full border px-2.5 py-[5px] text-[11px] font-semibold"
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
                          <span className="inline-flex h-6 w-6 cursor-default items-center justify-center">
                            <Icon className="h-[11px] w-[11px]" />
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
          <div className="flex items-center gap-0.5 pb-2.5 pl-1">
            <span className="text-primary text-[11px] font-semibold">
              +{overflowCount} more products
            </span>
            <ChevronRight className="text-primary h-[11px] w-[11px]" />
          </div>
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
    <div className="mx-4 flex items-center gap-2 py-3">
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
