'use client';

import { useState, useTransition } from 'react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { Clock, Save } from 'lucide-react';
import { isValidMinConsultationMinutes } from '@balo/shared/pricing';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PlatformConfigAdminDTO } from '@/lib/platform-config/platform-config-admin';
import { setMinConsultationLength } from '../_actions/set-min-consultation-length';
import {
  FIELD_DESCRIPTION,
  FIELD_LABEL,
  FIELD_UNIT,
  MIN_LENGTH_ERROR,
  WHOLE_NUMBER_MESSAGE,
  successMessage,
} from '../_actions/platform-config-schema';

/**
 * PlatformConfigForm — the client surface for the admin platform-config page (BAL-398).
 * One `balo-ui` card ("Consultations") holding the single minimum-consultation-length knob,
 * built to grow (more config cards drop in beside it). Inline validation reuses the SSOT
 * `isValidMinConsultationMinutes` (bundle-safe from `@balo/shared/pricing`) so the client
 * pre-check and the server Zod refine never drift; the Server Action remains the source of
 * truth. `useTransition` pending + Sonner toast on save. The resting state IS the pre-filled
 * form (the singleton always resolves via seed/fallback), so there is no separate empty state.
 */

interface PlatformConfigFormProps {
  dto: PlatformConfigAdminDTO;
}

export function PlatformConfigForm({ dto }: Readonly<PlatformConfigFormProps>): React.JSX.Element {
  const [savedMinutes, setSavedMinutes] = useState(dto.minConsultationMinutes);
  const [value, setValue] = useState(String(dto.minConsultationMinutes));
  const [isPending, startTransition] = useTransition();

  const trimmed = value.trim();
  const parsed = Number(trimmed);
  const isValid = trimmed !== '' && isValidMinConsultationMinutes(parsed);
  const isPristine = isValid && parsed === savedMinutes;
  const showError = trimmed !== '' && !isValid;
  const canSave = isValid && !isPristine && !isPending;
  // Only the DISPLAYED reason branches — the Save gate stays `isValidMinConsultationMinutes`.
  // A non-integer (e.g. 15.5) is a whole-minute mistake; an integer that lands here is below
  // the billing floor (`< dto.billingFloorMinutes`), so it keeps the floor copy.
  const errorMessage = Number.isInteger(parsed) ? MIN_LENGTH_ERROR : WHOLE_NUMBER_MESSAGE;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSave) {
      return;
    }
    startTransition(async () => {
      const result = await setMinConsultationLength({ minutes: parsed });
      if (result.success) {
        setSavedMinutes(result.minutes);
        setValue(String(result.minutes));
        toast.success(successMessage(result.minutes));
        return;
      }
      toast.error(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <h1 className="text-foreground text-2xl font-semibold">Platform configuration</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Platform-wide settings that apply across every booking.
        </p>
      </motion.div>

      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, delay: 0.05 }}
        className="border-border bg-card max-w-xl rounded-2xl border p-6 shadow-sm"
      >
        <div className="mb-4 flex items-center gap-2">
          <Clock className="text-primary h-4 w-4" aria-hidden="true" />
          <h2 className="text-foreground text-sm font-semibold">Consultations</h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="min-consultation-minutes">
              {FIELD_LABEL}{' '}
              <span className="text-muted-foreground font-normal">({FIELD_UNIT})</span>
            </Label>
            <Input
              id="min-consultation-minutes"
              type="number"
              inputMode="numeric"
              min={dto.billingFloorMinutes}
              step={1}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="max-w-40"
              aria-invalid={showError}
              aria-describedby={showError ? 'min-consultation-error' : 'min-consultation-hint'}
            />
            {showError ? (
              <p id="min-consultation-error" className="text-destructive text-xs" role="alert">
                {errorMessage}
              </p>
            ) : (
              <p id="min-consultation-hint" className="text-muted-foreground text-xs">
                {FIELD_DESCRIPTION}
              </p>
            )}
          </div>

          <Button type="submit" disabled={!canSave}>
            <Save className="h-4 w-4" aria-hidden="true" />
            {isPending ? 'Saving…' : 'Save'}
          </Button>
        </form>
      </motion.section>
    </div>
  );
}
