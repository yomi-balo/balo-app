'use client';

import { useEffect, useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Shield, Award, GraduationCap } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
  FormDescription,
} from '@/components/ui/form';
import { certificationsStepSchema, type CertificationsStepData } from '../_actions/schemas';
import { useWizard } from './expert-application-context';
import { CertificationCard } from './certification-card';
import { CertificationPickerDialog } from './certification-picker-dialog';
import { StepHeading, SectionLabel, slideUpVariant } from './design-system';

interface StepCertificationsProps {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}

export function StepCertifications({
  headingRef,
}: Readonly<StepCertificationsProps>): React.JSX.Element {
  const { certificationsData, referenceData, updateStepData, registerValidation } = useWizard();
  const [pickerOpen, setPickerOpen] = useState(false);

  const form = useForm<CertificationsStepData>({
    resolver: zodResolver(certificationsStepSchema),
    defaultValues: {
      trailheadSlug: certificationsData.trailheadSlug ?? '',
      certifications: certificationsData.certifications ?? [],
    },
    mode: 'onBlur',
  });

  const certs = form.watch('certifications') ?? [];

  // Build cert name lookup
  const certNameMap = useMemo(() => {
    const map = new Map<string, { name: string; categoryName: string }>();
    for (const cat of referenceData.certificationsByCategory) {
      for (const cert of cat.certifications) {
        map.set(cert.id, { name: cert.name, categoryName: cat.category.name });
      }
    }
    return map;
  }, [referenceData.certificationsByCategory]);

  // Sync form to context
  useEffect(() => {
    const subscription = form.watch((values) => {
      updateStepData('certifications', values);
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

  const handleAddCerts = (certificationIds: string[]): void => {
    const currentCerts = form.getValues('certifications') ?? [];
    const newCerts = certificationIds.map((id) => ({
      certificationId: id,
      earnedAt: '',
      expiresAt: '',
      credentialUrl: '',
    }));
    form.setValue('certifications', [...currentCerts, ...newCerts], {
      shouldDirty: true,
    });
  };

  const handleRemoveCert = (index: number): void => {
    const currentCerts = form.getValues('certifications') ?? [];
    form.setValue(
      'certifications',
      currentCerts.filter((_, i) => i !== index),
      { shouldDirty: true }
    );
  };

  const handleUpdateCert = (
    index: number,
    data: Partial<{ earnedAt: string; expiresAt: string; credentialUrl: string }>
  ): void => {
    const currentCerts = form.getValues('certifications') ?? [];
    const updated = [...currentCerts];
    updated[index] = { ...updated[index]!, ...data };
    form.setValue('certifications', updated, { shouldDirty: true });
  };

  const alreadyAddedIds = certs.map((c) => c.certificationId);

  return (
    <Form {...form}>
      <form className="mx-auto max-w-[680px] space-y-8">
        <div ref={headingRef} tabIndex={-1} className="outline-none">
          <StepHeading
            icon={Award}
            iconColor="text-success"
            iconBg="bg-success/10"
            iconBorder="border-success/25"
            title="Your Certifications"
            subtitle="Salesforce certifications boost your profile credibility. This step is optional but highly recommended."
          />
        </div>

        {/* Encouraging banner */}
        {certs.length === 0 && (
          <div className="bg-info/10 border-info/20 flex items-start gap-3 rounded-xl border p-4">
            <Shield className="text-info mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <p className="text-info text-sm">
              Certified experts get significantly more bookings on Balo. Even one certification
              makes a difference.
            </p>
          </div>
        )}

        {/* Trailhead URL */}
        <motion.div
          initial={slideUpVariant.initial}
          animate={slideUpVariant.animate}
          transition={slideUpVariant.transition}
          className="border-border bg-muted/30 space-y-3 rounded-xl border p-6"
        >
          <SectionLabel icon={GraduationCap} color="violet">
            Trailhead Profile
          </SectionLabel>
          <FormField
            control={form.control}
            name="trailheadSlug"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Trailhead profile</FormLabel>
                <div className="flex">
                  <span className="border-input bg-muted text-muted-foreground inline-flex items-center rounded-l-md border border-r-0 px-3 text-sm">
                    trailblazer.me/id/
                  </span>
                  <FormControl>
                    <Input placeholder="your-username" className="rounded-l-none" {...field} />
                  </FormControl>
                </div>
                <FormDescription>
                  Your Trailhead profile helps us verify your certifications.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </motion.div>

        {/* Certification list */}
        <SectionLabel icon={Award} color="emerald">
          Certifications
        </SectionLabel>
        {certs.length === 0 ? (
          <div className="border-border rounded-xl border-2 border-dashed p-8 text-center">
            <div className="bg-muted mx-auto mb-3 w-fit rounded-xl p-3">
              <Shield className="text-muted-foreground h-6 w-6" aria-hidden="true" />
            </div>
            <p className="text-foreground text-sm font-semibold">No certifications added yet</p>
            <p className="text-muted-foreground mt-1 text-xs">
              Add your Salesforce certifications to stand out
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4"
              onClick={() => setPickerOpen(true)}
            >
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              Add Certifications
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence>
              {certs.map((cert, index) => {
                const info = certNameMap.get(cert.certificationId);
                return (
                  <CertificationCard
                    key={cert.certificationId}
                    cert={{
                      certificationId: cert.certificationId,
                      certName: info?.name ?? 'Unknown',
                      categoryName: info?.categoryName,
                      earnedAt: cert.earnedAt,
                      expiresAt: cert.expiresAt,
                      credentialUrl: cert.credentialUrl,
                    }}
                    onUpdate={(data) => handleUpdateCert(index, data)}
                    onRemove={() => handleRemoveCert(index)}
                  />
                );
              })}
            </AnimatePresence>
            <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
              <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
              Add Certifications
            </Button>
            {certs.length > 0 && (
              <p className="text-muted-foreground mt-2 text-xs">
                Looking great! Each certification improves your search ranking.
              </p>
            )}
          </div>
        )}

        <CertificationPickerDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          categories={referenceData.certificationsByCategory}
          alreadyAdded={alreadyAddedIds}
          onAdd={handleAddCerts}
        />
      </form>
    </Form>
  );
}
