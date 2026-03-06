'use client';

import { useEffect, useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Wrench, Building2, Compass, GraduationCap } from 'lucide-react';
import { motion } from 'motion/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { assessmentStepSchema, type AssessmentStepData } from '../_actions/schemas';
import { useWizard } from './expert-application-context';
import { AssessmentCard } from './assessment-card';
import { StepHeading, slideUpVariant, stagger } from './design-system';

const DIMENSION_EXPLANATION = [
  {
    icon: Wrench,
    label: 'Technical Fix',
    description: 'Solving specific bugs, errors, and configuration issues',
  },
  {
    icon: Building2,
    label: 'Architecture',
    description: 'Designing systems, data models, and integrations',
  },
  {
    icon: Compass,
    label: 'Strategy',
    description: 'Advising on roadmap, best practices, and business alignment',
  },
  {
    icon: GraduationCap,
    label: 'Training',
    description: 'Teaching teams, creating documentation, enablement',
  },
] as const;

interface StepAssessmentProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

export function StepAssessment({ headingRef }: Readonly<StepAssessmentProps>): React.JSX.Element {
  const { assessmentData, productsData, referenceData, updateStepData, registerValidation } =
    useWizard();

  const [guideOpen, setGuideOpen] = useState(true);

  const form = useForm<AssessmentStepData>({
    resolver: zodResolver(assessmentStepSchema),
    defaultValues: {
      ratings: assessmentData.ratings ?? [],
    },
    mode: 'onSubmit',
  });

  // Build a map of skill ID -> name
  const skillNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of referenceData.skillsByCategory) {
      for (const skill of cat.skills) {
        map.set(skill.id, skill.name);
      }
    }
    return map;
  }, [referenceData.skillsByCategory]);

  // Get selected skill IDs from productsData
  const selectedSkillIds = useMemo(() => productsData.skillIds ?? [], [productsData.skillIds]);

  const supportTypes = referenceData.supportTypes;

  // Current ratings
  const ratings = form.watch('ratings');

  // Ensure every selected skill has a rating row for each support type
  useEffect(() => {
    const currentRatings = form.getValues('ratings');
    const existingKeys = new Set(currentRatings.map((r) => `${r.skillId}:${r.supportTypeId}`));

    const newRatings = [...currentRatings];
    let changed = false;

    for (const skillId of selectedSkillIds) {
      for (const st of supportTypes) {
        const key = `${skillId}:${st.id}`;
        if (!existingKeys.has(key)) {
          newRatings.push({
            skillId,
            supportTypeId: st.id,
            proficiency: 0,
          });
          changed = true;
        }
      }
    }

    // Remove ratings for skills no longer selected
    const filteredRatings = newRatings.filter((r) => selectedSkillIds.includes(r.skillId));
    if (filteredRatings.length !== newRatings.length) changed = true;

    if (changed) {
      form.setValue('ratings', filteredRatings, { shouldDirty: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSkillIds, supportTypes]);

  // Sync form to context
  useEffect(() => {
    const subscription = form.watch((values) => {
      updateStepData('assessment', values);
    });
    return () => subscription.unsubscribe();
  }, [form, updateStepData]);

  // Register validation
  const validate = useCallback(async (): Promise<boolean> => {
    return form.trigger();
  }, [form]);

  useEffect(() => {
    registerValidation(validate);
  }, [registerValidation, validate]);

  // Handle dimension change
  const handleChange = useCallback(
    (skillId: string, supportTypeId: string, value: number): void => {
      const currentRatings = form.getValues('ratings');
      const updated = currentRatings.map((r) =>
        r.skillId === skillId && r.supportTypeId === supportTypeId
          ? { ...r, proficiency: value }
          : r
      );
      form.setValue('ratings', updated, { shouldDirty: true });
    },
    [form]
  );

  // Check completion per skill
  const isSkillComplete = useCallback(
    (skillId: string): boolean => {
      const skillRatings = ratings.filter((r) => r.skillId === skillId);
      return skillRatings.some((r) => r.proficiency > 0);
    },
    [ratings]
  );

  const completedCount = selectedSkillIds.filter((id) => isSkillComplete(id)).length;
  const allComplete = completedCount === selectedSkillIds.length && selectedSkillIds.length > 0;

  return (
    <Form {...form}>
      <form className="space-y-6">
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <StepHeading
            icon={Wrench}
            title="Rate your expertise"
            subtitle="For each product, rate your ability across 4 support dimensions. Be honest -- clients rely on these ratings to find the right match."
          />
        </div>

        {/* Dimension explanation */}
        <Collapsible open={guideOpen} onOpenChange={setGuideOpen}>
          <div className="bg-muted/40 dark:bg-muted/20 border-border/50 rounded-xl border p-5">
            <div className="flex items-center justify-between">
              <p className="text-foreground text-sm font-semibold">The 4 dimensions</p>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm">
                  {guideOpen ? 'Hide' : 'Show guide'}
                </Button>
              </CollapsibleTrigger>
            </div>
            <CollapsibleContent>
              <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {DIMENSION_EXPLANATION.map((dim) => (
                  <div key={dim.label} className="flex items-start gap-2">
                    <dim.icon
                      className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    <div>
                      <span className="text-sm font-medium">{dim.label}</span>
                      <p className="text-muted-foreground text-xs">{dim.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>

        {/* Progress counter */}
        <div className="bg-muted rounded-lg px-4 py-2.5">
          <p className="text-foreground text-sm font-medium">
            {completedCount} of {selectedSkillIds.length} products assessed
          </p>
        </div>

        {/* Assessment cards */}
        <div className="space-y-3">
          {selectedSkillIds.map((skillId, index) => {
            const dimensions = supportTypes.map((st) => {
              const rating = ratings.find(
                (r) => r.skillId === skillId && r.supportTypeId === st.id
              );
              return {
                supportTypeId: st.id,
                name: st.name,
                slug: st.slug,
                proficiency: rating?.proficiency ?? 0,
              };
            });

            return (
              <motion.div
                key={skillId}
                initial={slideUpVariant.initial}
                animate={slideUpVariant.animate}
                transition={{ ...slideUpVariant.transition, ...stagger(index).transition }}
              >
                <AssessmentCard
                  skillId={skillId}
                  skillName={skillNameMap.get(skillId) ?? skillId}
                  dimensions={dimensions}
                  onChange={handleChange}
                  isComplete={isSkillComplete(skillId)}
                />
              </motion.div>
            );
          })}
        </div>

        {allComplete && (
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-success text-sm"
          >
            All products rated! You&apos;re making great progress.
          </motion.p>
        )}

        <p className="text-muted-foreground text-xs">
          Your self-assessment helps us match you with the right clients. You can update these
          ratings later.
        </p>

        {form.formState.errors.ratings?.message && (
          <p className="text-destructive text-sm">{form.formState.errors.ratings.message}</p>
        )}
      </form>
    </Form>
  );
}
