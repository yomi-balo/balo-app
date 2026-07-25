'use client';

import { useCallback } from 'react';
import { CalendarClock } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
    <section className="border-border bg-card rounded-xl border p-6">
      <div className="mb-1.5 flex items-center gap-2">
        <CalendarClock className="text-primary h-3.5 w-3.5" aria-hidden="true" />
        <span className="text-primary text-[11px] font-bold tracking-wider uppercase">
          Booking rules
        </span>
      </div>
      <p className="text-muted-foreground mb-5 text-sm leading-relaxed">
        How your open hours are turned into bookable times.
      </p>

      <div className="grid gap-5 sm:grid-cols-2">
        {RULE_FIELDS.map((field) => {
          const fieldId = `booking-${field.key}`;
          return (
            <div key={field.key}>
              <label htmlFor={fieldId} className="text-foreground text-sm font-medium">
                {field.label}
              </label>
              <p className="text-muted-foreground mt-0.5 mb-2 text-xs leading-relaxed">
                {field.help}
              </p>
              <Select
                value={String(settings[field.key])}
                onValueChange={(value) => handleChange(field.key, value)}
              >
                <SelectTrigger id={fieldId} className="w-full">
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
            </div>
          );
        })}
      </div>
    </section>
  );
}
