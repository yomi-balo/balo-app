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
import { calculateClientRate, centsToDollars } from '@/lib/utils/currency';
import { extractCityFromTimezone } from '@balo/shared/timezone';
import type { ExpertCardData, ExpertiseItem, SkillType } from '@/components/expert';
import { useRouter } from 'next/navigation';
import { Phone } from 'lucide-react';
import { ProfileForm } from './profile-form';
import { ProfilePreviewPanel } from './profile-preview-panel';
import { PhoneVerificationFlow } from '@/components/balo/phone-verification-flow';
import { saveProfileAction } from '../_actions/save-profile';
import { saveCountryAction } from '../_actions/save-country';
import type { ProfileSettingsData } from '@balo/db';

// ── Map support type slugs to ExpertCard SkillType ───────────────

const SUPPORT_TYPE_SLUG_MAP: Record<string, SkillType> = {
  'technical-fix-support': 'technical',
  'architecture-integrations': 'architecture',
  'strategy-best-practices': 'strategy',
  'platform-training': 'admin',
};

function buildExpertise(skills: ProfileSettingsData['skills']): ExpertiseItem[] {
  const groups = new Map<string, ExpertiseItem>();

  for (const s of skills) {
    if (s.proficiency <= 0) continue;
    const key = s.skillId;
    if (!groups.has(key)) {
      groups.set(key, { product: s.skill.name, skills: [] });
    }
    const mapped = SUPPORT_TYPE_SLUG_MAP[s.supportType.slug];
    if (mapped && !groups.get(key)!.skills.includes(mapped)) {
      groups.get(key)!.skills.push(mapped);
    }
  }

  return Array.from(groups.values());
}

// ── Form schema ──────────────────────────────────────────────────

const profileFormSchema = z.object({
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

// ── Props ─────────────────────────────────────────────────────────

interface ProfileTabProps {
  initialProfile: ProfileSettingsData;
  referenceData: {
    languages: Array<{ id: string; name: string; code: string; flagEmoji: string | null }>;
    industries: Array<{ id: string; name: string }>;
  };
  initialPhone: string | null;
  phoneVerifiedAt: string | null;
  accessToken: string;
}

export function ProfileTab({
  initialProfile,
  referenceData,
  initialPhone,
  phoneVerifiedAt,
  accessToken,
}: Readonly<ProfileTabProps>): React.JSX.Element {
  const router = useRouter();
  const [isSaving, setIsSaving] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState(initialProfile.user.avatarUrl);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [countryCode, setCountryCode] = useState(initialProfile.user.countryCode ?? '');

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

  // Build ExpertCardData from form watch values + initial profile
  const expertCardData: ExpertCardData = useMemo(() => {
    const city = extractCityFromTimezone(initialProfile.user.timezone);
    const cc = countryCode || initialProfile.user.countryCode;
    let location = '';
    if (cc && city) location = `${city}, ${cc}`;
    else if (cc) location = cc;
    else if (city) location = city;

    return {
      id: initialProfile.id,
      name: fullName,
      initials,
      avatarKey: avatarUrl,
      title: watchedValues.headline || initialProfile.headline || 'Salesforce Expert',
      bio: watchedValues.bio?.trim() || null,
      location,
      yearsExp: initialProfile.yearStartedSalesforce
        ? new Date().getFullYear() - initialProfile.yearStartedSalesforce
        : 0,
      certifications: initialProfile.certifications?.length ?? 0,
      consultationCount: 0,
      rating: null,
      reviewCount: 0,
      rate: initialProfile.hourlyRate
        ? centsToDollars(calculateClientRate(initialProfile.hourlyRate))
        : 0,
      available: initialProfile.availableForWork ?? false,
      expertise: buildExpertise(initialProfile.skills),
    };
  }, [
    initialProfile,
    fullName,
    initials,
    avatarUrl,
    watchedValues.headline,
    watchedValues.bio,
    countryCode,
  ]);

  const handleSave = async (): Promise<void> => {
    const valid = await form.trigger();
    if (!valid) return;

    setIsSaving(true);
    try {
      const values = form.getValues();
      const initialCountryCode = initialProfile.user.countryCode ?? '';
      const countryChanged = countryCode !== initialCountryCode;

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

      const results = await Promise.all(promises);
      const failed = results.find((r) => !r.success);

      if (failed) {
        toast.error(failed.error ?? 'Failed to save profile');
      } else {
        toast.success('Profile saved');
        // Reset dirty state with current values
        form.reset(values);
      }
    } catch {
      toast.error('Failed to save profile. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const previewPanel = (
    <ProfilePreviewPanel
      expert={expertCardData}
      username={watchedValues.username ?? ''}
      headline={watchedValues.headline ?? ''}
    />
  );

  return (
    <div>
      {/* Phone Number Verification */}
      <div className="border-border bg-card mb-6 rounded-xl border p-6">
        <div className="mb-4 flex items-center gap-2">
          <Phone className="text-primary h-4 w-4" />
          <h3 className="text-foreground text-sm font-semibold">Phone Number</h3>
        </div>
        <PhoneVerificationFlow
          mode="settings"
          initialPhone={phoneVerifiedAt ? (initialPhone ?? undefined) : undefined}
          accessToken={accessToken}
          onVerified={() => {
            toast.success('Phone number verified');
            router.refresh();
          }}
        />
      </div>

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
            countryCode={countryCode}
            onCountryChange={setCountryCode}
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
