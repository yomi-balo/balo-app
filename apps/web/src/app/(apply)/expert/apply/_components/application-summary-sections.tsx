'use client';

import {
  AlertTriangle,
  Award,
  Briefcase,
  Building2,
  Clock,
  Compass,
  ExternalLink,
  Globe,
  GraduationCap,
  Sparkles,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { projectRangeLabel } from '@balo/shared/experts';
import { BaloCard } from '@/components/balo/card/balo-card';
import { RichTextViewer } from '@/components/balo/rich-text-editor';
import { isDescriptionEmpty, toRichTextHtml } from '@/components/balo/rich-text/plain-text';
import { Button } from '@/components/ui/button';
import type { ApplicationSummaryView, SummaryEditTarget } from '@/lib/expert/application-summary';

interface ApplicationSummarySectionsProps {
  summary: ApplicationSummaryView;
  /** When set, each section shows an Edit link to its wizard step. Omitted on the read-only page. */
  onEdit?: (step: SummaryEditTarget) => void;
}

const DIMENSION_ICONS: Record<string, LucideIcon> = {
  'technical-fix': Wrench,
  architecture: Building2,
  strategy: Compass,
  training: GraduationCap,
};

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '').split('?')[0] ?? url;
}

function SummarySection({
  icon: Icon,
  label,
  digest,
  editTarget,
  onEdit,
  children,
}: Readonly<{
  icon: LucideIcon;
  label: string;
  digest?: string;
  editTarget: SummaryEditTarget;
  onEdit?: (step: SummaryEditTarget) => void;
  children: React.ReactNode;
}>): React.JSX.Element {
  const headingId = `summary-${editTarget}-${label.replaceAll(/\W+/g, '-').toLowerCase()}`;
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2.5 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <div className="flex items-center gap-2">
            <Icon className="text-muted-foreground h-4 w-4" aria-hidden="true" />
            <h3 id={headingId} className="text-foreground text-sm font-semibold">
              {label}
            </h3>
          </div>
          {digest && <span className="text-muted-foreground text-[12.5px]">{digest}</span>}
        </div>
        {onEdit && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="min-h-11 text-xs sm:min-h-8"
            aria-label={`Edit ${label.toLowerCase()}`}
            onClick={() => onEdit(editTarget)}
          >
            Edit
          </Button>
        )}
      </div>
      {children}
    </section>
  );
}

function DataRow({
  label,
  value,
}: Readonly<{ label: string; value: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-muted-foreground text-[13px]">{label}</span>
      <span className="text-foreground text-sm font-medium">{value}</span>
    </div>
  );
}

function Chip({
  children,
  icon: Icon,
}: Readonly<{ children: React.ReactNode; icon?: LucideIcon }>): React.JSX.Element {
  return (
    <span className="bg-muted text-foreground border-border inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px] font-medium">
      {Icon && <Icon className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />}
      {children}
    </span>
  );
}

function ExternalLinkValue({ url }: Readonly<{ url: string }>): React.JSX.Element {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary inline-flex items-center gap-1 font-medium"
    >
      {stripProtocol(url)}
      <ExternalLink className="h-3 w-3" aria-hidden="true" />
    </a>
  );
}

function MiniBar({ value }: Readonly<{ value: number }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="bg-border/60 h-1.5 min-w-12 flex-1 overflow-hidden rounded-full">
        <div className="bg-primary h-full rounded-full" style={{ width: `${value * 10}%` }} />
      </div>
      <span className="text-foreground min-w-[18px] text-right text-xs font-semibold tabular-nums">
        {value}
      </span>
    </div>
  );
}

function ExperienceSection({
  summary,
  onEdit,
}: Readonly<ApplicationSummarySectionsProps>): React.JSX.Element {
  const { experience } = summary;
  return (
    <SummarySection icon={Briefcase} label="Experience" editTarget="profile" onEdit={onEdit}>
      <BaloCard className="px-5 py-2.5">
        <div className="grid grid-cols-1 gap-x-8 sm:grid-cols-2">
          <DataRow label="Year started" value={experience.yearStarted ?? '—'} />
          {/*
            `?? 0` keeps an unanswered project-count question reading "None" on this applicant-facing
            surface; `projectRangeLabel` alone renders "—" for a nullish value. The staff page passes
            the raw value so it can tell "never answered" from "answered None".
          */}
          <DataRow
            label="Projects involved in"
            value={projectRangeLabel(experience.projectCountMin ?? 0)}
          />
          <DataRow
            label="Projects as Lead"
            value={projectRangeLabel(experience.projectLeadCountMin ?? 0)}
          />
          {experience.linkedinUrl && (
            <DataRow label="LinkedIn" value={<ExternalLinkValue url={experience.linkedinUrl} />} />
          )}
        </div>
      </BaloCard>
    </SummarySection>
  );
}

