'use client';

import { useEffect, useCallback, useState } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, X, Phone, Briefcase, Globe, Award, Building2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
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
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription,
} from '@/components/ui/form';
import { profileStepSchema, type ProfileStepData } from '../_actions/schemas';
import { useWizard } from './expert-application-context';
import { ChipPicker } from './chip-picker';
import { StepHeading, SectionLabel, slideUpVariant, stagger } from './design-system';

// ── Data-driven config ───────────────────────────────────────────

const COUNTRY_CODES = [
  { value: '+61', label: '+61 Australia', flag: '🇦🇺' },
  { value: '+1', label: '+1 USA', flag: '🇺🇸' },
  { value: '+44', label: '+44 UK', flag: '🇬🇧' },
  { value: '+91', label: '+91 India', flag: '🇮🇳' },
  { value: '+65', label: '+65 Singapore', flag: '🇸🇬' },
  { value: '+64', label: '+64 New Zealand', flag: '🇳🇿' },
  { value: '+49', label: '+49 Germany', flag: '🇩🇪' },
  { value: '+33', label: '+33 France', flag: '🇫🇷' },
  { value: '+81', label: '+81 Japan', flag: '🇯🇵' },
  { value: '+86', label: '+86 China', flag: '🇨🇳' },
] as const;

const PROJECT_COUNT_OPTIONS = [
  { value: '0', label: 'None' },
  { value: '1', label: '1-9' },
  { value: '10', label: '10-25' },
  { value: '26', label: '26-50' },
  { value: '50', label: '50+' },
] as const;

const PROFICIENCY_BADGE_STYLES: Record<string, string> = {
  native: 'border-success/30 bg-success/10 text-success',
  advanced: 'border-primary/30 bg-primary/10 text-primary',
  intermediate: 'border-warning/30 bg-warning/10 text-warning',
  beginner: 'bg-muted text-muted-foreground',
};

const CREDENTIALS = [
  {
    field: 'isSalesforceMvp' as const,
    label: 'Salesforce MVP',
    description: 'Recognized by Salesforce for outstanding community contributions',
  },
  {
    field: 'isSalesforceCta' as const,
    label: 'Salesforce CTA (Certified Technical Architect)',
    description: 'The highest Salesforce certification',
  },
  {
    field: 'isCertifiedTrainer' as const,
    label: 'Certified Salesforce Trainer',
    description: 'Authorized to deliver official Salesforce training',
  },
] as const;

// ── Component ────────────────────────────────────────────────────

interface StepProfileProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

