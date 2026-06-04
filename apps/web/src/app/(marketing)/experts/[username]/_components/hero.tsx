'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowLeft, ShieldCheck, Award, MapPin, Globe, Heart, Share2 } from 'lucide-react';
import type { ExpertProfileView } from '@/components/expert/profile';
import { getCountryDisplay } from '@/components/expert/expert-card.utils';
import { HeroPortrait } from './hero-portrait';
import { HeroStatsStrip } from './hero-stats-strip';

interface HeroProps {
  view: ExpertProfileView;
  portraitUrl: string | null;
}

/**
 * Marketing-grade dark-indigo hero. Intentionally dark in BOTH themes (it is
 * marketing chrome, not a `--background` surface). The only sanctioned hex lives
 * in the `.expert-hero` class; on-dark text uses literal white opacities.
 */
export function Hero({ view, portraitUrl }: Readonly<HeroProps>): React.JSX.Element {
  const [photoError, setPhotoError] = useState(false);
  const showPhoto = portraitUrl !== null && !photoError;
  const country = getCountryDisplay(view.countryCode);
  const locationLabel = view.country ?? country?.name ?? null;

  return (
    <div className="expert-hero relative overflow-hidden pb-16 md:pb-22">
      {/* Atmospheric glows (decorative) */}
      <div
        className="animate-float-glow pointer-events-none absolute -top-30 -right-15 h-95 w-95 rounded-full blur-xl"
        style={{ background: 'radial-gradient(circle, rgba(124,58,237,0.35) 0%, transparent 70%)' }}
        aria-hidden="true"
      />
      <div
        className="animate-float-glow pointer-events-none absolute -bottom-35 -left-10 h-80 w-80 rounded-full blur-xl [animation-direction:reverse]"
        style={{ background: 'radial-gradient(circle, rgba(37,99,235,0.30) 0%, transparent 70%)' }}
        aria-hidden="true"
      />
      {/* Subtle dot grid texture */}
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage: 'radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
        aria-hidden="true"
      />

      <div className="relative mx-auto max-w-[1120px] px-5 md:px-8">
        {/* Breadcrumb + actions */}
        <div className="animate-fade-in flex items-center justify-between py-5">
          <Link
            href="/experts"
            className="inline-flex items-center gap-1.5 rounded-[9px] border border-white/15 bg-white/10 px-3.5 py-2 text-[13px] font-medium text-white/85 transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Browse experts
          </Link>
          <div className="flex gap-2">
            <button
              type="button"
              aria-label="Save to favorites"
              className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-white/15 bg-white/10 text-white/80 transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
            >
              <Heart className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="Share this profile"
              className="flex h-9 w-9 items-center justify-center rounded-[9px] border border-white/15 bg-white/10 text-white/80 transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:outline-none"
            >
              <Share2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Identity */}
        <div className="animate-slide-up flex flex-col items-stretch gap-6 pt-4 md:flex-row md:gap-10 md:pt-6">
          {/* Portrait */}
          <div className="relative w-[150px] shrink-0 md:w-[250px]">
            <div className="relative aspect-[7/8] overflow-hidden rounded-[22px] border-[3px] border-white/15 bg-[var(--hero-portrait-bg)] shadow-[0_22px_60px_rgba(0,0,0,0.45)]">
              {showPhoto ? (
                <Image
                  src={portraitUrl}
                  alt={view.name}
                  fill
                  unoptimized
                  sizes="(max-width: 820px) 150px, 250px"
                  className="object-cover"
                  onError={() => setPhotoError(true)}
                />
              ) : (
                <HeroPortrait />
              )}
            </div>
            {/* Availability pill */}
            {view.availableForWork ? (
              <div className="absolute right-3.5 bottom-3.5 inline-flex items-center gap-1.5 rounded-full border border-emerald-300/35 bg-[var(--hero-pill-bg)] py-1 pr-2.5 pl-2 backdrop-blur-sm">
                <span className="animate-pulse-dot bg-success h-2.5 w-2.5 rounded-full" />
                <span className="text-[11.5px] font-semibold text-emerald-300">Available</span>
              </div>
            ) : (
              <div className="absolute right-3.5 bottom-3.5 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-[var(--hero-pill-bg)] px-2.5 py-1 backdrop-blur-sm">
                <span className="text-[11.5px] font-medium text-white/70">
                  Currently unavailable
                </span>
              </div>
            )}
          </div>

          {/* Right column */}
          <div className="flex min-w-0 flex-1 flex-col justify-between gap-5 md:gap-6">
            {/* Name block */}
            <div className="min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h1 className="m-0 text-[27px] font-bold tracking-[-0.025em] text-white md:text-[38px]">
                    {view.name}
                  </h1>
                  {view.baloVerified && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-300">
                      <ShieldCheck className="h-3.5 w-3.5" /> Balo Verified
                    </span>
                  )}
                  {view.topRated && (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/15 px-2.5 py-1 text-xs font-semibold text-amber-300">
                      <Award className="h-3.5 w-3.5" /> Top Rated
                    </span>
                  )}
                </div>

                {/* Agency lockup */}
                {view.agency && (
                  <div className="flex shrink-0 items-center gap-2.5">
                    {view.agency.logoUrl ? (
                      <Image
                        src={view.agency.logoUrl}
                        alt={view.agency.name}
                        width={120}
                        height={38}
                        unoptimized
                        className="h-9 w-auto rounded-[10px] border border-white/15 bg-white/10 p-1"
                      />
                    ) : (
                      <div className="flex h-9.5 w-9.5 items-center justify-center rounded-[10px] border border-white/20 bg-white/10 text-[13px] font-bold text-white">
                        {view.agency.initials}
                      </div>
                    )}
                    <div className="text-left md:text-right">
                      <p className="m-0 text-[10px] font-semibold tracking-[0.1em] text-white/50 uppercase">
                        Agency
                      </p>
                      <p className="m-0 mt-0.5 text-sm font-semibold whitespace-nowrap text-white/90">
                        {view.agency.name}
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {view.headline && (
                <p className="mt-2.5 text-base font-medium text-white/80">{view.headline}</p>
              )}

              {/* Meta line — response time intentionally gated out (no data) */}
              {(locationLabel || view.languagesLabel) && (
                <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
                  {locationLabel && (
                    <span className="flex items-center gap-1.5 text-[13px] text-white/60">
                      <MapPin className="h-3.5 w-3.5" /> {locationLabel}
                    </span>
                  )}
                  {view.languagesLabel && (
                    <span className="flex items-center gap-1.5 text-[13px] text-white/60">
                      <Globe className="h-3.5 w-3.5" /> {view.languagesLabel}
                    </span>
                  )}
                </div>
              )}
            </div>

            <HeroStatsStrip view={view} />
          </div>
        </div>
      </div>
    </div>
  );
}
