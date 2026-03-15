'use client';

import { Star, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAvatarUrl } from '@/lib/storage/avatar-url';

interface MarketplacePreviewCardProps {
  photo: string | null;
  name: string;
  initials: string;
  headline: string;
  bio: string;
  industries: string[];
  rating: string;
  reviewCount: string;
  ratePerMinute: string;
}

export function MarketplacePreviewCard({
  photo,
  name,
  initials,
  headline,
  bio,
  industries,
  rating,
  reviewCount,
  ratePerMinute,
}: Readonly<MarketplacePreviewCardProps>): React.JSX.Element {
  const hasPhoto = !!photo;
  const hasHeadline = !!headline.trim();
  const hasBio = !!bio.trim();

  return (
    <div className="border-border bg-card overflow-hidden rounded-[14px] border shadow-lg transition-all duration-300">
      {/* Gradient banner */}
      <div className="from-primary/5 border-border/50 dark:from-primary/10 relative h-16 border-b bg-gradient-to-br to-violet-500/5 dark:to-violet-500/10">
        {/* Salesforce badge */}
        <div className="border-primary/20 bg-card text-primary absolute top-2.5 right-3 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold shadow-sm">
          Salesforce
        </div>
      </div>

      <div className="px-4 pb-4">
        {/* Avatar overlapping banner */}
        <div className="-mt-[26px] mb-2.5 flex items-end justify-between">
          <div
            className={cn(
              'border-card flex h-[52px] w-[52px] items-center justify-center overflow-hidden rounded-full border-[3px] shadow-md',
              !hasPhoto && 'from-primary bg-gradient-to-br to-violet-600'
            )}
          >
            {hasPhoto ? (
              <img
                src={getAvatarUrl(photo, 'thumbnail') ?? undefined}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-lg font-semibold text-white">{initials}</span>
            )}
          </div>

          {/* Rate */}
          <div className="text-right">
            <span className="text-foreground text-[17px] font-semibold">
              A${ratePerMinute || '\u2014'}
            </span>
            <span className="text-muted-foreground text-[11px]">/min</span>
          </div>
        </div>

        {/* Name + verified */}
        <div className="mb-0.5 flex items-center gap-1.5">
          <p className="text-foreground text-[15px] font-semibold">{name}</p>
          <Check className="text-success h-3.5 w-3.5" />
        </div>

        {/* Headline */}
        <p
          className={cn(
            'mb-2 min-h-[18px] text-xs leading-snug',
            hasHeadline
              ? 'text-muted-foreground animate-in fade-in duration-300'
              : 'text-muted-foreground/60 italic'
          )}
        >
          {hasHeadline ? headline : 'Your headline will appear here\u2026'}
        </p>

        {/* Stars */}
        <div className="mb-2.5 flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((i) => (
            <Star key={i} className="h-[11px] w-[11px] fill-amber-400 text-amber-400" />
          ))}
          <span className="text-foreground ml-0.5 text-[11px] font-semibold">{rating}</span>
          <span className="text-muted-foreground text-[11px]">({reviewCount} reviews)</span>
        </div>

        {/* Bio snippet */}
        {hasBio && (
          <p className="text-muted-foreground animate-in fade-in mb-2.5 line-clamp-2 text-[11.5px] leading-relaxed duration-300">
            {bio}
          </p>
        )}

        {/* Industry chips */}
        {industries.length > 0 && (
          <div className="animate-in fade-in mb-3 flex flex-wrap gap-1.5 duration-300">
            {industries.slice(0, 3).map((ind) => (
              <span
                key={ind}
                className="bg-muted text-muted-foreground border-border/50 rounded-full border px-2 py-0.5 text-[10px] font-medium"
              >
                {ind}
              </span>
            ))}
            {industries.length > 3 && (
              <span className="text-muted-foreground text-[10px]">
                +{industries.length - 3} more
              </span>
            )}
          </div>
        )}

        {/* CTA Button */}
        <button
          type="button"
          className="from-primary w-full cursor-default rounded-[9px] bg-gradient-to-r to-violet-600 px-4 py-2.5 text-[13px] font-semibold text-white shadow-sm"
          tabIndex={-1}
        >
          Book a Consultation
        </button>
      </div>
    </div>
  );
}
