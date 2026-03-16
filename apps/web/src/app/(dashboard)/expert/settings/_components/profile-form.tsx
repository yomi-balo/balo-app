'use client';

import { useState } from 'react';
import { Camera, User, Sparkles, Briefcase, Globe, Plus, X } from 'lucide-react';
import { type UseFormReturn, useFieldArray } from 'react-hook-form';
import { AnimatePresence, motion } from 'motion/react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { cn } from '@/lib/utils';
import { CountryCombobox } from '@/components/country-combobox';
import { ChipPicker } from '@/app/(apply)/expert/apply/_components/chip-picker';
import { PhotoUpload } from './photo-upload';
import { UsernameInput } from './username-input';
import type { ProfileFormData } from './profile-tab';

// ── Section Label ────────────────────────────────────────────────

const SECTION_COLORS: Record<string, { text: string; bg: string }> = {
  primary: { text: 'text-primary', bg: 'bg-primary/10' },
  violet: {
    text: 'text-violet-600 dark:text-violet-400',
    bg: 'bg-violet-600/10 dark:bg-violet-400/10',
  },
  cyan: { text: 'text-cyan-600 dark:text-cyan-400', bg: 'bg-cyan-600/10 dark:bg-cyan-400/10' },
  emerald: {
    text: 'text-emerald-600 dark:text-emerald-400',
    bg: 'bg-emerald-600/10 dark:bg-emerald-400/10',
  },
};

