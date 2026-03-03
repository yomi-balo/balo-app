'use client';

import { forwardRef, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { InputFloating } from '@/components/enhanced/input-floating';
import { ShimmerButton } from '@/components/magicui/shimmer-button';
import { updateNameAction } from '@/lib/auth/actions';
import { track, ONBOARDING_EVENTS } from '@/lib/analytics';

const nameSchema = z.object({
  firstName: z.string().min(1, 'First name is required').max(50, 'First name is too long'),
  lastName: z.string().min(1, 'Last name is required').max(50, 'Last name is too long'),
});

type NameFormData = z.infer<typeof nameSchema>;

interface NameStepProps {
  onContinue: (data: { firstName: string; lastName: string }) => void;
}

export const NameStep = forwardRef<HTMLHeadingElement, NameStepProps>(function NameStep(
  { onContinue },
  ref
) {
  useEffect(() => {
    track(ONBOARDING_EVENTS.STEP_VIEWED, { step: 'name', step_number: 1 });
  }, []);

  const form = useForm<NameFormData>({
    resolver: zodResolver(nameSchema),
    defaultValues: { firstName: '', lastName: '' },
  });

  const { isSubmitting } = form.formState;

  const onSubmit = async (data: NameFormData): Promise<void> => {
    try {
      const result = await updateNameAction(data);
      if (result.success) {
        track(ONBOARDING_EVENTS.STEP_COMPLETED, { step: 'name', step_number: 1 });
        onContinue(data);
      } else {
        toast.error(result.error);
      }
    } catch {
      toast.error('Something went wrong. Please try again.');
    }
  };

  return (
    <div className="flex flex-col items-center text-center">
      <h1
        ref={ref}
        tabIndex={-1}
        className="text-foreground text-2xl font-semibold outline-none sm:text-3xl"
      >
        What should we call you?
      </h1>

      <p className="text-muted-foreground mt-4 max-w-md text-base leading-relaxed">
        Your name helps consultants and clients recognize you on the platform.
      </p>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="mt-8 w-full max-w-sm space-y-4">
          <FormField
            control={form.control}
            name="firstName"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <InputFloating
                    label="First name"
                    autoComplete="given-name"
                    autoFocus
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="lastName"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <InputFloating label="Last name" autoComplete="family-name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <ShimmerButton
            type="submit"
            disabled={isSubmitting}
            className="h-11 w-full rounded-lg text-sm font-medium"
            shimmerColor="rgba(255, 255, 255, 0.15)"
            background="var(--primary)"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              'Continue'
            )}
          </ShimmerButton>
        </form>
      </Form>
    </div>
  );
});
