import type { ExpertProfileView } from '@/components/expert/profile';

interface HeroStat {
  key: string;
  value: string;
  sub?: string;
  label: string;
}

function buildStats(view: ExpertProfileView): HeroStat[] {
  const stats: HeroStat[] = [];

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
 * Data-backed stats strip inside the hero. No rating/review stat (null-gated),
 * no fabricated values — empty stats are simply omitted. Renders nothing when
 * the expert has no backable stats yet.
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
          <div className="text-left">
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
