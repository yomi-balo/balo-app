'use client';

import { Fragment, useState, useMemo } from 'react';
import { motion } from 'motion/react';
import { Check, Star, Wrench, Blocks, Shield, Compass, type LucideIcon } from 'lucide-react';
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

const MAX_VISIBLE_PILLS = 5;

// ── Photo Hero ───────────────────────────────────────────────────

function PhotoHero({
  expert,
  tagline,
  orderBy,
}: {
  expert: ExpertCardData;
  tagline: string;
  orderBy?: string[];
}): React.JSX.Element {
  const [photoError, setPhotoError] = useState(false);
  const showPhoto = !!expert.avatarKey && !photoError;
  const gradient = getGradientFromId(expert.id);
  const highlightedTagline = highlightTagline(tagline, orderBy);

  return (
    <div className="relative aspect-[3/2]">
      {showPhoto ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={getAvatarUrl(expert.avatarKey, 'profile')!}
            alt={expert.name}
            className="h-full w-full object-cover"
            onError={() => setPhotoError(true)}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
        </>
      ) : (
        <>
          <div
            className={cn(
              'flex h-full w-full items-center justify-center bg-gradient-to-br',
              gradient.from,
              gradient.to
            )}
          >
            <span className="text-4xl font-semibold text-white/90 select-none">
              {expert.initials}
            </span>
          </div>
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />
        </>
      )}

      {/* Availability pill */}
      {expert.available && (
        <div className="border-success/30 bg-success/15 absolute top-3 right-3 flex items-center gap-1.5 rounded-full border px-2.5 py-1">
          <span className="relative flex h-2 w-2">
            <span className="bg-success absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
            <span className="bg-success relative inline-flex h-2 w-2 rounded-full" />
          </span>
          <span className="text-success text-[10px] font-semibold">Available</span>
        </div>
      )}

      {/* Overlay text */}
      <div className="absolute right-0 bottom-0 left-0 p-4 text-white">
        <div className="mb-0.5 flex items-center gap-1.5">
          <p className="text-sm font-semibold drop-shadow-sm">{expert.name}</p>
          <Check className="text-success h-3.5 w-3.5 drop-shadow-sm" aria-label="Verified expert" />
        </div>
        <div className="line-clamp-2">
          <p className="text-xs text-white/90 drop-shadow-sm">
            <span>{expert.title}</span>
            {tagline && (
              <>
                <span className="mx-1.5 text-white/50">|</span>
                <span>{highlightedTagline}</span>
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Stats Strip ──────────────────────────────────────────────────

interface StatItemData {
  label: string;
  value: string | number;
  icon?: LucideIcon;
}

function StatsStrip({ expert }: { expert: ExpertCardData }): React.JSX.Element {
  const visibleStats: StatItemData[] = [
    { label: 'yrs exp', value: expert.yearsExp },
    { label: 'certs', value: expert.certifications },
    ...(expert.consultationCount > 0
      ? [{ label: 'sessions', value: expert.consultationCount }]
      : []),
    ...(expert.reviewCount > 0
      ? [
          {
            label: 'rating',
            value: `${expert.rating?.toFixed(1)} (${expert.reviewCount})`,
            icon: Star,
          },
        ]
      : []),
  ];

  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      {visibleStats.map((stat, i) => (
        <Fragment key={stat.label}>
          {i > 0 && <span className="bg-border h-3 w-px" />}
          <div className="flex items-center gap-1">
            {stat.icon && <stat.icon className="fill-warning text-warning h-3 w-3" />}
            <span className="text-foreground text-xs font-semibold">{stat.value}</span>
            <span className="text-muted-foreground text-[10px]">{stat.label}</span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

// ── Expertise Pills ──────────────────────────────────────────────

function ExpertisePills({ expertise }: { expertise: ExpertiseItem[] }): React.JSX.Element | null {
  if (expertise.length === 0) return null;

  const overflowCount = expertise.length - MAX_VISIBLE_PILLS;
  const visibleExpertise = expertise.slice(0, MAX_VISIBLE_PILLS);

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex flex-wrap gap-2 px-4 py-2.5">
        {visibleExpertise.map((item) => (
          <div
            key={item.product}
            className="bg-muted text-muted-foreground flex max-w-[200px] items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium"
          >
            <span className="truncate">{item.product}</span>
            {item.skills.length > 0 && (
              <span className="border-border/50 ml-0.5 flex items-center gap-0.5 border-l pl-1.5">
                {item.skills.map((skill) => {
                  const Icon = SKILL_ICON_MAP[skill];
                  return (
                    <Tooltip key={skill}>
                      <TooltipTrigger asChild>
                        <span className="text-muted-foreground/70 hover:text-foreground inline-flex h-4 w-4 cursor-help items-center justify-center transition-colors">
                          <Icon className="h-3 w-3" />
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
          <span className="text-muted-foreground/70 flex items-center text-xs">
            +{overflowCount} more
          </span>
        )}
      </div>
    </TooltipProvider>
  );
}

// ── CTA Row ──────────────────────────────────────────────────────

function CtaRow({
  rate,
  onBook,
  onViewProfile,
}: {
  rate: number;
  onBook?: () => void;
  onViewProfile?: () => void;
}): React.JSX.Element {
  return (
    <div className="border-border flex items-center justify-between border-t px-4 py-3">
      <div>
        <span className="text-foreground font-mono text-lg font-semibold tabular-nums">
          A${rate.toFixed(2)}
        </span>
        <span className="text-muted-foreground text-xs font-normal">/min</span>
      </div>
      <div className="flex items-center gap-2">
        {onViewProfile && (
          <motion.button
            type="button"
            whileTap={{ scale: 0.98 }}
            onClick={onViewProfile}
            className="text-foreground hover:bg-muted h-11 rounded-lg px-3 text-xs font-medium transition-colors"
          >
            View Profile
          </motion.button>
        )}
        {onBook ? (
          <motion.button
            type="button"
            whileTap={{ scale: 0.98 }}
            onClick={onBook}
            className="from-primary h-11 rounded-lg bg-gradient-to-r to-violet-600 px-4 text-xs font-semibold text-white shadow-sm transition-shadow hover:shadow-md dark:to-violet-500"
          >
            Book Consultation
          </motion.button>
        ) : (
          <span className="from-primary flex h-11 items-center rounded-lg bg-gradient-to-r to-violet-600 px-4 text-xs font-semibold text-white shadow-sm dark:to-violet-500">
            Book Consultation
          </span>
        )}
      </div>
    </div>
  );
}

// ── Main ExpertCard ──────────────────────────────────────────────

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

  const showBio = variant !== 'compact' && !!expert.bio;

  return (
    <motion.div whileHover={{ y: -4 }} transition={{ duration: 0.2, ease: 'easeOut' }}>
      <Card className="dark:hover:shadow-primary/5 gap-0 overflow-hidden rounded-xl border py-0 shadow-sm transition-shadow duration-200 hover:shadow-lg">
        <PhotoHero expert={expert} tagline={tagline} orderBy={orderBy} />

        {showBio && (
          <div className="px-4 pt-3 pb-2">
            <p className="text-muted-foreground line-clamp-3 text-xs leading-relaxed">
              {expert.bio}
            </p>
          </div>
        )}

        <StatsStrip expert={expert} />
        <ExpertisePills expertise={orderedExpertise} />
        <CtaRow rate={expert.rate} onBook={onBook} onViewProfile={onViewProfile} />
      </Card>
    </motion.div>
  );
}
