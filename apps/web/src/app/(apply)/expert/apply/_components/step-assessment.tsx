'use client';

import { useEffect, useCallback, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Wrench, Building2, Compass, GraduationCap } from 'lucide-react';
import { motion } from 'motion/react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';
import { Form } from '@/components/ui/form';
import { track, EXPERT_EVENTS } from '@/lib/analytics';
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

// ── Accordion helpers (module scope keeps the component's cognitive complexity low) ──

type RatingRow = { productId: string; supportTypeId: string; proficiency: number };

function productHasRating(ratings: RatingRow[], productId: string): boolean {
  return ratings.some((r) => r.productId === productId && r.proficiency > 0);
}

// First incomplete in list order (mount auto-expand). null → nothing to open.
function findFirstIncomplete(productIds: string[], ratings: RatingRow[]): string | null {
  for (const id of productIds) {
    if (!productHasRating(ratings, id)) return id;
  }
  return null;
}

// Next incomplete AFTER current index, wrapping to the start; never returns
// currentId. null → no other incomplete product anywhere.
function findNextIncomplete(
  productIds: string[],
  ratings: RatingRow[],
  currentId: string
): string | null {
  const n = productIds.length;
  const currentIndex = productIds.indexOf(currentId);
  if (currentIndex === -1) return findFirstIncomplete(productIds, ratings);
  for (let offset = 1; offset <= n; offset++) {
    const candidate = productIds[(currentIndex + offset) % n];
    if (candidate === undefined || candidate === currentId) continue; // offset===n wraps to self
    if (!productHasRating(ratings, candidate)) return candidate;
  }
  return null;
}

interface StepAssessmentProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

