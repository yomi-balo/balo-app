'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RichTextEditor } from '@/components/balo/rich-text-editor';
import { isDescriptionEmpty, toRichTextHtml } from '@/components/balo/rich-text/plain-text';
import { cn } from '@/lib/utils';
import {
  RESPONSIBILITIES_MAX_TEXT,
  RESPONSIBILITIES_TOO_LONG,
  responsibilitiesTextLength,
} from '@/lib/expert-profile/work-history-responsibilities';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface WorkHistoryFormEntry {
  id?: string;
  role: string;
  company: string;
  startedAt: string;
  endedAt?: string;
  isCurrent: boolean;
  responsibilities?: string;
}

interface WorkHistoryFormProps {
  initialData?: WorkHistoryFormEntry;
  onSave: (entry: WorkHistoryFormEntry) => void;
  onCancel: () => void;
}

function parseDate(dateStr?: string): { month: string; year: string } {
  if (!dateStr) return { month: '', year: '' };
  const d = new Date(dateStr);
  return {
    month: MONTHS[d.getMonth()] ?? '',
    year: d.getFullYear().toString(),
  };
}

function buildDateStr(month: string, year: string): string {
  if (!month || !year) return '';
  const monthIdx = MONTHS.indexOf(month as (typeof MONTHS)[number]);
  if (monthIdx === -1) return '';
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}-01`;
}

export function WorkHistoryForm({
  initialData,
  onSave,
  onCancel,
}: Readonly<WorkHistoryFormProps>): React.JSX.Element {
  const startParsed = parseDate(initialData?.startedAt);
  const endParsed = parseDate(initialData?.endedAt);

  const [role, setRole] = useState(initialData?.role ?? '');
  const [company, setCompany] = useState(initialData?.company ?? '');
  const [startMonth, setStartMonth] = useState(startParsed.month);
  const [startYear, setStartYear] = useState(startParsed.year);
  const [endMonth, setEndMonth] = useState(endParsed.month);
  const [endYear, setEndYear] = useState(endParsed.year);
  const [isCurrent, setIsCurrent] = useState(initialData?.isCurrent ?? false);
  // Seeded as HTML: an entry saved before the field became rich text holds plain text.
  const [responsibilities, setResponsibilities] = useState(() =>
    toRichTextHtml(initialData?.responsibilities)
  );
  const responsibilitiesLength = responsibilitiesTextLength(responsibilities);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 30 }, (_, i) => currentYear - i);

  const handleSave = (): void => {
    const newErrors: Record<string, string> = {};
    if (!role.trim()) newErrors.role = 'Role is required';
    if (!company.trim()) newErrors.company = 'Company is required';
    if (!startMonth || !startYear) newErrors.startedAt = 'Start date is required';
    if (responsibilitiesLength > RESPONSIBILITIES_MAX_TEXT) {
      newErrors.responsibilities = RESPONSIBILITIES_TOO_LONG;
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    const startedAt = buildDateStr(startMonth, startYear);
    const endedAt = isCurrent ? '' : buildDateStr(endMonth, endYear);

    onSave({
      id: initialData?.id,
      role: role.trim(),
      company: company.trim(),
      startedAt,
      endedAt,
      isCurrent,
      // The editor's empty document is `<p></p>` — store nothing rather than an empty paragraph.
      responsibilities: isDescriptionEmpty(responsibilities) ? '' : responsibilities,
    });
  };

  return (
    <motion.div
      initial={{ y: -10, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.3 }}
      className="border-border bg-muted/20 space-y-4 rounded-xl border p-6"
    >
      <div className="space-y-1.5">
        <Label htmlFor="wh-role">Role</Label>
        <Input
          id="wh-role"
          placeholder="e.g. Senior Salesforce Consultant"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
        {errors.role && <p className="text-destructive text-sm">{errors.role}</p>}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="wh-company">Company</Label>
        <Input
          id="wh-company"
          placeholder="e.g. Accenture"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
        />
        {errors.company && <p className="text-destructive text-sm">{errors.company}</p>}
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="flex-1 space-y-1.5">
          <Label>Start date</Label>
          <div className="flex gap-2">
            <Select value={startMonth} onValueChange={setStartMonth}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Month" />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={startYear} onValueChange={setStartYear}>
              <SelectTrigger className="w-[100px]">
                <SelectValue placeholder="Year" />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={y.toString()}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {errors.startedAt && <p className="text-destructive text-sm">{errors.startedAt}</p>}
        </div>
        <div className="flex-1 space-y-1.5">
          <Label>End date</Label>
          <div className="flex gap-2">
            <Select value={endMonth} onValueChange={setEndMonth} disabled={isCurrent}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={isCurrent ? '--' : 'Month'} />
              </SelectTrigger>
              <SelectContent>
                {MONTHS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={endYear} onValueChange={setEndYear} disabled={isCurrent}>
              <SelectTrigger className="w-[100px]">
                <SelectValue placeholder={isCurrent ? '--' : 'Year'} />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={y.toString()}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Checkbox
          id="wh-current"
          checked={isCurrent}
          onCheckedChange={(checked) => {
            setIsCurrent(checked === true);
            if (checked === true) {
              setEndMonth('');
              setEndYear('');
            }
          }}
        />
        <Label htmlFor="wh-current" className="cursor-pointer text-sm font-normal">
          Currently in this role
        </Label>
      </div>

      <div className="space-y-1.5">
        {/* The editor is a contenteditable region named by `ariaLabel`, so this label is visual. */}
        <p className="text-sm leading-none font-medium">Responsibilities</p>
        <RichTextEditor
          variant="light"
          value={responsibilities}
          onChange={setResponsibilities}
          ariaLabel="Responsibilities"
          placeholder="Describe your key responsibilities and Salesforce-related achievements..."
        />
        <div className="flex items-start gap-3">
          {errors.responsibilities && (
            <p className="text-destructive text-sm">{errors.responsibilities}</p>
          )}
          <p
            className={cn(
              'ml-auto shrink-0 text-xs tabular-nums',
              responsibilitiesLength > RESPONSIBILITIES_MAX_TEXT
                ? 'text-destructive'
                : 'text-muted-foreground'
            )}
          >
            {responsibilitiesLength}/{RESPONSIBILITIES_MAX_TEXT}
          </p>
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-3">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" onClick={handleSave}>
          {initialData ? 'Save changes' : 'Save'}
        </Button>
      </div>
    </motion.div>
  );
}