export function StepProfile({ headingRef }: Readonly<StepProfileProps>): React.JSX.Element {
  const { profileData, referenceData, updateStepData, registerValidation } = useWizard();

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: currentYear - 1999 }, (_, i) => currentYear - i);

  const form = useForm<ProfileStepData>({
    resolver: zodResolver(profileStepSchema),
    defaultValues: {
      phone: profileData.phone ?? '',
      countryCode: profileData.countryCode ?? '+61',
      yearStartedSalesforce: profileData.yearStartedSalesforce ?? undefined,
      projectCountMin: profileData.projectCountMin ?? undefined,
      projectLeadCountMin: profileData.projectLeadCountMin ?? undefined,
      linkedinSlug: profileData.linkedinSlug ?? '',
      isSalesforceMvp: profileData.isSalesforceMvp ?? false,
      isSalesforceCta: profileData.isSalesforceCta ?? false,
      isCertifiedTrainer: profileData.isCertifiedTrainer ?? false,
      languages: profileData.languages ?? [],
      industryIds: profileData.industryIds ?? [],
    },
    mode: 'onBlur',
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'languages',
  });

  // Language combobox state
  const [langOpen, setLangOpen] = useState(false);

  // Sync form to context
  useEffect(() => {
    const subscription = form.watch((values) => {
      updateStepData('profile', values);
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

  const industryOptions = referenceData.industries.map((i) => ({
    id: i.id,
    label: i.name,
  }));

  const selectedLanguageIds = new Set(fields.map((f) => f.languageId));
  const availableLanguages = referenceData.languages.filter((l) => !selectedLanguageIds.has(l.id));

  return (
    <Form {...form}>
      <form className="mx-auto max-w-[680px] space-y-10">
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <StepHeading
            icon={Briefcase}
            title="Your Profile"
            subtitle="Tell us about your Salesforce journey. This takes about 10 minutes."
          />
        </div>

        {/* Section 1: Contact Information */}
        <motion.div
          initial={slideUpVariant.initial}
          animate={slideUpVariant.animate}
          transition={{ ...slideUpVariant.transition, ...stagger(0).transition }}
          className="space-y-4"
        >
          <SectionLabel icon={Phone} color="primary">
            Contact Information
          </SectionLabel>
          <div className="grid grid-cols-[140px_1fr] items-start gap-3">
            <FormField
              control={form.control}
              name="countryCode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Country</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Country" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {COUNTRY_CODES.map((cc) => (
                        <SelectItem key={cc.value} value={cc.value}>
                          {cc.flag} {cc.value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="phone"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Phone number <span className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="412 345 678" {...field} aria-required="true" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            We&apos;ll only use this to contact you about your application.
          </p>
        </motion.div>

        {/* Section 2: Salesforce Experience */}
        <motion.div
          initial={slideUpVariant.initial}
          animate={slideUpVariant.animate}
          transition={{ ...slideUpVariant.transition, ...stagger(1).transition }}
          className="space-y-4"
        >
          <SectionLabel icon={Briefcase} color="violet">
            Salesforce Experience
          </SectionLabel>
          <div className="grid grid-cols-1 items-start gap-x-4 gap-y-5 sm:grid-cols-2">
            {/* Year started */}
            <FormField
              control={form.control}
              name="yearStartedSalesforce"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Year started on Salesforce <span className="text-destructive">*</span>
                  </FormLabel>
                  <Select
                    onValueChange={(v) => {
                      field.onChange(Number(v));
                      form.trigger('yearStartedSalesforce');
                    }}
                    value={field.value?.toString()}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select year" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {years.map((y) => (
                        <SelectItem key={y} value={y.toString()}>
                          {y}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Projects */}
            <FormField
              control={form.control}
              name="projectCountMin"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Projects involved in <span className="text-destructive">*</span>
                  </FormLabel>
                  <Select
                    onValueChange={(v) => {
                      field.onChange(Number(v));
                      form.trigger('projectCountMin');
                    }}
                    value={field.value?.toString()}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select range" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PROJECT_COUNT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="projectLeadCountMin"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Projects as Lead <span className="text-destructive">*</span>
                  </FormLabel>
                  <Select
                    onValueChange={(v) => {
                      field.onChange(Number(v));
                      form.trigger('projectLeadCountMin');
                    }}
                    value={field.value?.toString()}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select range" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {PROJECT_COUNT_OPTIONS.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* LinkedIn */}
            <FormField
              control={form.control}
              name="linkedinSlug"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>LinkedIn</FormLabel>
                  <div className="flex">
                    <span className="border-input bg-muted text-muted-foreground inline-flex h-10 items-center rounded-l-md border border-r-0 px-3 text-sm">
                      linkedin.com/in/
                    </span>
                    <FormControl>
                      <Input
                        placeholder="your-profile"
                        className="h-10 rounded-l-none"
                        {...field}
                      />
                    </FormControl>
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Projects as Lead = where you were the primary consultant or architect.
          </p>
        </motion.div>

        {/* Section 3: Languages */}
        <motion.div
          initial={slideUpVariant.initial}
          animate={slideUpVariant.animate}
          transition={{ ...slideUpVariant.transition, ...stagger(2).transition }}
          className="space-y-3"
        >
          <div className="flex items-center justify-between">
            <div>
              <SectionLabel icon={Globe} color="cyan">
                Languages
              </SectionLabel>
              <p className="text-muted-foreground -mt-2 text-sm">
                Languages you can consult in. Add at least one.
              </p>
            </div>
            <Popover open={langOpen} onOpenChange={setLangOpen}>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={availableLanguages.length === 0}
                  className="border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
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

          {/* Language rows */}
          {fields.length === 0 ? (
            <div className="border-border mt-2 rounded-xl border-2 border-dashed p-6 text-center">
              <p className="text-muted-foreground text-sm">No languages added yet</p>
            </div>
          ) : (
            <div className="border-border mt-2 overflow-hidden rounded-xl border">
              <AnimatePresence mode="popLayout">
                {fields.map((field, index) => {
                  const langInfo = referenceData.languages.find((l) => l.id === field.languageId);
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
                      <FormField
                        control={form.control}
                        name={`languages.${index}.proficiency`}
                        render={({ field: profField }) => (
                          <Select onValueChange={profField.onChange} value={profField.value}>
                            <SelectTrigger className="w-[140px]">
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
                        )}
                      />
                      <Badge
                        variant="outline"
                        className={
                          PROFICIENCY_BADGE_STYLES[form.watch(`languages.${index}.proficiency`)] ??
                          'bg-muted text-muted-foreground'
                        }
                      >
                        {form.watch(`languages.${index}.proficiency`)}
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

          {/* Language error message */}
          {form.formState.errors.languages?.message && (
            <p className="text-destructive text-sm">{form.formState.errors.languages.message}</p>
          )}
        </motion.div>

        {/* Section 4: Credentials */}
        <motion.div
          initial={slideUpVariant.initial}
          animate={slideUpVariant.animate}
          transition={{ ...slideUpVariant.transition, ...stagger(3).transition }}
        >
          <div className="from-primary/[0.04] space-y-4 rounded-xl bg-gradient-to-br to-violet-600/[0.06] p-6 ring-1 ring-violet-200/40">
            <div>
              <SectionLabel icon={Award} color="amber">
                Salesforce Distinctions
              </SectionLabel>
              <p className="text-muted-foreground -mt-2 text-xs">
                Check any that apply. These are prestigious &mdash; they&apos;ll be highlighted on
                your profile.
              </p>
            </div>
            {CREDENTIALS.map((cred) => (
              <FormField
                key={cred.field}
                control={form.control}
                name={cred.field}
                render={({ field }) => (
                  <FormItem className="flex items-start gap-3">
                    <FormControl>
                      <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                    </FormControl>
                    <div className="space-y-0.5">
                      <FormLabel className="text-foreground text-sm leading-normal font-medium">
                        {cred.label}
                      </FormLabel>
                      <FormDescription className="text-xs">{cred.description}</FormDescription>
                    </div>
                  </FormItem>
                )}
              />
            ))}
          </div>
        </motion.div>

        {/* Section 5: Industries */}
        <motion.div
          initial={slideUpVariant.initial}
          animate={slideUpVariant.animate}
          transition={{ ...slideUpVariant.transition, ...stagger(4).transition }}
          className="space-y-3"
        >
          <div>
            <SectionLabel icon={Building2} color="emerald">
              Industry Expertise
            </SectionLabel>
            <p className="text-muted-foreground -mt-2 text-sm">
              Select industries you have consulting experience in.
            </p>
          </div>
          <FormField
            control={form.control}
            name="industryIds"
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <ChipPicker
                    options={industryOptions}
                    selected={field.value ?? []}
                    onChange={(v) => {
                      field.onChange(v);
                      form.trigger('industryIds');
                    }}
                    className="mt-3"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </motion.div>
      </form>
    </Form>
  );
}
