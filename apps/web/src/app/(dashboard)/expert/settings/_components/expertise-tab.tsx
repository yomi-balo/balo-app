'use client';

import { Lock, Shield, AlertCircle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ApplicationSkillWithRelations } from '@balo/db';

interface ExpertiseTabProps {
  skills: ApplicationSkillWithRelations[];
  skillsLocked: boolean;
}

// Group skills by product (skill.skill.name) and aggregate support types
interface SkillGroup {
  skillName: string;
  supportTypes: Array<{ name: string; proficiency: number }>;
}

function groupSkills(skills: ApplicationSkillWithRelations[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();

  for (const skill of skills) {
    const key = skill.skillId;
    if (!groups.has(key)) {
      groups.set(key, {
        skillName: skill.skill.name,
        supportTypes: [],
      });
    }
    groups.get(key)!.supportTypes.push({
      name: skill.supportType.name,
      proficiency: skill.proficiency,
    });
  }

  return Array.from(groups.values());
}

const SKILL_COLORS = [
  {
    text: 'text-blue-600 dark:text-blue-400',
    bg: 'bg-blue-600/10 dark:bg-blue-400/10',
    border: 'border-blue-600/30 dark:border-blue-400/30',
    bar: 'bg-blue-600/60 dark:bg-blue-400/60',
  },
  {
    text: 'text-teal-600 dark:text-teal-400',
    bg: 'bg-teal-600/10 dark:bg-teal-400/10',
    border: 'border-teal-600/30 dark:border-teal-400/30',
    bar: 'bg-teal-600/60 dark:bg-teal-400/60',
  },
  {
    text: 'text-violet-600 dark:text-violet-400',
    bg: 'bg-violet-600/10 dark:bg-violet-400/10',
    border: 'border-violet-600/30 dark:border-violet-400/30',
    bar: 'bg-violet-600/60 dark:bg-violet-400/60',
  },
  {
    text: 'text-amber-600 dark:text-amber-400',
    bg: 'bg-amber-600/10 dark:bg-amber-400/10',
    border: 'border-amber-600/30 dark:border-amber-400/30',
    bar: 'bg-amber-600/60 dark:bg-amber-400/60',
  },
  {
    text: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-600/10 dark:bg-emerald-400/10',
    border: 'border-emerald-600/30 dark:border-emerald-400/30',
    bar: 'bg-emerald-600/60 dark:bg-emerald-400/60',
  },
];

export function ExpertiseTab({
  skills,
  skillsLocked,
}: Readonly<ExpertiseTabProps>): React.JSX.Element {
  const skillGroups = groupSkills(skills);

  return (
    <div>
      {/* Locked banner */}
      {skillsLocked && (
        <div className="bg-warning/10 border-warning/30 mb-6 flex items-start gap-3 rounded-xl border p-4">
          <Lock className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="text-warning text-[13px] font-semibold">
              Expertise is locked after approval
            </p>
            <p className="text-warning/80 mt-1 text-xs">
              Your skills and certifications were verified by Balo during onboarding. To request
              changes,{' '}
              <a href="mailto:support@balo.expert" className="font-semibold underline">
                contact support
              </a>
              .
            </p>
          </div>
        </div>
      )}

      {/* Skill cards */}
      {skillGroups.length === 0 ? (
        <div className="border-border rounded-xl border-2 border-dashed p-12 text-center">
          <Shield className="text-muted-foreground mx-auto mb-3 h-8 w-8" />
          <p className="text-muted-foreground text-sm">No skills have been assessed yet.</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          {skillGroups.map(({ skillName, supportTypes }, groupIndex) => {
            const color = SKILL_COLORS[groupIndex % SKILL_COLORS.length]!;
            return (
              <Card key={skillName} className={cn('p-5', skillsLocked && 'opacity-80')}>
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        'flex h-7 w-7 items-center justify-center rounded-lg border',
                        color.bg,
                        color.border
                      )}
                    >
                      <Shield className={cn('h-[13px] w-[13px]', color.text)} aria-hidden="true" />
                    </div>
                    <span className="text-foreground text-sm font-semibold">{skillName}</span>
                  </div>
                  {skillsLocked && (
                    <span className="bg-warning/10 text-warning border-warning/30 rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase">
                      Locked
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {supportTypes.map(({ name, proficiency }) => (
                    <div key={name}>
                      <div className="mb-1 flex justify-between">
                        <span className="text-muted-foreground text-[10px]">{name}</span>
                        <span className="text-muted-foreground text-[10px] font-semibold">
                          {proficiency}/10
                        </span>
                      </div>
                      <div className="bg-muted h-1 overflow-hidden rounded-full">
                        <div
                          className={cn('h-full rounded-full', color.bar)}
                          style={{
                            width: `${(proficiency / 10) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Request changes button */}
      <div className="mt-5 text-center">
        <Button variant="outline" asChild>
          <a href="mailto:support@balo.expert">
            <AlertCircle className="mr-2 h-4 w-4" />
            Request changes to expertise
          </a>
        </Button>
      </div>
    </div>
  );
}