export function StepAssessment({ headingRef }: Readonly<StepAssessmentProps>): React.JSX.Element {
  const { assessmentData, productsData, referenceData, updateStepData, registerValidation } =
    useWizard();

  const [guideOpen, setGuideOpen] = useState(true);

  // Single-open accordion: one product expanded at a time (null = all collapsed).
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  // Product whose Done was clicked while still unrated → shows the inline hint.
  const [doneBlockedProductId, setDoneBlockedProductId] = useState<string | null>(null);
  const headerRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingFocusRef = useRef<string | null>(null);

  const form = useForm<AssessmentStepData>({
    resolver: zodResolver(assessmentStepSchema),
    defaultValues: {
      ratings: assessmentData.ratings ?? [],
    },
    mode: 'onSubmit',
  });

  // Build a map of product ID -> name
  const productNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of referenceData.productsByCategory) {
      for (const product of cat.products) {
        map.set(product.id, product.name);
      }
    }
    return map;
  }, [referenceData.productsByCategory]);

  // Get selected product IDs from productsData
  const selectedProductIds = useMemo(
    () => productsData.productIds ?? [],
    [productsData.productIds]
  );

  const supportTypes = referenceData.supportTypes;

  // Current ratings
  const ratings = form.watch('ratings');

  // Ensure every selected product has a rating row for each support type
  useEffect(() => {
    const currentRatings = form.getValues('ratings');
    const existingKeys = new Set(currentRatings.map((r) => `${r.productId}:${r.supportTypeId}`));

    const newRatings = [...currentRatings];
    let changed = false;

    for (const productId of selectedProductIds) {
      for (const st of supportTypes) {
        const key = `${productId}:${st.id}`;
        if (!existingKeys.has(key)) {
          newRatings.push({
            productId,
            supportTypeId: st.id,
            proficiency: 0,
          });
          changed = true;
        }
      }
    }

    // Remove ratings for products no longer selected
    const filteredRatings = newRatings.filter((r) => selectedProductIds.includes(r.productId));
    if (filteredRatings.length !== newRatings.length) changed = true;

    if (changed) {
      form.setValue('ratings', filteredRatings, { shouldDirty: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProductIds, supportTypes]);

  // Sync form to context
  useEffect(() => {
    const subscription = form.watch((values) => {
      updateStepData('assessment', values);
    });
    return () => subscription.unsubscribe();
  }, [form, updateStepData]);

  // Clear the blocked-Done hint as soon as the offending product gets any rating.
  useEffect(() => {
    if (doneBlockedProductId !== null && productHasRating(ratings, doneBlockedProductId)) {
      setDoneBlockedProductId(null);
    }
  }, [ratings, doneBlockedProductId]);

  // Register validation
  const validate = useCallback(async (): Promise<boolean> => {
    return form.trigger();
  }, [form]);

  useEffect(() => {
    registerValidation(validate);
  }, [registerValidation, validate]);

  // Handle dimension change
  const handleChange = useCallback(
    (productId: string, supportTypeId: string, value: number): void => {
      const currentRatings = form.getValues('ratings');
      const updated = currentRatings.map((r) =>
        r.productId === productId && r.supportTypeId === supportTypeId
          ? { ...r, proficiency: value }
          : r
      );
      form.setValue('ratings', updated, { shouldDirty: true });
    },
    [form]
  );

  // Check completion per product (single source of truth: shared predicate)
  const isProductComplete = useCallback(
    (productId: string): boolean => productHasRating(ratings, productId),
    [ratings]
  );

  // Register/unregister each card's header button so the parent can move focus.
  const registerHeaderButton = useCallback(
    (productId: string, el: HTMLButtonElement | null): void => {
      if (el) headerRefs.current.set(productId, el);
      else headerRefs.current.delete(productId);
    },
    []
  );

  // Mount-only auto-expand: open the first incomplete product on step entry
  // (incl. resume). StepAssessment mounts fresh per entry via AnimatePresence,
  // so an empty-dependency effect == "on step entry". Reads freshest values.
  useEffect(() => {
    const first = findFirstIncomplete(selectedProductIds, form.getValues('ratings'));
    setExpandedProductId(first); // null when zero products or all already complete
    // Intentionally mount-only: "first incomplete on step entry (incl. resume)".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Manual header click — single-open toggle. No focus request (the click already
  // focused the button), so auto-advance never overrides a manual choice.
  const handleToggle = useCallback((productId: string): void => {
    setExpandedProductId((prev) => (prev === productId ? null : productId));
    setDoneBlockedProductId(null); // toggling/collapsing clears the hint
  }, []);

  // "Done" — collapse current, advance to the next incomplete (wrapping, never
  // current), and request focus on its header. Reads live ratings so rapid
  // Done clicks never use a stale index.
  const handleDone = useCallback(
    (productId: string): void => {
      const currentRatings = form.getValues('ratings');
      // Gate: Done on an unrated product renders inline feedback instead of
      // collapsing/advancing. Focus stays on the Done button (no focus move).
      if (!productHasRating(currentRatings, productId)) {
        setDoneBlockedProductId(productId);
        track(EXPERT_EVENTS.ASSESSMENT_DONE_BLOCKED, { product_id: productId });
        return;
      }
      setDoneBlockedProductId(null); // successful Done clears any prior hint
      const next = findNextIncomplete(selectedProductIds, currentRatings, productId);
      setExpandedProductId(next);
      // Always request focus: the next incomplete header, or (terminal Done, no
      // next) fall back to the just-completed card's own still-mounted header so
      // keyboard focus never drops to <body> at the finish line.
      pendingFocusRef.current = next ?? productId;
    },
    [selectedProductIds, form]
  );

  // Post-commit focus: after a Done-advance commits the expansion, move focus to
  // the newly-opened header exactly once, then scroll it into view so a header
  // below the fold (6-8 products) follows the focus for sighted keyboard users.
  // Early-returns on mount + manual toggles.
  useEffect(() => {
    const target = pendingFocusRef.current;
    if (target === null) return; // no pending advance → do nothing
    const headerEl = headerRefs.current.get(target);
    headerEl?.focus({ preventScroll: true }); // preventScroll avoids the abrupt browser focus-scroll
    headerEl?.scrollIntoView({ block: 'nearest' }); // instant, minimal scroll — no reduced-motion gating needed
    pendingFocusRef.current = null; // clear → no refocus loop
  }, [expandedProductId]);

  const completedCount = selectedProductIds.filter((id) => isProductComplete(id)).length;
  const allComplete = completedCount === selectedProductIds.length && selectedProductIds.length > 0;

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
            {completedCount} of {selectedProductIds.length} products assessed
          </p>
        </div>

        {/* Assessment cards */}
        <div className="space-y-3">
          {selectedProductIds.map((productId, index) => {
            const dimensions = supportTypes.map((st) => {
              const rating = ratings.find(
                (r) => r.productId === productId && r.supportTypeId === st.id
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
                key={productId}
                initial={slideUpVariant.initial}
                animate={slideUpVariant.animate}
                transition={{ ...slideUpVariant.transition, ...stagger(index).transition }}
              >
                <AssessmentCard
                  productId={productId}
                  productName={productNameMap.get(productId) ?? productId}
                  dimensions={dimensions}
                  onChange={handleChange}
                  isComplete={isProductComplete(productId)}
                  expanded={expandedProductId === productId}
                  onToggle={handleToggle}
                  onDone={handleDone}
                  showRatingHint={doneBlockedProductId === productId}
                  registerHeaderButton={registerHeaderButton}
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
