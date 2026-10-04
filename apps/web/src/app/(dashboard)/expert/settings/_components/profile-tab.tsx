'use client';

import { useState, useMemo, useCallback } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
// ⚠ `@balo/shared/reviews` is dependency-free and CLIENT-SAFE by construction (no `@balo/db`,
// so no transitive `postgres` → unresolvable `tls` at `next build`). That is exactly why
// `parseRatingAverage` lives there rather than beside the repository.
import { parseRatingAverage } from '@balo/shared/reviews';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { calculateClientRate, centsToDollars } from '@/lib/utils/currency';
import type { ExpertCardData } from '@/components/expert';
import { buildExpertise } from '@/components/expert';
import { useRouter } from 'next/navigation';
import { ProfileForm } from './profile-form';
import { ProfilePreviewPanel } from './profile-preview-panel';
import { saveProfileAction } from '../_actions/save-profile';
import { saveCountryAction } from '../_actions/save-country';
import { updateNameAction } from '@/lib/auth/actions/update-name';
import { changedNameFields, personNameSchema } from '@/lib/auth/name-schema';
import { track, SETTINGS_EVENTS } from '@/lib/analytics';
import type { ProfileSettingsData } from '@balo/db';

// ── Form schema ──────────────────────────────────────────────────

// The name is validated against `personNameSchema` only when it is being changed (see
// `handleSave`): an account created without a last name must still be able to save its headline.
const profileFormSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  headline: z.string().max(100),
  bio: z.string().max(1000),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/)
    .optional()
    .or(z.literal('')),
  industryIds: z.array(z.string()),
  languages: z.array(
    z.object({
      languageId: z.string(),
      proficiency: z.enum(['beginner', 'intermediate', 'advanced', 'native']),
    })
  ),
});

export type ProfileFormData = z.infer<typeof profileFormSchema>;

/**
 * The name to save on this Save: the validated (trimmed) name when it was edited, `null` when it
 * was not touched, or `'invalid'` after flagging the offending field(s) on the form. Validated
 * only when edited, so an account stored without a last name can still save its headline.
 */
function resolveNameEdit(
  form: UseFormReturn<ProfileFormData>
): z.infer<typeof personNameSchema> | null | 'invalid' {
  const { dirtyFields } = form.formState;
  if (dirtyFields.firstName !== true && dirtyFields.lastName !== true) {
    return null;
  }
  const parsed = personNameSchema.safeParse({
    firstName: form.getValues('firstName'),
    lastName: form.getValues('lastName'),
  });
  if (parsed.success) {
    return parsed.data;
  }
  for (const issue of parsed.error.issues) {
    const [field] = issue.path;
    if (field === 'firstName' || field === 'lastName') {
      form.setError(field, { message: issue.message });
    }
  }
  return 'invalid';
}

// ── Props ─────────────────────────────────────────────────────────

interface ProfileTabProps {
  initialProfile: ProfileSettingsData;
  referenceData: {
    languages: Array<{ id: string; name: string; code: string; flagEmoji: string | null }>;
    industries: Array<{ id: string; name: string }>;
  };
  initialPhone: string | null;
  phoneVerifiedAt: string | null;
}

