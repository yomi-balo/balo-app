'use client';

import { useState } from 'react';
import { Pencil, Trash2, Shield, ExternalLink } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

interface CertificationCardData {
  certificationId: string;
  certName: string;
  categoryName?: string;
  earnedAt?: string;
  expiresAt?: string;
  credentialUrl?: string;
}

interface CertificationCardProps {
  cert: CertificationCardData;
  onUpdate: (data: Partial<CertificationCardData>) => void;
  onRemove: () => void;
}

export function CertificationCard({
  cert,
  onUpdate,
  onRemove,
}: CertificationCardProps): React.JSX.Element {
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [earnedMonth, setEarnedMonth] = useState('');
  const [earnedYear, setEarnedYear] = useState('');
  const [expiresMonth, setExpiresMonth] = useState('');
  const [expiresYear, setExpiresYear] = useState('');
  const [credUrl, setCredUrl] = useState(cert.credentialUrl ?? '');

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 20 }, (_, i) => currentYear - i);
  const futureYearOptions = Array.from({ length: 10 }, (_, i) => currentYear + i);
  const allYears = [...new Set([...futureYearOptions.reverse(), ...yearOptions])].sort(
    (a, b) => b - a
  );

  const handleSaveDetails = (): void => {
    const earnedAt =
      earnedMonth && earnedYear
        ? `${earnedYear}-${String(MONTHS.indexOf(earnedMonth as (typeof MONTHS)[number]) + 1).padStart(2, '0')}-01`
        : '';
    const expiresAt =
      expiresMonth && expiresYear
        ? `${expiresYear}-${String(MONTHS.indexOf(expiresMonth as (typeof MONTHS)[number]) + 1).padStart(2, '0')}-01`
        : '';
    onUpdate({
      earnedAt,
      expiresAt,
      credentialUrl: credUrl ? `https://${credUrl}` : '',
    });
    setDetailsExpanded(false);
  };

  return (
    <motion.div
      layout
      initial={{ y: 20, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.25 }}
      className="border-border rounded-xl border p-4"
    >
      <div className="flex items-start gap-4">
        <div className="bg-primary/10 dark:bg-primary/20 shrink-0 rounded-lg p-2.5">
          <Shield className="text-primary h-5 w-5" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-foreground truncate text-sm font-semibold">{cert.certName}</p>
          {cert.categoryName && (
            <p className="text-muted-foreground text-xs">{cert.categoryName}</p>
          )}
          {cert.earnedAt && (
            <p className="text-muted-foreground mt-1 text-xs">
              Earned: {cert.earnedAt}
              {cert.expiresAt ? ` | Expires: ${cert.expiresAt}` : ''}
            </p>
          )}
          {cert.credentialUrl && (
            <a
              href={cert.credentialUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary mt-1 inline-flex items-center gap-1 text-xs hover:underline"
            >
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
              View credential
            </a>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setDetailsExpanded(!detailsExpanded)}
            aria-label={`Edit ${cert.certName} details`}
          >
            <Pencil className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-destructive h-8 w-8"
            onClick={onRemove}
            aria-label={`Remove ${cert.certName}`}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <AnimatePresence>
        {detailsExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-4 space-y-3 overflow-hidden"
          >
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Earned month</Label>
                <Select value={earnedMonth} onValueChange={setEarnedMonth}>
                  <SelectTrigger>
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
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Earned year</Label>
                <Select value={earnedYear} onValueChange={setEarnedYear}>
                  <SelectTrigger>
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
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Expires month</Label>
                <Select value={expiresMonth} onValueChange={setExpiresMonth}>
                  <SelectTrigger>
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
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Expires year</Label>
                <Select value={expiresYear} onValueChange={setExpiresYear}>
                  <SelectTrigger>
                    <SelectValue placeholder="Year" />
                  </SelectTrigger>
                  <SelectContent>
                    {allYears.map((y) => (
                      <SelectItem key={y} value={y.toString()}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Credential URL</Label>
              <div className="flex">
                <span className="border-input bg-muted text-muted-foreground inline-flex items-center rounded-l-md border border-r-0 px-3 text-xs">
                  https://
                </span>
                <Input
                  value={credUrl}
                  onChange={(e) => setCredUrl(e.target.value)}
                  placeholder="credential-url.com/verify/..."
                  className="rounded-l-none text-sm"
                />
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={handleSaveDetails}>
              Save details
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
