'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { type UseFormReturn, useFieldArray } from 'react-hook-form';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
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
import { PhoneVerificationFlow } from '@/components/balo/phone-verification-flow';
import { ChipPicker } from '@/app/(apply)/expert/apply/_components/chip-picker';
import { PhotoUpload } from './photo-upload';
import { UsernameInput } from './username-input';
import { SettingsCard, SettingsEyebrow, SettingsStatusPill } from './settings-card';
import type { ProfileFormData } from './profile-tab';

const HEADLINE_MAX = 100;
const BIO_MAX = 1000;

const PROFICIENCIES = ['beginner', 'intermediate', 'advanced', 'native'] as const;
type Proficiency = (typeof PROFICIENCIES)[number];

function isProficiency(value: string): value is Proficiency {
  return (PROFICIENCIES as readonly string[]).includes(value);
}

/** "+61406431059" → "+61 406 431 059"; anything unparseable is shown as stored. */
function formatPhoneForDisplay(e164: string): string {
  return parsePhoneNumberFromString(e164)?.formatInternational() ?? e164;
}

const FIELD_LABEL_CLASS = 'text-foreground text-[13px] font-medium';

/**
 * One height for every control in the Identity card — names, username, country, phone — so
 * its two-column rows line up: the 44px touch floor on mobile, the standard input height from
 * `sm` up.
 */
const IDENTITY_CONTROL_HEIGHT = 'h-11 sm:h-9';

// ── Character Counter ─────────────────────────────────────────────

function CharCounter({
  current,
  max,
}: Readonly<{ current: number; max: number }>): React.JSX.Element {
  const ratio = current / max;
  let tone = 'text-muted-foreground';
  if (ratio >= 1) tone = 'text-destructive-strong';
  else if (ratio >= 0.8) tone = 'text-warning-strong';
  return (
    <span className={cn('text-xs tabular-nums transition-colors duration-200', tone)}>
      {current}/{max}
    </span>
  );
}

// ── Read-only name field ──────────────────────────────────────────

function ReadOnlyNameField({
  label,
  value,
  hintId,
}: Readonly<{ label: string; value: string; hintId: string }>): React.JSX.Element {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className={cn(FIELD_LABEL_CLASS, 'gap-1')}>
        {label}
        <span className="text-muted-foreground font-normal">&middot; read-only</span>
      </Label>
      <Input
        id={id}
        value={value}
        readOnly
        title="Contact support to change your name"
        aria-describedby={hintId}
        className={cn('bg-muted text-muted-foreground cursor-default', IDENTITY_CONTROL_HEIGHT)}
      />
    </div>
  );
}

// ── Country + phone ───────────────────────────────────────────────

interface ContactFieldsProps {
  countryCode: string;
  onCountryChange: (code: string) => void;
  initialPhone: string | null;
  phoneVerifiedAt: string | null;
  onPhoneVerified: (e164: string) => void;
}

/**
 * Country beside the phone number. A verified number reads as a field with its "Verified"
 * pill; the full `PhoneVerificationFlow` (entry → code → verified, with every error state)
 * replaces it only while a number is being added or changed, and takes the card's full width
 * because its six code boxes do not fit a half-width column.
 */
