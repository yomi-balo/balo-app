'use client';

import { useEffect, useCallback, useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Search, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { productsStepSchema, type ProductsStepData } from '../_actions/schemas';
import { useWizard } from './expert-application-context';
import { ChipPicker } from './chip-picker';

interface StepProductsProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

export function StepProducts({ headingRef }: Readonly<StepProductsProps>): React.JSX.Element {
  const { productsData, referenceData, updateStepData, registerValidation } = useWizard();
  const [searchQuery, setSearchQuery] = useState('');

  const form = useForm<ProductsStepData>({
    resolver: zodResolver(productsStepSchema),
    defaultValues: {
      skillIds: productsData.skillIds ?? [],
    },
    mode: 'onSubmit',
  });

  const selectedSkillIds = form.watch('skillIds');

  // Sync form to context
  useEffect(() => {
    const subscription = form.watch((values) => {
      updateStepData('products', values);
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

  // Search filtering
  const filteredCategories = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) return referenceData.skillsByCategory;

    return referenceData.skillsByCategory
      .map((cat) => ({
        ...cat,
        skills: cat.skills.filter((s) => s.name.toLowerCase().includes(query)),
      }))
      .filter((cat) => cat.skills.length > 0);
  }, [referenceData.skillsByCategory, searchQuery]);

  // Build flat map of skill id -> name for selected pills
  const skillNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of referenceData.skillsByCategory) {
      for (const skill of cat.skills) {
        map.set(skill.id, skill.name);
      }
    }
    return map;
  }, [referenceData.skillsByCategory]);

  const removeSkill = (id: string): void => {
    const current = form.getValues('skillIds');
    form.setValue(
      'skillIds',
      current.filter((s) => s !== id),
      { shouldValidate: false }
    );
  };

  return (
    <Form {...form}>
      <form className="space-y-6">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-foreground text-xl font-semibold outline-none"
        >
          What Salesforce products do you know?
        </h2>
        <p className="text-muted-foreground -mt-2 text-sm">
          Select the products you have hands-on experience with. You&apos;ll rate your proficiency
          in the next step.
        </p>

        {/* Selected pills */}
        <AnimatePresence>
          {selectedSkillIds.length > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="flex flex-wrap gap-2"
            >
              {selectedSkillIds.map((id) => (
                <motion.div
                  key={id}
                  initial={{ y: 8, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                >
                  <Badge variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
                    {skillNameMap.get(id) ?? id}
                    <button
                      type="button"
                      onClick={() => removeSkill(id)}
                      className="hover:text-foreground"
                      aria-label={`Remove ${skillNameMap.get(id) ?? 'product'}`}
                    >
                      <X className="h-3 w-3" aria-hidden="true" />
                    </button>
                  </Badge>
                </motion.div>
              ))}
              <p className="text-muted-foreground mt-1 w-full text-xs">
                {selectedSkillIds.length} product
                {selectedSkillIds.length === 1 ? '' : 's'} selected
              </p>
              {selectedSkillIds.length >= 5 && (
                <p className="text-success w-full text-xs">Great coverage!</p>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Search */}
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            placeholder="Search products... e.g. Sales Cloud, CPQ"
            className="pl-9 text-base"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            autoFocus
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-3 -translate-y-1/2"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Hint */}
        <p className="text-muted-foreground text-xs italic">
          Most experts select 3&ndash;8 products. Select all that genuinely apply.
        </p>

        {/* Categories */}
        <FormField
          control={form.control}
          name="skillIds"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <div className="space-y-6">
                  {filteredCategories.length === 0 && (
                    <p className="text-muted-foreground py-8 text-center text-sm">
                      No products match your search
                    </p>
                  )}
                  {filteredCategories.map((cat) => (
                    <AnimatePresence key={cat.category.id}>
                      <motion.div
                        initial={{ opacity: 1 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.2 }}
                      >
                        <p className="text-muted-foreground mb-3 text-xs font-semibold tracking-wider uppercase">
                          {cat.category.name}
                        </p>
                        <ChipPicker
                          options={cat.skills.map((s) => ({
                            id: s.id,
                            label: s.name,
                          }))}
                          selected={field.value}
                          onChange={field.onChange}
                        />
                      </motion.div>
                    </AnimatePresence>
                  ))}
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </form>
    </Form>
  );
}
