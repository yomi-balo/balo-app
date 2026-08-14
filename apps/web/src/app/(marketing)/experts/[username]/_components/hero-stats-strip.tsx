import { ratingAccessibleName } from '@/components/balo/rating-display';
import type { ExpertProfileView } from '@/components/expert/profile';

interface HeroStat {
  key: string;
  value: string;
  sub?: string;
  label: string;
  /**
   * The whole stat as ONE sentence for assistive tech, replacing the visual nodes.
   *
   * ⚠ ONLY THE RATING SETS IT, AND THAT IS NOT AN OVERSIGHT. Every other stat here is
   * already self-describing when read in order — "12+" then "Consultations", "8" then
   * "Yrs"/"Experience". The rating is not: it announces as "4.3 (12) Rating", where neither
   * number carries a scale and the parenthesised one has no noun at all. See
   * {@link ratingAccessibleName} for why that noun must be "engagements".
   */
  srLabel?: string;
}

function buildStats(view: ExpertProfileView): HeroStat[] {
  const stats: HeroStat[] = [];

  // ⚠ RATING (BAL-422) — OMITTED ENTIRELY when the expert has no reviews, exactly like every
  // other stat here. `ratingAverage` is null in that case and 0.0 IS NOT A VALID RATING: the
  // scale starts at 1, so rendering "0.0" would fabricate a bad score for an expert who
  // simply has not been reviewed yet. Never `?? 0`, never a fallback string.
  //
  // ⚠ THE COUNT SHIPS WITH THE AVERAGE (BAL-422 AC), riding the existing `sub` slot the same
  // way "yrs" does on Experience — no new markup, no new component. It reads "4.3 (12)".
  // It leads the strip because it is the strongest signal a visitor has.
  if (view.ratingAverage !== null) {
    stats.push({
      key: 'rating',
      value: view.ratingAverage.toFixed(1),
      sub: `(${view.ratingCount})`,
      label: 'Rating',
      srLabel: ratingAccessibleName(view.ratingAverage, view.ratingCount),
    });
  }

  // Consultations renders only when > 0 (0 for everyone in v1 → effectively hidden).
  if (view.consultationCount > 0) {
    stats.push({
      key: 'consultations',
      value: `${view.consultationCount}+`,
      label: 'Consultations',
    });
  }

  // Experience renders only when a real start year is known.
  if (view.yearsExperience != null && view.yearsExperience > 0) {
    stats.push({
      key: 'experience',
      value: String(view.yearsExperience),
      sub: 'yrs',
      label: 'Experience',
    });
  }

  // Certs render only when the expert actually has certifications.
  if (view.certCount > 0) {
    stats.push({ key: 'certs', value: String(view.certCount), label: 'Certs' });
  }

  return stats;
}

/**
 * Data-backed stats strip inside the hero. Every stat is null-gated and no value is ever
 * fabricated — an unbacked stat is simply OMITTED, and the strip itself renders nothing when
 * the expert has no backable stats at all.
 *
 * ⚠ BAL-422 added the rating stat under that same rule: an expert with no reviews shows NO
 * rating stat, never `0.0`. See `buildStats`.
 */
export function HeroStatsStrip({
  view,
}: Readonly<{ view: ExpertProfileView }>): React.JSX.Element | null {
  const stats = buildStats(view);
  if (stats.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-2xl border border-white/10 bg-white/5 px-5 py-4 backdrop-blur-sm sm:px-6">
      {stats.map((stat, i) => (
        <div key={stat.key} className="flex items-center gap-6">
          {i > 0 && <span className="hidden h-8 w-px self-stretch bg-white/10 sm:block" />}
          {/*
            ⚠ WHEN `srLabel` IS SET, THE VISUAL NODES ARE HIDDEN FROM ASSISTIVE TECH AND THE
            SENTENCE REPLACES THEM — including the `<p>` label, which is why it is inside the
            `aria-hidden` subtree. Leaving the label exposed would announce the value twice
            ("Rated 4.3 out of 5 across 12 engagements. Rating."). Stats WITHOUT an `srLabel`
            are untouched and read exactly as before.
          */}
          {stat.srLabel !== undefined && <span className="sr-only">{stat.srLabel}</span>}
          <div className="text-left" aria-hidden={stat.srLabel === undefined ? undefined : true}>
            <div className="flex items-baseline gap-1.5">
              <span className="text-[22px] leading-none font-bold text-white">{stat.value}</span>
              {stat.sub && <span className="text-xs text-white/55">{stat.sub}</span>}
            </div>
            <p className="mt-1.5 text-[11px] font-semibold tracking-[0.06em] text-white/70 uppercase">
              {stat.label}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