function ContactFields({
  countryCode,
  onCountryChange,
  initialPhone,
  phoneVerifiedAt,
  onPhoneVerified,
}: Readonly<ContactFieldsProps>): React.JSX.Element {
  const phoneId = useId();
  const [verifiedPhone, setVerifiedPhone] = useState<string | null>(
    phoneVerifiedAt ? initialPhone : null
  );
  const [isChangingPhone, setIsChangingPhone] = useState(false);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  // Set when the flow closes (cancel or success) so focus returns to "Change" instead of
  // falling to <body> with the unmounted flow.
  const restoreFocusRef = useRef(false);

  useEffect(() => {
    if (!isChangingPhone && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      changeButtonRef.current?.focus();
    }
  }, [isChangingPhone, verifiedPhone]);

  const stopChanging = useCallback((): void => {
    restoreFocusRef.current = true;
    setIsChangingPhone(false);
  }, []);

  const handleVerified = useCallback(
    (e164: string): void => {
      restoreFocusRef.current = true;
      setVerifiedPhone(e164);
      setIsChangingPhone(false);
      onPhoneVerified(e164);
    },
    [onPhoneVerified]
  );

  const showVerified = verifiedPhone !== null && !isChangingPhone;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 items-end gap-4 sm:grid-cols-2">
        <fieldset className="min-w-0">
          <legend className={cn(FIELD_LABEL_CLASS, 'mb-1.5')}>Country</legend>
          <CountryCombobox
            value={countryCode}
            onValueChange={onCountryChange}
            className={IDENTITY_CONTROL_HEIGHT}
          />
        </fieldset>

        {showVerified && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={phoneId} className={FIELD_LABEL_CLASS}>
                Phone number
              </Label>
              <button
                ref={changeButtonRef}
                type="button"
                onClick={() => setIsChangingPhone(true)}
                aria-label="Change phone number"
                className="text-primary focus-visible:ring-ring/50 relative rounded-sm text-[13px] leading-none font-medium outline-none after:absolute after:-inset-x-2 after:-inset-y-2 hover:underline focus-visible:ring-[3px]"
              >
                Change
              </button>
            </div>
            <div className="flex items-center gap-2">
              <Input
                id={phoneId}
                value={formatPhoneForDisplay(verifiedPhone)}
                readOnly
                className={cn(
                  'bg-muted/50 flex-1 cursor-default tabular-nums',
                  IDENTITY_CONTROL_HEIGHT
                )}
              />
              <SettingsStatusPill tone="success">Verified</SettingsStatusPill>
            </div>
          </div>
        )}
      </div>

      {!showVerified && (
        <div className="flex flex-col gap-3">
          {verifiedPhone !== null && (
            <p className="text-muted-foreground text-xs">
              SMS keeps going to {formatPhoneForDisplay(verifiedPhone)} until the new number is
              verified.
            </p>
          )}
          {/* Focused only once the expert asks to change the number: an unverified phone mounts
              the flow on page load, mid-card, where focusing it would scroll the page there. */}
          <PhoneVerificationFlow
            mode="settings"
            onVerified={handleVerified}
            onCancel={isChangingPhone ? stopChanging : undefined}
            focusOnMount={isChangingPhone}
          />
        </div>
      )}

      <p className="text-muted-foreground text-xs">
        Country auto-detects from timezone. Changing your number requires re-verification.
      </p>
    </div>
  );
}

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
  /** The number on file, shown as verified only when `phoneVerifiedAt` is set. */
  initialPhone: string | null;
  phoneVerifiedAt: string | null;
  onPhoneVerified: (e164: string) => void;
  /** Form fields OR the country differ from what is saved. */
  isDirty: boolean;
  onReset: () => void;
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
  initialPhone,
  phoneVerifiedAt,
  onPhoneVerified,
  isDirty,
  onReset,
  onSave,
  isSaving,
}: Readonly<ProfileFormProps>): React.JSX.Element {
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'languages',
  });

  const [langOpen, setLangOpen] = useState(false);
  const reduceMotion = useReducedMotion();

  const identityId = useId();
  const nameHintId = useId();
  const usernameId = useId();
  const publicProfileId = useId();
  const headlineId = useId();
  const headlineHintId = useId();
  const bioId = useId();
  const industriesId = useId();
  const languagesId = useId();

  const headline = form.watch('headline');
  const bio = form.watch('bio');
  const industryIds = form.watch('industryIds');

  const selectedLanguageIds = new Set(fields.map((f) => f.languageId));
  const availableLanguages = allLanguages.filter((l) => !selectedLanguageIds.has(l.id));

  const industryOptions = allIndustries.map((i) => ({ id: i.id, label: i.name }));

  const initials = `${firstName?.charAt(0) ?? ''}${lastName?.charAt(0) ?? ''}`.toUpperCase();

  return (
    <div className="flex min-w-0 flex-col gap-[22px]">
      <SettingsCard>
        <PhotoUpload
          currentAvatarUrl={avatarUrl}
          initials={initials}
          onUploadComplete={(url) => onAvatarChange(url)}
          onRemoveComplete={() => onAvatarChange(null)}
        />
      </SettingsCard>

      <SettingsCard aria-labelledby={identityId} className="flex flex-col gap-[18px]">
        <SettingsEyebrow id={identityId}>Identity</SettingsEyebrow>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <ReadOnlyNameField label="First name" value={firstName} hintId={nameHintId} />
          <ReadOnlyNameField label="Last name" value={lastName} hintId={nameHintId} />
        </div>
        <span id={nameHintId} className="sr-only">
          Contact support to change your name.
        </span>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor={usernameId} className={FIELD_LABEL_CLASS}>
            Username
          </Label>
          <UsernameInput
            id={usernameId}
            value={form.watch('username') ?? ''}
            onChange={(v) => form.setValue('username', v, { shouldDirty: true })}
            expertProfileId={expertProfileId}
            className={IDENTITY_CONTROL_HEIGHT}
          />
        </div>

        <hr className="border-border/70" />

        <ContactFields
          countryCode={countryCode}
          onCountryChange={onCountryChange}
          initialPhone={initialPhone}
          phoneVerifiedAt={phoneVerifiedAt}
          onPhoneVerified={onPhoneVerified}
        />
      </SettingsCard>

      <SettingsCard aria-labelledby={publicProfileId} className="flex flex-col gap-[18px]">
        <SettingsEyebrow id={publicProfileId}>Public profile</SettingsEyebrow>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={headlineId} className={FIELD_LABEL_CLASS}>
              Headline
            </Label>
            <CharCounter current={headline?.length ?? 0} max={HEADLINE_MAX} />
          </div>
          <Input
            id={headlineId}
            value={headline}
            onChange={(e) => {
              if (e.target.value.length <= HEADLINE_MAX) {
                form.setValue('headline', e.target.value, { shouldDirty: true });
              }
            }}
            placeholder="e.g. Salesforce Architect specialising in Sales Cloud & integrations"
            maxLength={HEADLINE_MAX}
            aria-describedby={headlineHintId}
          />
          <p id={headlineHintId} className="text-muted-foreground text-xs">
            Shown under your name in search results and on your profile card.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={bioId} className={FIELD_LABEL_CLASS}>
              Bio
            </Label>
            <CharCounter current={bio?.length ?? 0} max={BIO_MAX} />
          </div>
          <Textarea
            id={bioId}
            value={bio}
            onChange={(e) => {
              if (e.target.value.length <= BIO_MAX) {
                form.setValue('bio', e.target.value, { shouldDirty: true });
              }
            }}
            placeholder="Tell clients about your experience, the problems you solve, and what makes you the right consultant for them..."
            maxLength={BIO_MAX}
            rows={4}
            className="field-sizing-fixed min-h-0 resize-y leading-relaxed"
          />
        </div>
      </SettingsCard>

      <SettingsCard aria-labelledby={industriesId} className="flex flex-col gap-3.5">
        <SettingsEyebrow id={industriesId}>Industries</SettingsEyebrow>
        <ChipPicker
          size="compact"
          options={industryOptions}
          selected={industryIds ?? []}
          onChange={(v) => form.setValue('industryIds', v, { shouldDirty: true })}
        />
      </SettingsCard>

      <SettingsCard aria-labelledby={languagesId} className="flex flex-col gap-3.5">
        <div className="flex items-center justify-between gap-3">
          <SettingsEyebrow id={languagesId}>Languages</SettingsEyebrow>
          <Popover open={langOpen} onOpenChange={setLangOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={availableLanguages.length === 0}
                className="text-primary hover:text-primary -my-1 -mr-2"
              >
                <Plus aria-hidden="true" />
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
          <div className="border-border rounded-lg border border-dashed px-4 py-5 text-center">
            <p className="text-muted-foreground text-sm">Add the languages you consult in.</p>
          </div>
        ) : (
          <ul className="border-border overflow-hidden rounded-lg border">
            <AnimatePresence mode="popLayout">
              {fields.map((field, index) => {
                const langInfo = allLanguages.find((l) => l.id === field.languageId);
                const languageName = langInfo?.name ?? 'Unknown';
                const proficiency = form.watch(`languages.${index}.proficiency`);
                return (
                  <motion.li
                    key={field.id}
                    initial={reduceMotion ? false : { x: 20, opacity: 0 }}
                    animate={{ x: 0, opacity: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, delay: reduceMotion ? 0 : index * 0.06 }}
                    className="border-border/60 flex items-center gap-3 border-b px-4 py-2.5 last:border-b-0"
                  >
                    <span className="text-foreground flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                      {langInfo?.flagEmoji && <span aria-hidden="true">{langInfo.flagEmoji}</span>}
                      <span className="truncate">{languageName}</span>
                    </span>
                    <Select
                      value={proficiency}
                      onValueChange={(val) => {
                        if (isProficiency(val)) {
                          form.setValue(`languages.${index}.proficiency`, val, {
                            shouldDirty: true,
                          });
                        }
                      }}
                    >
                      <SelectTrigger
                        aria-label={`${languageName} proficiency`}
                        className="w-[128px] sm:w-[140px]"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PROFICIENCIES.map((prof) => (
                          <SelectItem key={prof} value={prof}>
                            {prof.charAt(0).toUpperCase() + prof.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-foreground h-8 w-8 shrink-0"
                      onClick={() => remove(index)}
                      aria-label={`Remove ${langInfo?.name ?? 'language'}`}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </SettingsCard>

      <div className="flex flex-col-reverse gap-3 pb-2 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="link"
          onClick={onReset}
          disabled={!isDirty || isSaving}
          className="h-11 w-full sm:h-9 sm:w-auto sm:px-0"
        >
          Reset changes
        </Button>
        <Button
          type="button"
          onClick={onSave}
          disabled={!isDirty || isSaving}
          className="h-11 w-full sm:h-9 sm:w-auto"
        >
          {isSaving && (
            <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          )}
          {isSaving ? 'Saving…' : 'Save profile'}
        </Button>
      </div>
    </div>
  );
}
