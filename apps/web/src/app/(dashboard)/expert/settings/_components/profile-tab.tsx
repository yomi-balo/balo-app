'use client';

import { useState, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { ProfileForm } from './profile-form';
import { ProfilePreviewPanel } from './profile-preview-panel';
import { saveProfileAction } from '../_actions/save-profile';
import type { ProfileSettingsData } from '@balo/db';

// ── Form schema ──────────────────────────────────────────────────

const profileFormSchema = z.object({
  headline: z.string().max(100),
  bio: z.string().max(1000),
  username: z
    .string()
    .min(3)
    .max(40)
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

// ── Props ─────────────────────────────────────────────────────────

interface ProfileTabProps {
  initialProfile: ProfileSettingsData;
  referenceData: {
    languages: Array<{ id: string; name: string; code: string; flagEmoji: string | null }>;
    industries: Array<{ id: string; name: string }>;
  };
}

export function ProfileTab({
  initialProfile,
  referenceData,
}: Readonly<ProfileTabProps>): React.JSX.Element {
  const [isSaving, setIsSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(initialProfile.user.avatarUrl);
  const [previewOpen, setPreviewOpen] = useState(false);

  const form = useForm<ProfileFormData>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
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
  const firstName = initialProfile.user.firstName ?? '';
  const lastName = initialProfile.user.lastName ?? '';
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || 'Expert';
  const initials = `${firstName.charAt(0)}${lastName.charAt(0)}`.toUpperCase();

  // Map industry IDs to names for the preview
  const selectedIndustryNames = useMemo(() => {
    const ids = new Set(watchedValues.industryIds ?? []);
    return referenceData.industries.filter((i) => ids.has(i.id)).map((i) => i.name);
  }, [watchedValues.industryIds, referenceData.industries]);

  // Rate display
  const ratePerMinute = initialProfile.hourlyRate
    ? (initialProfile.hourlyRate / 100).toFixed(2)
    : '';

  const handleSave = async (): Promise<void> => {
    const valid = await form.trigger();
    if (!valid) return;

    setIsSaving(true);
    try {
      const values = form.getValues();
      const result = await saveProfileAction({
        headline: values.headline,
        bio: values.bio,
        username: values.username || null,
        industryIds: values.industryIds,
        languages: values.languages,
      });

      if (result.success) {
        toast.success('Profile saved');
        // Reset dirty state with current values
        form.reset(values);
      } else {
        toast.error(result.error ?? 'Failed to save profile');
      }
    } catch {
      toast.error('Failed to save profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const previewPanel = (
    <ProfilePreviewPanel
      photo={avatarUrl}
      name={fullName}
      initials={initials}
      headline={watchedValues.headline ?? ''}
      bio={watchedValues.bio ?? ''}
      username={watchedValues.username ?? ''}
      industries={selectedIndustryNames}
      ratePerMinute={ratePerMinute}
    />
  );

  return (
    <div>
      {/* Mobile: Collapsible preview */}
      <div className="mb-6 lg:hidden">
        <Collapsible open={previewOpen} onOpenChange={setPreviewOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="outline" className="w-full justify-between" type="button">
              {previewOpen ? 'Hide preview' : 'Show preview'}
              {previewOpen ? (
                <ChevronUp className="ml-2 h-4 w-4" />
              ) : (
                <ChevronDown className="ml-2 h-4 w-4" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-4">{previewPanel}</CollapsibleContent>
        </Collapsible>
      </div>

      {/* Desktop: Side-by-side layout */}
      <div className="flex gap-6">
        {/* Left: Form */}
        <div className="min-w-0 flex-1">
          <ProfileForm
            form={form}
            firstName={firstName}
            lastName={lastName}
            avatarUrl={avatarUrl}
            expertProfileId={initialProfile.id}
            allLanguages={referenceData.languages}
            allIndustries={referenceData.industries}
            onAvatarChange={setAvatarUrl}
            onSave={handleSave}
            isSaving={isSaving}
          />
        </div>

        {/* Right: Preview (desktop only) */}
        <div className={cn('hidden w-[300px] shrink-0 self-start lg:sticky lg:top-24 lg:block')}>
          {previewPanel}
        </div>
      </div>
    </div>
  );
}
