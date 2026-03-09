'use client';

import { useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import type { NormalizedField } from '@/app/(dashboard)/expert/settings/_components/payouts-tab';

interface PayoutDynamicFormProps {
  fields: NormalizedField[];
  formValues: Record<string, string>;
  onFormValuesChange: (values: Record<string, string>) => void;
  onRefreshField: () => void;
  validationErrors: Record<string, string>;
  disabledFields?: Set<string>;
}

export function PayoutDynamicForm({
  fields,
  formValues,
  onFormValuesChange,
  onRefreshField,
  validationErrors,
  disabledFields,
}: PayoutDynamicFormProps): React.JSX.Element {
  const handleChange = useCallback(
    (path: string, value: string, refresh: boolean) => {
      const updated = { ...formValues, [path]: value };
      onFormValuesChange(updated);
      if (refresh) {
        onRefreshField();
      }
    },
    [formValues, onFormValuesChange, onRefreshField]
  );

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {fields.map((field) => {
        const isWide = field.wide || false;
        const error = validationErrors[field.path];
        const isDisabled = disabledFields?.has(field.path) ?? false;

        return (
          <div key={field.path} className={isWide ? 'sm:col-span-2' : ''}>
            <div className="mb-1.5 flex items-center gap-2">
              <Label htmlFor={field.path} className="text-sm font-medium">
                {field.label}
                {field.required && <span className="text-destructive ml-0.5">*</span>}
              </Label>
              {!field.required && (
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                  Optional
                </Badge>
              )}
              {field.refresh && (
                <RefreshCw className="text-muted-foreground h-3 w-3" aria-hidden="true" />
              )}
            </div>

            {field.type === 'enum' && field.options ? (
              <Select
                value={formValues[field.path] ?? field.defaultValue ?? ''}
                onValueChange={(val) => handleChange(field.path, val, field.refresh)}
                disabled={isDisabled}
              >
                <SelectTrigger id={field.path} className={`h-10${isDisabled ? 'bg-muted' : ''}`}>
                  <SelectValue placeholder={field.placeholder ?? `Select ${field.label}`} />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={field.path}
                value={formValues[field.path] ?? ''}
                onChange={(e) => handleChange(field.path, e.target.value, field.refresh)}
                placeholder={field.placeholder}
                disabled={isDisabled}
                className={`h-10${isDisabled ? 'bg-muted' : ''}`}
              />
            )}

            {field.description && !error && (
              <p className="text-muted-foreground mt-1 text-xs">{field.description}</p>
            )}

            {field.tip && !error && (
              <p className="text-muted-foreground mt-1 text-xs italic">{field.tip}</p>
            )}

            {error && <p className="text-destructive mt-1 text-xs">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}
