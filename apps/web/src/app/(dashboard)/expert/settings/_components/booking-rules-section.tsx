'use client';

import { useCallback } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsEyebrow } from './settings-card';
import { BUFFER_OPTIONS, NOTICE_OPTIONS, type RuleOption } from '../_lib/schedule-helpers';
import type { BookingSettings } from '../_types/schedule';

interface RuleField {
  key: keyof BookingSettings;
  label: string;
  help: string;
  options: readonly RuleOption[];
}

// Option sets from availability-editor.jsx. No consultation-length or booking-window
// control — both are platform config (BAL-398), not per-expert settings.
const RULE_FIELDS: readonly RuleField[] = [
  {
    key: 'bufferBeforeMinutes',
    label: 'Buffer before',
    help: 'Free time kept ahead of each consultation.',
    options: BUFFER_OPTIONS,
  },
  {
    key: 'bufferAfterMinutes',
    label: 'Buffer after',
    help: 'Free time kept after each consultation.',
    options: BUFFER_OPTIONS,
  },
  {
    key: 'minimumNoticeMinutes',
    label: 'Minimum notice',
    help: 'The soonest a client can book you.',
    options: NOTICE_OPTIONS,
  },
];

interface BookingRulesSectionProps {
  settings: BookingSettings;
  onChange: (settings: BookingSettings) => void;
}

/**
 * The "Booking rules" block of the Availability card: three labelled selects side by side
 * (stacked on phones). Each field's help sentence is its control's accessible description
 * rather than visible text, so the row stays compact without hiding meaning behind hover.
 */
export function BookingRulesSection({
  settings,
  onChange,
}: Readonly<BookingRulesSectionProps>): React.JSX.Element {
  const handleChange = useCallback(
    (key: keyof BookingSettings, value: string): void => {
      onChange({ ...settings, [key]: Number(value) });
    },
    [settings, onChange]
  );

  return (
    <div className="flex flex-col gap-3">
      <SettingsEyebrow>Booking rules</SettingsEyebrow>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        {RULE_FIELDS.map((field) => {
          const fieldId = `booking-${field.key}`;
          const helpId = `${fieldId}-help`;
          return (
            <div key={field.key} className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor={fieldId} className="text-foreground text-[13px] font-medium">
                {field.label}
              </label>
              <Select
                value={String(settings[field.key])}
                onValueChange={(value) => handleChange(field.key, value)}
              >
                <SelectTrigger
                  id={fieldId}
                  aria-describedby={helpId}
                  className="w-full text-[13px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {field.options.map((option) => (
                    <SelectItem key={option.value} value={String(option.value)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p id={helpId} className="sr-only">
                {field.help}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