function SectionLabel({
  icon: Icon,
  color = 'primary',
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  color?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const c = SECTION_COLORS[color] ?? SECTION_COLORS.primary!;
  return (
    <div className="mb-3.5 flex items-center gap-2">
      <div className={cn('flex h-6 w-6 items-center justify-center rounded-md', c.bg)}>
        <Icon className={cn('h-[13px] w-[13px]', c.text)} aria-hidden="true" />
      </div>
      <p className={cn('text-[11px] font-semibold tracking-[0.08em] uppercase', c.text)}>
        {children}
      </p>
    </div>
  );
}

// ── Character Counter ─────────────────────────────────────────────

function CharCounter({ current, max }: { current: number; max: number }): React.JSX.Element {
  const ratio = current / max;
  return (
    <span
      className={cn(
        'text-[11px] tabular-nums transition-colors duration-200',
        ratio >= 1 ? 'text-destructive' : ratio >= 0.8 ? 'text-warning' : 'text-muted-foreground'
      )}
    >
      {current}/{max}
    </span>
  );
}

// ── Proficiency badge styles ──────────────────────────────────────

const PROFICIENCY_BADGE_STYLES: Record<string, string> = {
  native: 'border-success/30 bg-success/10 text-success',
  advanced: 'border-primary/30 bg-primary/10 text-primary',
  intermediate: 'border-warning/30 bg-warning/10 text-warning',
  beginner: 'bg-muted text-muted-foreground',
};

// ── Props ─────────────────────────────────────────────────────────

interface ProfileFormProps {
  form: UseFormReturn<ProfileFormData>;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  expertProfileId: string;
  allLanguages: Array<{
    id: string;
    name: string;
    code: string;
    flagEmoji: string | null;
  }>;
  allIndustries: Array<{
    id: string;
    name: string;
  }>;
  countryCode: string;
  onCountryChange: (code: string) => void;
  onAvatarChange: (url: string | null) => void;
  onSave: () => void;
  isSaving: boolean;
}

export function ProfileForm({
  form,
  firstName,
  lastName,
  avatarUrl,
  expertProfileId,
  allLanguages,
  allIndustries,
  countryCode,
  onCountryChange,
  onAvatarChange,
  onSave,
  isSaving,
}: Readonly<ProfileFormProps>): React.JSX.Element {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'languages',
  });

  const [langOpen, setLangOpen] = useState(false);

  const headline = form.watch('headline');
  const bio = form.watch('bio');
  const industryIds = form.watch('industryIds');

  const selectedLanguageIds = new Set(fields.map((f) => f.languageId));
  const availableLanguages = allLanguages.filter((l) => !selectedLanguageIds.has(l.id));

  const industryOptions = allIndustries.map((i) => ({ id: i.id, label: i.name }));

  const initials = `${firstName?.charAt(0) ?? ''}${lastName?.charAt(0) ?? ''}`.toUpperCase();

  return (
    <div className="flex flex-col gap-6">
      {/* Photo Card */}
      <Card className="p-6">
        <SectionLabel icon={Camera} color="primary">
          Photo
        </SectionLabel>
        <PhotoUpload
          currentAvatarUrl={avatarUrl}
          initials={initials}
          onUploadComplete={(url) => onAvatarChange(url)}
          onRemoveComplete={() => onAvatarChange(null)}
        />
      </Card>

      {/* Identity Card */}
      <Card className="p-6">
        <SectionLabel icon={User} color="primary">
          Identity
        </SectionLabel>

        {/* Name (read-only) */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center gap-1.5">
            <Label className="text-foreground text-[13px] font-semibold">Name</Label>
            <span className="text-muted-foreground text-xs">
              &middot; Read-only &mdash; contact support to change
            </span>
          </div>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Input value={firstName} disabled className="bg-muted" />
            <Input value={lastName} disabled className="bg-muted" />
          </div>
        </div>

        {/* Username */}
        <div className="mb-4">
          <Label className="text-foreground mb-1.5 block text-[13px] font-semibold">Username</Label>
          <UsernameInput
            value={form.watch('username') ?? ''}
            onChange={(v) => form.setValue('username', v, { shouldDirty: true })}
            expertProfileId={expertProfileId}
          />
        </div>

        {/* Country */}
        <div>
          <Label className="text-foreground mb-1.5 block text-[13px] font-semibold">Country</Label>
          <CountryCombobox value={countryCode} onValueChange={onCountryChange} />
          <p className="text-muted-foreground mt-1.5 text-[11px]">
            Auto-detected from your timezone. You can change it manually.
          </p>
        </div>
      </Card>

      {/* Public Profile Card */}
      <Card className="p-6">
        <SectionLabel icon={Sparkles} color="violet">
          Public profile
        </SectionLabel>

        {/* Headline */}
        <div className="mb-4">
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="text-foreground text-[13px] font-semibold">Headline</Label>
            <CharCounter current={headline?.length ?? 0} max={100} />
          </div>
          <Input
            value={headline}
            onChange={(e) => {
              if (e.target.value.length <= 100) {
                form.setValue('headline', e.target.value, { shouldDirty: true });
              }
            }}
            placeholder="e.g. Salesforce Architect specialising in Sales Cloud & integrations"
            maxLength={100}
          />
          <p className="text-muted-foreground mt-1.5 text-[11px]">
            Shown below your name in search results and on your profile card.
          </p>
        </div>

        {/* Bio */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="text-foreground text-[13px] font-semibold">Bio</Label>
            <CharCounter current={bio?.length ?? 0} max={1000} />
          </div>
          <textarea
            value={bio}
            onChange={(e) => {
              if (e.target.value.length <= 1000) {
                form.setValue('bio', e.target.value, { shouldDirty: true });
              }
            }}
            placeholder="Tell clients about your experience, the problems you solve, and what makes you the right consultant for them..."
            maxLength={1000}
            rows={5}
            className="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex w-full rounded-md border px-3 py-2.5 text-sm leading-relaxed focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
          />
        </div>
      </Card>

      {/* Industries Card */}
      <Card className="p-6">
        <SectionLabel icon={Briefcase} color="cyan">
          Industries
        </SectionLabel>
        <ChipPicker
          options={industryOptions}
          selected={industryIds ?? []}
          onChange={(v) => form.setValue('industryIds', v, { shouldDirty: true })}
        />
      </Card>

      {/* Languages Card */}
      <Card className="p-6">
        <div className="mb-3 flex items-center justify-between">
          <SectionLabel icon={Globe} color="emerald">
            Languages
          </SectionLabel>
          <Popover open={langOpen} onOpenChange={setLangOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={availableLanguages.length === 0}
                className="text-primary"
              >
                <Plus className="mr-1 h-4 w-4" />
                Add language
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[240px] p-0" align="end">
              <Command>
                <CommandInput placeholder="Search languages..." />
                <CommandList>
                  <CommandEmpty>No language found.</CommandEmpty>
                  <CommandGroup>
                    {availableLanguages.map((lang) => (
                      <CommandItem
                        key={lang.id}
                        value={lang.name}
                        onSelect={() => {
                          append({
                            languageId: lang.id,
                            proficiency: 'intermediate',
                          });
                          setLangOpen(false);
                        }}
                      >
                        {lang.flagEmoji && <span className="mr-2">{lang.flagEmoji}</span>}
                        {lang.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>

        {fields.length === 0 ? (
          <div className="border-border rounded-xl border-2 border-dashed p-6 text-center">
            <p className="text-muted-foreground text-sm">No languages added yet</p>
          </div>
        ) : (
          <div className="border-border overflow-hidden rounded-xl border">
            <AnimatePresence mode="popLayout">
              {fields.map((field, index) => {
                const langInfo = allLanguages.find((l) => l.id === field.languageId);
                const proficiency = form.watch(`languages.${index}.proficiency`);
                return (
                  <motion.div
                    key={field.id}
                    initial={{ x: 20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, delay: index * 0.06 }}
                    className="border-border/50 flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
                  >
                    <span className="text-foreground flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                      {langInfo?.flagEmoji && <span>{langInfo.flagEmoji}</span>}
                      <span className="truncate">{langInfo?.name ?? 'Unknown'}</span>
                    </span>
                    <Select
                      value={proficiency}
                      onValueChange={(val) =>
                        form.setValue(
                          `languages.${index}.proficiency`,
                          val as 'beginner' | 'intermediate' | 'advanced' | 'native',
                          { shouldDirty: true }
                        )
                      }
                    >
                      <SelectTrigger className="w-[120px] sm:w-[140px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(['beginner', 'intermediate', 'advanced', 'native'] as const).map(
                          (prof) => (
                            <SelectItem key={prof} value={prof}>
                              {prof.charAt(0).toUpperCase() + prof.slice(1)}
                            </SelectItem>
                          )
                        )}
                      </SelectContent>
                    </Select>
                    <Badge
                      variant="outline"
                      className={cn(
                        'hidden sm:inline-flex',
                        PROFICIENCY_BADGE_STYLES[proficiency] ?? 'bg-muted text-muted-foreground'
                      )}
                    >
                      {proficiency}
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 shrink-0"
                      onClick={() => remove(index)}
                      aria-label={`Remove ${langInfo?.name ?? 'language'}`}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </Card>

      {/* Save row */}
      <div className="flex flex-col-reverse gap-3 pb-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={() => form.reset()}
          disabled={!form.formState.isDirty || isSaving}
          className="w-full sm:w-auto"
        >
          Reset changes
        </Button>
        <Button
          type="button"
          onClick={onSave}
          disabled={!form.formState.isDirty || isSaving}
          className="from-primary w-full bg-gradient-to-r to-violet-600 text-white sm:w-auto"
        >
          {isSaving ? 'Saving...' : 'Save profile'}
        </Button>
      </div>
    </div>
  );
}
