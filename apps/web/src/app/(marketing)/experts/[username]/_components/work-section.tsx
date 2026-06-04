'use client';

import { Briefcase } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { Card } from '@/components/ui/card';
import { SectionLabel, type WorkHistoryView } from '@/components/expert/profile';
import { WorkItem } from './work-item';

interface WorkSectionProps {
  workHistory: WorkHistoryView[];
  firstName: string;
}

/**
 * "Work" — a timeline of the expert's roles. The page omits this section
 * entirely (and drops it from the nav) when there's no history, so this assumes
 * `workHistory.length > 0`.
 */
export function WorkSection({
  workHistory,
  firstName,
}: Readonly<WorkSectionProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 18 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <Card className="gap-0 p-7">
        <SectionLabel icon={Briefcase} tone="accent" className="mb-4">
          Work
        </SectionLabel>
        <h3 className="text-foreground mb-5 text-[22px] font-semibold tracking-[-0.02em]">
          How {firstName} got here
        </h3>
        <div>
          {workHistory.map((item, i) => (
            <WorkItem
              key={`${item.company}-${item.role}-${i}`}
              item={item}
              isLast={i === workHistory.length - 1}
            />
          ))}
        </div>
      </Card>
    </motion.div>
  );
}
