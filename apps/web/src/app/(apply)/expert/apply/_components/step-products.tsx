'use client';

import { useEffect, useCallback, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Sparkles } from 'lucide-react';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { TaxonomyMultiSelect } from '@/components/balo/taxonomy-multi-select';
import { mapProductsByCategoryToTaxonomy, buildProductNameMap } from '@/lib/search/taxonomy';
import { productsStepSchema, type ProductsStepData } from '../_actions/schemas';
import { useWizard } from './expert-application-context';
import { StepHeading } from './design-system';

interface StepProductsProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

export function StepProducts({ headingRef }: Readonly<StepProductsProps>): React.JSX.Element {
  const { productsData, referenceData, updateStepData, registerValidation } = useWizard();

  const form = useForm<ProductsStepData>({
    resolver: zodResolver(productsStepSchema),
    defaultValues: {
      productIds: productsData.productIds ?? [],
    },
    mode: 'onSubmit',
  });

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

  // Shared taxonomy + id→name map. Same repo source as the project-request panel
  // (`referenceDataRepository.getProductsByVertical`), mapped through the one
  // shared client mapper — single product source of truth.
  const taxonomy = useMemo(
    () => mapProductsByCategoryToTaxonomy(referenceData.productsByCategory),
    [referenceData.productsByCategory]
  );
  const nameMap = useMemo(() => buildProductNameMap(taxonomy), [taxonomy]);

  return (
    <Form {...form}>
      <form className="space-y-6">
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <StepHeading
            icon={Sparkles}
            iconColor="text-violet-600"
            iconBg="bg-violet-100 dark:bg-violet-950/30"
            iconBorder="border-violet-200 dark:border-violet-800"
            title="Products & Skills"
            subtitle="Select the Salesforce products you work with."
          />
        </div>

        {/* Hint */}
        <p className="text-muted-foreground text-xs italic">
          Most experts select 3&ndash;8 products. Select all that genuinely apply.
        </p>

        <FormField
          control={form.control}
          name="productIds"
          render={({ field }) => {
            const selectedIds = new Set(field.value);
            return (
              <FormItem>
                <FormControl>
                  <TaxonomyMultiSelect
                    taxonomy={taxonomy}
                    selectedIds={selectedIds}
                    nameMap={nameMap}
                    onToggle={(id) =>
                      field.onChange(
                        selectedIds.has(id)
                          ? field.value.filter((p) => p !== id)
                          : [...field.value, id]
                      )
                    }
                    onClear={() => field.onChange([])}
                    fieldId="apply-products"
                    searchPlaceholder="Search products… e.g. Sales Cloud, CPQ"
                    emptyCopy="Products couldn't load right now."
                    errorCopy="Couldn't load products. Please refresh and try again."
                    noMatchNoun="products"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            );
          }}
        />
      </form>
    </Form>
  );
}
