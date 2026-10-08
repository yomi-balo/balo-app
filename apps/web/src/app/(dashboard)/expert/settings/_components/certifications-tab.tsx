'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Sparkles, Link, Award } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CertificationCard } from '@/app/(apply)/expert/apply/_components/certification-card';
import { CertificationPickerDialog } from '@/app/(apply)/expert/apply/_components/certification-picker-dialog';
import { buildCertCategoryMap } from '@/lib/expert/application-derived-data';
import { ExpertiseLockedBanner } from './expertise-locked-banner';
import { saveCertificationsAction } from '../_actions/save-certifications';
import type { ApplicationCertWithRelations, CertificationsByCategory } from '@balo/db';

interface CertificationsTabProps {
  initialCerts: ApplicationCertWithRelations[];
  certCategories: CertificationsByCategory[];
  trailheadUrl: string | null;
  skillsLocked: boolean;
}

interface CertEntry {
  certificationId: string;
  certName: string;
  categoryName?: string;
  earnedAt?: string;
  expiresAt?: string;
  credentialUrl?: string;
}

/**
 * BAL-593 — one locked certification, read-only: no edit or remove affordance. Styled after the
 * staff review page's cert card (`application-sections.tsx`), not the applicant's editable
 * `CertificationCard`.
 */
function LockedCertificationRow({ cert }: Readonly<{ cert: CertEntry }>): React.JSX.Element {
  return (
    <div className="border-border bg-card flex items-center gap-3 rounded-xl border px-4 py-3">
      <Award className="text-warning size-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="text-foreground text-sm font-semibold">{cert.certName}</p>
        {cert.categoryName && (
          <p className="text-muted-foreground text-[11px]">{cert.categoryName}</p>
        )}
        {cert.earnedAt && (
          <p className="text-muted-foreground mt-1 text-xs">
            Earned: {cert.earnedAt}
            {cert.expiresAt ? ` | Expires: ${cert.expiresAt}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}

export function CertificationsTab({
  initialCerts,
  certCategories,
  trailheadUrl: initialTrailheadUrl,
  skillsLocked,
}: Readonly<CertificationsTabProps>): React.JSX.Element {
  const router = useRouter();
  const certCategoryMap = buildCertCategoryMap(certCategories);

  const [certs, setCerts] = useState<CertEntry[]>(
    initialCerts.map((c) => ({
      certificationId: c.certificationId,
      certName: c.certification.name,
      categoryName: certCategoryMap.get(c.certificationId),
      earnedAt: c.earnedAt ?? undefined,
      expiresAt: c.expiresAt ?? undefined,
      credentialUrl: c.credentialUrl ?? undefined,
    }))
  );
  const [trailheadUrl, setTrailheadUrl] = useState(initialTrailheadUrl ?? '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);

  const handleAddCerts = useCallback(
    (certificationIds: string[]) => {
      // Look up names from categories
      const allCerts = certCategories.flatMap((cat) =>
        cat.certifications.map((c) => ({ ...c, categoryName: cat.category.name }))
      );

      const newEntries: CertEntry[] = certificationIds
        .map((id): CertEntry | null => {
          const certInfo = allCerts.find((c) => c.id === id);
          return certInfo
            ? { certificationId: id, certName: certInfo.name, categoryName: certInfo.categoryName }
            : null;
        })
        .filter((entry): entry is CertEntry => entry !== null);

      setCerts((prev) => [...prev, ...newEntries]);
      setIsDirty(true);
    },
    [certCategories]
  );

  const handleUpdateCert = useCallback((certificationId: string, data: Partial<CertEntry>) => {
    setCerts((prev) =>
      prev.map((c) => (c.certificationId === certificationId ? { ...c, ...data } : c))
    );
    setIsDirty(true);
  }, []);

  const handleRemoveCert = useCallback((certificationId: string) => {
    setCerts((prev) => prev.filter((c) => c.certificationId !== certificationId));
    setIsDirty(true);
  }, []);

  const handleSave = async (): Promise<void> => {
    setIsSaving(true);
    try {
      const result = await saveCertificationsAction({
        certifications: certs.map((c) => ({
          certificationId: c.certificationId,
          earnedAt: c.earnedAt,
          expiresAt: c.expiresAt,
          credentialUrl: c.credentialUrl,
        })),
        trailheadUrl: trailheadUrl || null,
      });

      if (result.success) {
        toast.success('Certifications saved');
        setIsDirty(false);
        return;
      }

      toast.error(result.error ?? 'Failed to save certifications');
      if (result.code === 'locked') {
        // An approval landed between load and save: re-render from the server's own (now
        // locked) props instead of leaving a stale editable state on screen.
        router.refresh();
      }
    } catch {
      toast.error('Failed to save certifications. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div>
      {skillsLocked ? (
        <ExpertiseLockedBanner />
      ) : (
        <div className="bg-primary/5 border-primary/20 text-primary mb-4 flex items-start gap-3 rounded-lg border p-3">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <p className="text-xs leading-relaxed">
            Add certifications anytime to keep your profile current.
          </p>
        </div>
      )}

      {/* Cert list */}
      <div className="mb-4 flex flex-col gap-2">
        {skillsLocked ? (
          certs.map((cert) => <LockedCertificationRow key={cert.certificationId} cert={cert} />)
        ) : (
          <AnimatePresence mode="popLayout">
            {certs.map((cert) => (
              <CertificationCard
                key={cert.certificationId}
                cert={{
                  certificationId: cert.certificationId,
                  certName: cert.certName,
                  categoryName: cert.categoryName,
                  earnedAt: cert.earnedAt,
                  expiresAt: cert.expiresAt,
                  credentialUrl: cert.credentialUrl,
                }}
                onUpdate={(data) => handleUpdateCert(cert.certificationId, data)}
                onRemove={() => handleRemoveCert(cert.certificationId)}
              />
            ))}
          </AnimatePresence>
        )}
      </div>

      {/* Trailhead URL stays editable on a locked profile: it isn't one of the locked cert fields. */}
      <div className="mb-4">
        <Label
          htmlFor="settings-trailhead-url"
          className="text-foreground mb-1.5 block text-[13px] font-semibold"
        >
          Trailhead URL
        </Label>
        <div className="flex">
          <span className="border-input bg-muted text-muted-foreground inline-flex h-9 items-center rounded-l-md border border-r-0 px-3 text-sm">
            <Link className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
          <Input
            id="settings-trailhead-url"
            value={trailheadUrl}
            onChange={(e) => {
              setTrailheadUrl(e.target.value);
              setIsDirty(true);
            }}
            placeholder="https://trailhead.salesforce.com/en/users/your-profile"
            className="rounded-l-none"
          />
        </div>
      </div>

      {/* Add certification button — no add affordance once locked. */}
      {!skillsLocked && (
        <Button
          type="button"
          variant="outline"
          className="text-primary w-full border-dashed"
          onClick={() => setPickerOpen(true)}
        >
          <Plus className="mr-1.5 h-4 w-4" />
          Add certification
        </Button>
      )}

      {/* Save button */}
      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          onClick={handleSave}
          disabled={!isDirty || isSaving}
          className="from-primary w-full bg-gradient-to-r to-violet-600 text-white sm:w-auto"
        >
          {isSaving ? 'Saving...' : 'Save certifications'}
        </Button>
      </div>

      {/* Picker dialog — unreachable once locked (no button opens it), omitted entirely. */}
      {!skillsLocked && (
        <CertificationPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          categories={certCategories}
          alreadyAdded={certs.map((c) => c.certificationId)}
          onAdd={handleAddCerts}
        />
      )}
    </div>
  );
}
