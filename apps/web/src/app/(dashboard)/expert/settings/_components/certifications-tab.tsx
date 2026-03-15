'use client';

import { useState, useCallback } from 'react';
import { Plus, Sparkles, Link } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CertificationCard } from '@/app/(apply)/expert/apply/_components/certification-card';
import { CertificationPickerDialog } from '@/app/(apply)/expert/apply/_components/certification-picker-dialog';
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
  isLocked: boolean;
}

export function CertificationsTab({
  initialCerts,
  certCategories,
  trailheadUrl: initialTrailheadUrl,
  skillsLocked,
}: Readonly<CertificationsTabProps>): React.JSX.Element {
  // Track which certs were present at load time (these are "locked" when skillsLocked is true)
  const [lockedCertIds] = useState<Set<string>>(
    () => new Set(skillsLocked ? initialCerts.map((c) => c.certificationId) : [])
  );

  const [certs, setCerts] = useState<CertEntry[]>(
    initialCerts.map((c) => ({
      certificationId: c.certificationId,
      certName: c.certification.name,
      earnedAt: c.earnedAt ?? undefined,
      expiresAt: c.expiresAt ?? undefined,
      credentialUrl: c.credentialUrl ?? undefined,
      isLocked: skillsLocked && lockedCertIds.has(c.certificationId),
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
        .map((id) => {
          const certInfo = allCerts.find((c) => c.id === id);
          return certInfo
            ? {
                certificationId: id,
                certName: certInfo.name,
                categoryName: certInfo.categoryName,
                isLocked: false,
              }
            : null;
        })
        .filter(Boolean) as CertEntry[];

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

  const handleRemoveCert = useCallback(
    (certificationId: string) => {
      // Prevent removing locked certs
      if (skillsLocked && lockedCertIds.has(certificationId)) {
        toast.error('This certification is locked and cannot be removed.');
        return;
      }
      setCerts((prev) => prev.filter((c) => c.certificationId !== certificationId));
      setIsDirty(true);
    },
    [skillsLocked, lockedCertIds]
  );

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
      } else {
        toast.error(result.error ?? 'Failed to save certifications');
      }
    } catch {
      toast.error('Failed to save certifications. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div>
      {/* Info banner */}
      <div className="bg-primary/5 border-primary/20 text-primary mb-4 flex items-start gap-3 rounded-lg border p-3">
        <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="text-xs leading-relaxed">
          Certifications with the <strong>Locked</strong> badge were verified during onboarding. You
          can add additional certifications anytime.
        </p>
      </div>

      {/* Cert list */}
      <div className="mb-4 flex flex-col gap-2">
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
      </div>

      {/* Trailhead URL */}
      <div className="mb-4">
        <Label className="text-foreground mb-1.5 block text-[13px] font-semibold">
          Trailhead URL
        </Label>
        <div className="flex">
          <span className="border-input bg-muted text-muted-foreground inline-flex h-9 items-center rounded-l-md border border-r-0 px-3 text-sm">
            <Link className="h-3.5 w-3.5" />
          </span>
          <Input
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

      {/* Add certification button */}
      <Button
        type="button"
        variant="outline"
        className="text-primary w-full border-dashed"
        onClick={() => setPickerOpen(true)}
      >
        <Plus className="mr-1.5 h-4 w-4" />
        Add certification
      </Button>

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

      {/* Picker dialog */}
      <CertificationPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        categories={certCategories}
        alreadyAdded={certs.map((c) => c.certificationId)}
        onAdd={handleAddCerts}
      />
    </div>
  );
}
