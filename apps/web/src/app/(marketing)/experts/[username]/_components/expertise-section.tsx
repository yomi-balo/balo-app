'use client';

import Image from 'next/image';
import { TrendingUp, Award } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { Card } from '@/components/ui/card';
import { SectionLabel, type SkillView, type CertView } from '@/components/expert/profile';
import type { ProficiencyTone } from '@/lib/expert-profile/proficiency';
import { cn } from '@/lib/utils';

interface ExpertiseSectionProps {
  skills: SkillView[];
  certifications: CertView[];
}

const LEVEL_BADGE_CLASS: Record<ProficiencyTone, string> = {
  success: 'text-success bg-success/10 border-success/30',
  primary: 'text-primary bg-primary/10 border-primary/25',
  warning: 'text-warning bg-warning/10 border-warning/30',
  muted: 'text-muted-foreground bg-muted border-border',
};

function SkillBar({ skill }: Readonly<{ skill: SkillView }>): React.JSX.Element {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-foreground text-sm font-medium">{skill.name}</span>
        <span
          className={cn(
            'rounded-md border px-2 py-0.5 text-[11px] font-semibold',
            LEVEL_BADGE_CLASS[skill.tone]
          )}
        >
          {skill.level}
        </span>
      </div>
      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
        <div
          className="from-primary animate-bar-fill h-full rounded-full bg-gradient-to-r to-violet-600 dark:to-violet-500"
          style={{ width: `${skill.pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * "Expertise" — skill bars (one per skill, max proficiency) plus a
 * Certifications sub-block. Empty sub-blocks hide; the whole section shows an
 * empty state only when there is nothing to show.
 */
export function ExpertiseSection({
  skills,
  certifications,
}: Readonly<ExpertiseSectionProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const hasSkills = skills.length > 0;
  const hasCerts = certifications.length > 0;

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 18 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <Card className="gap-0 p-7">
        <SectionLabel icon={TrendingUp} tone="primary" className="mb-4">
          Expertise
        </SectionLabel>

        {!hasSkills && !hasCerts && (
          <p className="text-muted-foreground text-sm leading-relaxed">
            Skills and certifications will appear here once they&apos;re added.
          </p>
        )}

        {hasSkills && (
          <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
            {skills.map((skill) => (
              <SkillBar key={skill.id} skill={skill} />
            ))}
          </div>
        )}

        {hasCerts && (
          <div className={cn('border-border/60 border-t pt-6', hasSkills && 'mt-7')}>
            <SectionLabel icon={Award} tone="warning" className="mb-4">
              Salesforce Certifications
            </SectionLabel>
            <div className="flex flex-wrap gap-2">
              {certifications.map((cert) => (
                <span
                  key={cert.id}
                  className="bg-muted border-border/60 text-muted-foreground inline-flex items-center gap-1.5 rounded-[9px] border px-3 py-2 text-[13px] font-medium"
                >
                  {cert.logoUrl ? (
                    <Image
                      src={cert.logoUrl}
                      alt=""
                      width={16}
                      height={16}
                      unoptimized
                      className="h-4 w-4 rounded-sm object-contain"
                    />
                  ) : (
                    <Award className="text-warning h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {cert.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>
    </motion.div>
  );
}