function Divider(): React.JSX.Element {
  return <div className="bg-border my-3.5 h-px" aria-hidden="true" />;
}

function ProfileLists({
  summary,
  onEdit,
}: Readonly<ApplicationSummarySectionsProps>): React.JSX.Element {
  return (
    <BaloCard className="p-5">
      {summary.languages.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            {summary.languages.map((l) => (
              <Chip key={l.id}>
                <span aria-hidden="true">{l.flagEmoji ?? '🌐'}</span>
                {l.name}
                <span className="text-muted-foreground text-xs capitalize">{l.proficiency}</span>
              </Chip>
            ))}
          </div>
          <Divider />
        </>
      )}
      {summary.industries.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {summary.industries.map((i) => (
            <Chip key={i.id}>{i.name}</Chip>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-[13px]">
          {onEdit ? 'Add the industries you work in.' : 'No industries selected'}
        </p>
      )}
      <Divider />
      {summary.distinctions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {summary.distinctions.map((d) => (
            <Chip key={d} icon={Award}>
              {d}
            </Chip>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-[13px]">
          {onEdit ? 'Add any Salesforce distinctions you hold.' : 'No distinctions selected'}
        </p>
      )}
    </BaloCard>
  );
}

function UnratedCallout({
  unrated,
  onEdit,
}: Readonly<{
  unrated: ApplicationSummaryView['products'];
  onEdit: (step: SummaryEditTarget) => void;
}>): React.JSX.Element {
  const [first] = unrated;
  const lead =
    unrated.length === 1 && first
      ? `${first.name} isn't rated yet.`
      : `${unrated.length} products aren't rated yet.`;
  return (
    <div className="border-warning/30 bg-warning/10 mb-3 flex items-start gap-2 rounded-[10px] border px-3.5 py-2.5">
      <AlertTriangle className="text-warning-strong mt-px h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="text-foreground text-[13px] leading-normal">
        {lead} Rate at least one dimension for each product before you submit.{' '}
        <button
          type="button"
          onClick={() => onEdit('assessment')}
          className="text-foreground focus-visible:ring-ring rounded-sm py-3 font-semibold underline focus-visible:ring-2 focus-visible:outline-none"
        >
          Rate now
        </button>
      </p>
    </div>
  );
}

function ProductsSection({
  summary,
  onEdit,
}: Readonly<ApplicationSummarySectionsProps>): React.JSX.Element {
  const unrated = summary.products.filter((p) => !p.rated);
  return (
    <SummarySection
      icon={Sparkles}
      label="Products and ratings"
      digest={`${summary.products.length} product${summary.products.length === 1 ? '' : 's'}`}
      editTarget={summary.products.length === 0 ? 'products' : 'assessment'}
      onEdit={onEdit}
    >
      {/* The callout asks for action, so only the editable summary shows it; the read-only page
          keeps the per-product "Not rated" tag. */}
      {onEdit && unrated.length > 0 && <UnratedCallout unrated={unrated} onEdit={onEdit} />}
      {summary.products.length === 0 && (
        <p className="text-muted-foreground text-[13px]">
          Choose the Salesforce products you work with.
        </p>
      )}
      <div className="flex flex-col gap-2.5">
        {summary.products.map((p) => (
          <BaloCard key={p.id} className="px-4 py-3.5 sm:px-5">
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-foreground text-sm font-semibold">{p.name}</span>
              {!p.rated && (
                <span className="text-warning-strong text-xs font-medium">Not rated</span>
              )}
            </div>
            <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {p.ratings.map((r) => {
                const Icon = DIMENSION_ICONS[r.slug] ?? Wrench;
                return (
                  <div key={r.supportTypeId} className="flex items-center gap-2">
                    <Icon
                      className="text-muted-foreground h-3.5 w-3.5 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="text-muted-foreground w-[88px] shrink-0 text-[12.5px]">
                      {r.name}
                    </span>
                    <div className="min-w-0 flex-1">
                      <MiniBar value={r.proficiency} />
                    </div>
                  </div>
                );
              })}
            </div>
          </BaloCard>
        ))}
      </div>
    </SummarySection>
  );
}

function CertificationsSection({
  summary,
  onEdit,
}: Readonly<ApplicationSummarySectionsProps>): React.JSX.Element | null {
  const { certifications, trailheadUrl } = summary;
  const isEmpty = certifications.length === 0 && !trailheadUrl;
  if (isEmpty && !onEdit) return null;
  return (
    <SummarySection
      icon={Award}
      label="Certifications"
      digest={isEmpty ? undefined : `${certifications.length} added`}
      editTarget="certifications"
      onEdit={onEdit}
    >
      {isEmpty ? (
        <p className="text-muted-foreground text-[13px]">
          Add your certifications to strengthen your application.
        </p>
      ) : (
        <BaloCard className="p-5">
          {trailheadUrl && (
            <div className="text-muted-foreground mb-3 flex flex-wrap items-center gap-2 text-[13px]">
              <span>Trailhead:</span>
              <ExternalLinkValue url={trailheadUrl} />
            </div>
          )}
          {certifications.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {certifications.map((c) => (
                <div
                  key={c.id}
                  className="bg-muted flex items-center gap-2 rounded-[10px] px-2.5 py-2"
                >
                  <span className="text-foreground text-[13px] font-medium">{c.name}</span>
                  {c.category && (
                    <span className="text-muted-foreground ml-auto text-xs">{c.category}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </BaloCard>
      )}
    </SummarySection>
  );
}

function WorkHistorySection({
  summary,
  onEdit,
}: Readonly<ApplicationSummarySectionsProps>): React.JSX.Element | null {
  const { workHistory } = summary;
  if (workHistory.length === 0 && !onEdit) return null;
  const positions = workHistory.length === 1 ? 'position' : 'positions';
  return (
    <SummarySection
      icon={Briefcase}
      label="Work history"
      digest={workHistory.length > 0 ? `${workHistory.length} ${positions}` : undefined}
      editTarget="work-history"
      onEdit={onEdit}
    >
      {workHistory.length === 0 ? (
        <p className="text-muted-foreground text-[13px]">
          Add your recent roles so we can see your experience.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {workHistory.map((w) => (
            <BaloCard key={w.key} className="px-4 py-3.5 sm:px-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-foreground text-sm font-semibold">{w.role}</p>
                  <p className="text-muted-foreground mt-0.5 text-[13px]">{w.company}</p>
                </div>
                {w.isCurrent && (
                  <span className="bg-muted text-muted-foreground border-border rounded-full border px-2.5 py-0.5 text-xs font-medium">
                    Current
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-2 flex items-center gap-1 text-xs">
                <Clock className="h-3 w-3" aria-hidden="true" />
                {w.periodLabel}
              </div>
              {w.responsibilities && !isDescriptionEmpty(toRichTextHtml(w.responsibilities)) && (
                // Rich text since the field became an editor; legacy plain text is converted to
                // paragraphs. The viewer re-parses through the editor schema.
                <div className="border-border mt-3 border-t pt-3">
                  <RichTextViewer value={toRichTextHtml(w.responsibilities)} />
                </div>
              )}
            </BaloCard>
          ))}
        </div>
      )}
    </SummarySection>
  );
}

/**
 * The application summary shared by the post-submit review page (read-only) and the wizard's
 * Review and submit step (each section links back to its step through `onEdit`).
 */
export function ApplicationSummarySections({
  summary,
  onEdit,
}: Readonly<ApplicationSummarySectionsProps>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-7">
      <ExperienceSection summary={summary} onEdit={onEdit} />
      <SummarySection
        icon={Globe}
        label="Languages, industries and distinctions"
        editTarget="profile"
        onEdit={onEdit}
      >
        <ProfileLists summary={summary} onEdit={onEdit} />
      </SummarySection>
      {(summary.products.length > 0 || onEdit) && (
        <ProductsSection summary={summary} onEdit={onEdit} />
      )}
      <CertificationsSection summary={summary} onEdit={onEdit} />
      <WorkHistorySection summary={summary} onEdit={onEdit} />
    </div>
  );
}
