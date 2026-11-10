'use client';

import { useCallback } from 'react';
import { Check, Wrench, Building2, Compass, GraduationCap } from 'lucide-react';
import { proficiencyScaleLevel } from '@balo/shared/experts';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SegmentedSlider } from '@/components/balo/segmented-slider';
import { cn } from '@/lib/utils';

// ── Types ────────────────────────────────────────────────────────

interface DimensionRating {
  supportTypeId: string;
  name: string;
  slug: string;
  proficiency: number;
}

interface AssessmentCardProps {
  productId: string;
  productName: string;
  dimensions: DimensionRating[];
  onChange: (productId: string, supportTypeId: string, value: number) => void;
  isComplete: boolean;
  expanded: boolean;
  onToggle: (productId: string) => void;
  onDone: (productId: string) => void;
  showRatingHint: boolean;
  registerHeaderButton: (productId: string, el: HTMLButtonElement | null) => void;
}

// ── Helpers ──────────────────────────────────────────────────────

const DIMENSION_ICONS: Record<string, typeof Wrench> = {
  'technical-fix': Wrench,
  architecture: Building2,
  strategy: Compass,
  training: GraduationCap,
};

// ── Component ────────────────────────────────────────────────────

export function AssessmentCard({
  productId,
  productName,
  dimensions,
  onChange,
  isComplete,
  expanded,
  onToggle,
  onDone,
  showRatingHint,
  registerHeaderButton,
}: Readonly<AssessmentCardProps>): React.JSX.Element {
  const reduce = useReducedMotion();

  const setHeaderRef = useCallback(
    (el: HTMLButtonElement | null) => registerHeaderButton(productId, el),
    [productId, registerHeaderButton]
  );

  return (
    <motion.div
      layout={!reduce}
      className={cn(
        'rounded-xl border transition-colors duration-200',
        expanded && 'border-primary/50',
        !expanded && isComplete && 'border-success/30 border-l-success border-l-2',
        !expanded && !isComplete && 'border-border hover:border-primary/30 cursor-pointer'
      )}
    >
      <button
        ref={setHeaderRef}
        type="button"
        className="focus-visible:border-ring focus-visible:ring-ring/50 flex w-full items-center justify-between rounded-xl p-4 outline-none focus-visible:ring-[3px]"
        onClick={() => onToggle(productId)}
        aria-expanded={expanded}
      >
        <span className="text-foreground text-sm font-semibold">{productName}</span>
        <Badge
          variant="outline"
          className={cn(
            'text-xs',
            isComplete
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-warning/30 bg-warning/10 text-warning'
          )}
        >
          {isComplete ? 'Completed' : 'To assess'}
        </Badge>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: reduce ? 0.12 : 0.3, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-1 px-4 pb-4">
              {dimensions.map((dim) => {
                const Icon = DIMENSION_ICONS[dim.slug] ?? Wrench;
                const { title, description } = proficiencyScaleLevel(dim.proficiency);
                const sliderLabel = `${dim.name} proficiency for ${productName}`;
                return (
                  <div
                    key={dim.supportTypeId}
                    className="border-border/50 border-b py-3 last:border-b-0"
                  >
                    <div className="sm:grid sm:grid-cols-[130px_minmax(0,1fr)_24px_128px] sm:items-center sm:gap-x-4">
                      <div className="flex items-center gap-2">
                        <Icon className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                        <span className="text-foreground text-sm font-medium">{dim.name}</span>
                      </div>
                      <div className="mt-2 min-w-0 sm:mt-0">
                        <SegmentedSlider
                          value={dim.proficiency}
                          onValueChange={(v) => onChange(productId, dim.supportTypeId, v)}
                          aria-label={sliderLabel}
                          aria-valuetext={`${dim.proficiency}, ${title}: ${description}`}
                        />
                      </div>
                      <div className="mt-1.5 flex items-baseline justify-end gap-2 sm:mt-0 sm:contents">
                        <span className="text-foreground font-mono text-sm font-semibold tabular-nums sm:text-right">
                          {dim.proficiency}
                        </span>
                        <span className="text-muted-foreground text-xs font-medium sm:text-right">
                          {title}
                        </span>
                      </div>
                    </div>
                    <p
                      className={cn(
                        'mt-1.5 text-xs leading-snug sm:ml-[146px]',
                        dim.proficiency === 0 ? 'text-muted-foreground/70' : 'text-muted-foreground'
                      )}
                    >
                      {description}
                    </p>
                  </div>
                );
              })}
              <div className="flex items-center gap-3 pt-2">
                <Button type="button" variant="outline" size="sm" onClick={() => onDone(productId)}>
                  <Check className="mr-1 h-4 w-4" aria-hidden="true" />
                  Done
                </Button>
                <output className="text-destructive/90 block text-xs">
                  {showRatingHint ? 'Rate at least one dimension first' : ''}
                </output>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
