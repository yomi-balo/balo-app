'use client';

import { useState } from 'react';
import { Check, Wrench, Building2, Compass, GraduationCap } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

// ── Types ────────────────────────────────────────────────────────

interface DimensionRating {
  supportTypeId: string;
  name: string;
  slug: string;
  proficiency: number;
}

interface AssessmentCardProps {
  skillId: string;
  skillName: string;
  dimensions: DimensionRating[];
  onChange: (skillId: string, supportTypeId: string, value: number) => void;
  isComplete: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────

const DIMENSION_ICONS: Record<string, typeof Wrench> = {
  'technical-fix': Wrench,
  architecture: Building2,
  strategy: Compass,
  training: GraduationCap,
};

function getProficiencyLabel(value: number): { label: string; className: string } {
  if (value === 0) return { label: 'None', className: 'text-muted-foreground' };
  if (value <= 3) return { label: 'Beginner', className: 'text-muted-foreground' };
  if (value <= 6) return { label: 'Intermediate', className: 'text-warning' };
  if (value <= 8) return { label: 'Advanced', className: 'text-primary' };
  return { label: 'Expert', className: 'text-success' };
}

// ── Component ────────────────────────────────────────────────────

export function AssessmentCard({
  skillId,
  skillName,
  dimensions,
  onChange,
  isComplete,
}: Readonly<AssessmentCardProps>): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <motion.div
      layout
      className={cn(
        'rounded-xl border transition-colors duration-200',
        expanded && 'border-primary/50',
        !expanded && isComplete && 'border-success/30 border-l-success border-l-2',
        !expanded && !isComplete && 'border-border hover:border-primary/30 cursor-pointer'
      )}
    >
      <button
        type="button"
        className="flex w-full items-center justify-between p-4"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <span className="text-foreground text-sm font-semibold">{skillName}</span>
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
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-1 px-4 pb-4">
              {dimensions.map((dim) => {
                const Icon = DIMENSION_ICONS[dim.slug] ?? Wrench;
                const { label, className: labelClass } = getProficiencyLabel(dim.proficiency);
                return (
                  <div key={dim.supportTypeId}>
                    {/* Desktop layout */}
                    <div className="border-border/50 hidden items-center gap-4 border-b py-3 last:border-b-0 sm:flex">
                      <div className="flex w-[130px] shrink-0 items-center gap-2">
                        <Icon className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                        <span className="text-foreground text-sm font-medium">{dim.name}</span>
                      </div>
                      <Slider
                        min={0}
                        max={10}
                        step={1}
                        value={[dim.proficiency]}
                        onValueChange={([v]) => onChange(skillId, dim.supportTypeId, v ?? 0)}
                        className="flex-1"
                        aria-label={`${dim.name} proficiency for ${skillName}`}
                      />
                      <span className="text-foreground w-6 text-right font-mono text-sm tabular-nums">
                        {dim.proficiency}
                      </span>
                      <AnimatePresence mode="wait">
                        <motion.span
                          key={label}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.1 }}
                          className={cn('w-[80px] text-right text-xs', labelClass)}
                        >
                          {label}
                        </motion.span>
                      </AnimatePresence>
                    </div>

                    {/* Mobile layout */}
                    <div className="border-border/50 space-y-2 border-b py-3 last:border-b-0 sm:hidden">
                      <div className="flex items-center gap-2">
                        <Icon className="text-muted-foreground h-4 w-4" aria-hidden="true" />
                        <span className="text-foreground text-sm font-medium">{dim.name}</span>
                      </div>
                      <Slider
                        min={0}
                        max={10}
                        step={1}
                        value={[dim.proficiency]}
                        onValueChange={([v]) => onChange(skillId, dim.supportTypeId, v ?? 0)}
                        aria-label={`${dim.name} proficiency for ${skillName}`}
                      />
                      <div className="flex justify-end gap-2">
                        <span className="text-foreground font-mono text-sm tabular-nums">
                          {dim.proficiency}
                        </span>
                        <span className={cn('text-xs', labelClass)}>{label}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setExpanded(false)}
                >
                  <Check className="mr-1 h-4 w-4" aria-hidden="true" />
                  Done
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