export function ProfileTab({
  initialProfile,
  referenceData,
  initialPhone,
  phoneVerifiedAt,
}: Readonly<ProfileTabProps>): React.JSX.Element {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(initialProfile.user.avatarUrl);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [countryCode, setCountryCode] = useState(initialProfile.user.countryCode ?? '');
  // The country is saved beside the form (its own action), so it carries its own baseline for
  // dirty-tracking and Reset.
  const [savedCountryCode, setSavedCountryCode] = useState(initialProfile.user.countryCode ?? '');

  const form = useForm<ProfileFormData>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
      firstName: initialProfile.user.firstName ?? '',
      lastName: initialProfile.user.lastName ?? '',
      headline: initialProfile.headline ?? '',
      bio: initialProfile.bio ?? '',
      username: initialProfile.username ?? '',
      industryIds: initialProfile.industries.map((i) => i.industryId),
      languages: initialProfile.languages.map((l) => ({
        languageId: l.languageId,
        proficiency: l.proficiency as 'beginner' | 'intermediate' | 'advanced' | 'native',
      })),
    },
  });

  const watchedValues = form.watch();
  // The preview and the photo's initials follow the name as it is typed, like the headline.
  const firstName = watchedValues.firstName.trim();
  const lastName = watchedValues.lastName.trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Expert';
  const initials = `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();

  // Build ExpertCardData from form watch values + initial profile
  const expertCardData: ExpertCardData = useMemo(
    () => ({
      id: initialProfile.id,
      username: initialProfile.username,
      name: fullName,
      initials,
      avatarUrl,
      headline: watchedValues.headline?.trim() || initialProfile.headline || null,
      bio: watchedValues.bio?.trim() || null,
      countryCode: countryCode || initialProfile.user.countryCode || null,
      rate: initialProfile.rateCents
        ? centsToDollars(calculateClientRate(initialProfile.rateCents))
        : null,
      nextAvailableAt: null,
      languages: initialProfile.languages.map((l) => ({
        name: l.language.name,
        flagEmoji: l.language.flagEmoji,
      })),
      agency: null,
      distinctions: {
        isSalesforceMvp: initialProfile.isSalesforceMvp,
        isSalesforceCta: initialProfile.isSalesforceCta,
        isCertifiedTrainer: initialProfile.isCertifiedTrainer,
      },
      // BAL-422 — the preview must show the SAME badge clients see on the live card, so this
      // reads the real aggregate rather than the old `null` / `0` hardcode: a preview that
      // silently omitted the expert's rating would misrepresent their live profile.
      // `findProfileForSettings` hydrates the full `expert_profiles` row, so both columns are
      // already here. `rating_average` is `numeric` ⇒ a STRING, hence the one shared parse.
      // `null` still means NO REVIEWS and `RatingBadge` renders nothing — never 0.0.
      rating: parseRatingAverage(initialProfile.ratingAverage),
      ratingCount: initialProfile.ratingCount,
      yearsExperience: initialProfile.yearStartedSalesforce
        ? new Date().getFullYear() - initialProfile.yearStartedSalesforce
        : null,
      consultationCount: 0,
      expertise: buildExpertise(initialProfile.competencies),
    }),
    [
      initialProfile,
      fullName,
      initials,
      avatarUrl,
      watchedValues.headline,
      watchedValues.bio,
      countryCode,
    ]
  );

  const handleSave = async (): Promise<void> => {
    const valid = await form.trigger();
    if (!valid) return;

    const nameEdit = resolveNameEdit(form);
    if (nameEdit === 'invalid') return;

    setIsSaving(true);
    try {
      const values = form.getValues();
      const countryChanged = countryCode !== savedCountryCode;

      const promises: Promise<{ success: boolean; error?: string }>[] = [
        saveProfileAction({
          headline: values.headline,
          bio: values.bio,
          username: values.username || null,
          industryIds: values.industryIds,
          languages: values.languages,
        }),
      ];

      if (countryChanged) {
        promises.push(saveCountryAction({ countryCode: countryCode || null }));
      }

      if (nameEdit !== null) {
        promises.push(updateNameAction(nameEdit));
      }

      const results = await Promise.all(promises);
      const failed = results.find((r) => !r.success);

      if (failed) {
        toast.error(failed.error ?? 'Failed to save profile');
      } else {
        toast.success('Profile saved');
        // The name as it was before this save — read before `reset` replaces the defaults.
        const previousName = {
          firstName: form.formState.defaultValues?.firstName,
          lastName: form.formState.defaultValues?.lastName,
        };
        // Reset dirty state with the saved values (the name as stored — trimmed)
        form.reset(nameEdit === null ? values : { ...values, ...nameEdit });
        setSavedCountryCode(countryCode);
        if (nameEdit !== null) {
          track(SETTINGS_EVENTS.NAME_UPDATED, {
            surface: 'expert_profile',
            fields_changed: changedNameFields(previousName, nameEdit),
          });
          // The session cookie now carries the new name; re-render the shell (sidebar, menu).
          router.refresh();
        }
      }
    } catch {
      toast.error('Failed to save profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReset = (): void => {
    form.reset();
    setCountryCode(savedCountryCode);
  };

  const handlePhoneVerified = useCallback((): void => {
    toast.success('Phone number verified');
    router.refresh();
  }, [router]);

  const isDirty = form.formState.isDirty || countryCode !== savedCountryCode;

  const previewPanel = (
    <ProfilePreviewPanel
      expert={expertCardData}
      username={watchedValues.username ?? ''}
      headline={watchedValues.headline ?? ''}
    />
  );

  return (
    <div className="grid items-start gap-7 lg:grid-cols-[minmax(0,1.75fr)_minmax(0,1fr)]">
      {/* Mobile: the preview collapses above the form */}
      <div className="lg:hidden">
        <Collapsible open={previewOpen} onOpenChange={setPreviewOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="h-11 w-full justify-between" type="button">
              {previewOpen ? 'Hide preview' : 'Show preview'}
              {previewOpen ? (
                <ChevronUp className="ml-2 h-4 w-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="ml-2 h-4 w-4" aria-hidden="true" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4">{previewPanel}</CollapsibleContent>
        </Collapsible>
      </div>

      <ProfileForm
        form={form}
        avatarUrl={avatarUrl}
        expertProfileId={initialProfile.id}
        allLanguages={referenceData.languages}
        allIndustries={referenceData.industries}
        countryCode={countryCode}
        onCountryChange={setCountryCode}
        onAvatarChange={setAvatarUrl}
        initialPhone={initialPhone}
        phoneVerifiedAt={phoneVerifiedAt}
        onPhoneVerified={handlePhoneVerified}
        isDirty={isDirty}
        onReset={handleReset}
        onSave={handleSave}
        isSaving={isSaving}
      />

      {/* Desktop: the preview rides alongside the form */}
      <div data-testid="preview-desktop" className="hidden lg:sticky lg:top-24 lg:block">
        {previewPanel}
      </div>
    </div>
  );
}
