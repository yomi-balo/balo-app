'use client';

import { useEffect, useRef, useState } from 'react';
import { Zap, Sparkles, Briefcase } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { SectionLabel, type QuickStartSummary } from '@/components/expert/profile';
import { PackageCard } from './package-card';

interface QuickStartsSectionProps {
  packages: QuickStartSummary[];
  firstName: string;
  /** Stubbed in v1 — same handler the BookingCard uses. BAL-255 wires real flows. */
  onStartProject: () => void;
  onViewDetails?: (id: string) => void;
}

/**
 * "Quick Starts" — pre-packaged, fixed-price project requests. In v1 the page
 * passes `packages={[]}`, so this renders the section shell + an empty state
 * (no fabricated mock packages). BAL-255 supplies real packages and a
 * `onViewDetails` handler that opens a drawer.
 *
 * The tinted background is FULL-BLEED — it breaks out of the column to the
 * viewport edges (matching the design reference). Pure CSS can't do this from a
 * left-aligned grid column, so we measure the wrapper's offset from the viewport
 * edge and size an absolutely-positioned band to `clientWidth` (excludes the
 * scrollbar → no horizontal overflow). `isolate` scopes the band's z-index so it
 * stays behind the floating booking card.
 */
export function QuickStartsSection({
  packages,
  firstName,
  onStartProject,
  onViewDetails,
}: Readonly<QuickStartsSectionProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const hasPackages = packages.length > 0;
  // v1 has no package detail drawer yet — fall back to the project stub.
  const handleViewDetails = onViewDetails ?? ((): void => onStartProject());

  const wrapRef = useRef<HTMLDivElement>(null);
  const [bleed, setBleed] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  useEffect(() => {
    const measure = (): void => {
      const el = wrapRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setBleed({ left: -rect.left, width: document.documentElement.clientWidth });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return (
    <motion.div
      ref={wrapRef}
      initial={reduce ? false : { opacity: 0, y: 18 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
      className="relative isolate"
    >
      {/* Full-bleed tinted band — breaks out of the column to the viewport edges. */}
      <div
        aria-hidden="true"
        style={{ left: bleed.left, width: bleed.width }}
        className="dark:from-primary/10 absolute inset-y-0 z-0 bg-gradient-to-br from-blue-100 to-violet-100 shadow-[0_10px_34px_rgba(124,58,237,0.10)] dark:to-violet-500/10"
      />

      {/* Content — stays within the column. */}
      <div className="relative z-10 py-7">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
          <SectionLabel icon={Zap} tone="accent">
            Quick Starts
          </SectionLabel>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-600 px-2.5 py-1 text-[11px] font-bold text-white shadow-sm dark:bg-violet-500">
            <Sparkles className="h-3 w-3" /> Fastest way to start
          </span>
        </div>
        <p className="text-muted-foreground mb-4 text-[13px] leading-relaxed">
          Pre-packaged, fixed-price projects you can buy in a click. Need something custom? Start a
          project and {firstName} will scope a proposal.
        </p>

        {hasPackages ? (
          <div className="flex flex-col gap-3">
            {packages.map((pkg) => (
              <PackageCard key={pkg.id} pkg={pkg} onViewDetails={handleViewDetails} />
            ))}
          </div>
        ) : (
          <div className="border-border/60 bg-card/60 flex flex-col items-start gap-3 rounded-[14px] border border-dashed p-6">
            <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-xl">
              <Briefcase className="text-muted-foreground h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-foreground text-sm font-semibold">No quick-start packages yet</p>
              <p className="text-muted-foreground mt-1 max-w-md text-[13px] leading-relaxed">
                Need something specific? Start a project and {firstName} will scope a proposal for
                the work you have in mind.
              </p>
            </div>
            <button
              type="button"
              onClick={onStartProject}
              className="border-border text-foreground hover:bg-muted focus-visible:ring-ring mt-1 inline-flex items-center gap-2 rounded-[10px] border px-4 py-2 text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              <Briefcase className="h-4 w-4" /> Start a project
            </button>
          </div>
        )}
      </div>
    </motion.div>
  );
}
