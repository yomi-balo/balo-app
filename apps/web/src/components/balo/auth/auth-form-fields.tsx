'use client';

import { useFormContext } from 'react-hook-form';
import { FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { InputFloating } from '@/components/enhanced/input-floating';
import { InputPassword } from '@/components/enhanced/input-password';

export function AuthEmailField(): React.JSX.Element {
  const {
    control,
    formState: { isSubmitting },
  } = useFormContext();

  return (
    <FormField
      control={control}
      name="email"
      render={({ field, fieldState }) => (
        <FormItem>
          <FormControl>
            <InputFloating
              label="Email address"
              type="email"
              error={!!fieldState.error}
              disabled={isSubmitting}
              autoComplete="email"
              {...field}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

interface AuthPasswordFieldProps {
  showStrength?: boolean;
  autoComplete?: string;
}

export function AuthPasswordField({
  showStrength,
  autoComplete = 'current-password',
}: AuthPasswordFieldProps): React.JSX.Element {
  const {
    control,
    formState: { isSubmitting },
  } = useFormContext();

  return (
    <FormField
      control={control}
      name="password"
      render={({ field, fieldState }) => (
        <FormItem>
          <FormControl>
            <InputPassword
              label="Password"
              error={!!fieldState.error}
              disabled={isSubmitting}
              showStrength={showStrength}
              autoComplete={autoComplete}
              {...field}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
