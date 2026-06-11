'use client';

import {
  AlertCircle,
  Check,
  ChevronDown,
  DollarSign,
  FileText,
  History,
  Layers,
  Lock,
  Paperclip,
  Shield,
  Star,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import { RichTextViewer, isDescriptionEmpty } from '@/components/balo/rich-text-editor';
import { STANDARD_TERMS } from './proposal-standard-terms';
import type {
  ProposalReviewAttachment,
  ProposalReviewDoc,
  ProposalReviewMilestone,
} from './proposal-review-types';

interface ProposalDocProps {
  doc: ProposalReviewDoc;
  /**
   * When provided, each anchored section gets `id={sectionIdPrefix + key}` plus a
   * scroll-margin so the section-nav can jump and scroll-spy. Omit it for the
   * expert/admin waiting view, which renders the same content without ids.
   */
  sectionIdPrefix?: string;
}

/** Props that anchor a section for the nav, or `{}` when un-anchored. */
type SectionAnchor = { id: string; className: string } | Record<string, never>;

/** Small uppercase section heading with a leading icon (mirrors the design ref). */
function SectionLabel({
  icon: Icon,
  children,
}: Readonly<{ icon: LucideIcon; children: React.ReactNode }>): React.JSX.Element {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Icon className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
      <span className="text-muted-foreground text-[11px] font-bold tracking-[0.07em] uppercase">
        {children}
      </span>
    </div>
  );
}

/** Initials avatar fallback. */
function Avatar({ initials }: Readonly<{ initials: string }>): React.JSX.Element {
  return (
    <span className="bg-primary/10 text-primary flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-semibold">
      {initials}
    </span>
  );
}

/** A red-tinted file-icon tile used by attachment / supplement rows. */
function FileTile(): React.JSX.Element {
  return (
    <span className="bg-destructive/10 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg">
      <FileText className="text-destructive h-3.5 w-3.5" aria-hidden="true" />
    </span>
  );
}

export function ProposalDoc({
  doc,
  sectionIdPrefix,
}: Readonly<ProposalDocProps>): React.JSX.Element {
  const isTM = doc.pricingMethod === 'tm';

  // Anchor a section only when a prefix is given (composer-driven section-nav);
  // the waiting view passes no prefix and renders the same content id-less.
  const anchor = (key: string): SectionAnchor =>
    sectionIdPrefix ? { id: sectionIdPrefix + key, className: 'scroll-mt-20' } : {};

  const termsSupplement = doc.attachments.find((a) => a.kind === 'terms');
  const fileAttachments = doc.attachments.filter((a) => a.kind !== 'terms');

  return (
    <div className="flex flex-col gap-[18px]">
      {/* 1 — Header: identity + pills */}
      <div className="flex items-center gap-3">
        <Avatar initials={doc.expert.initials} />
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-[15px] font-semibold">
            {doc.expert.name}
            {doc.expert.company !== null && (
              <span className="text-muted-foreground ml-1 text-xs font-medium">
                · {doc.expert.company}
              </span>
            )}
          </p>
          {(doc.expert.rating !== null || doc.expert.headline !== null) && (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
              {doc.expert.rating !== null && (
                <>
                  <Star className="text-warning h-3 w-3 fill-current" aria-hidden="true" />
                  {doc.expert.rating}
                </>
              )}
              {doc.expert.rating !== null && doc.expert.headline !== null && ' · '}
              {doc.expert.headline}
            </span>
          )}
        </div>
        {doc.version > 1 && (
          <span className="border-info/30 bg-info/10 text-info inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap">
            <History className="h-3 w-3" aria-hidden="true" />v{doc.version} · revised
          </span>
        )}
        <span className="border-primary/30 bg-primary/10 text-primary inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap">
          {isTM ? 'Time & Materials' : 'Fixed price'}
        </span>
      </div>

      {/* 2 — Money / timeframe banner */}
      <div className="border-border from-primary/[0.07] to-primary/[0.02] flex items-end justify-between gap-3 rounded-2xl border bg-gradient-to-br p-[18px]">
        <div>
          <p className="text-muted-foreground text-[11px] font-bold tracking-[0.05em] uppercase">
            {isTM ? 'Estimated total' : 'Fixed price'}
          </p>
          <p className="text-foreground mt-0.5 text-[30px] leading-none font-extrabold tabular-nums">
            {formatWholeCurrency(doc.priceCents, doc.currency)}
            {isTM && <span className="text-muted-foreground text-sm font-semibold"> est.</span>}
          </p>
        </div>
        <div className="text-right">
          <p className="text-muted-foreground text-[11px] font-bold tracking-[0.05em] uppercase">
            Est. timeframe
          </p>
          <p className="text-foreground mt-0.5 text-base font-semibold">
            {doc.timeframeWeeks === null ? '—' : `~${doc.timeframeWeeks} weeks`}
          </p>
        </div>
      </div>

      {/* 3 — Overview */}
      <section {...anchor('overview')}>
        <SectionLabel icon={FileText}>Overview</SectionLabel>
        <RichTextViewer value={doc.overviewHtml} />
      </section>

      {/* 4 — Milestones & deliverables */}
      <section {...anchor('milestones')}>
        <SectionLabel icon={Layers}>Milestones &amp; deliverables</SectionLabel>
        <div className="flex flex-col gap-2">
          {doc.milestones.map((milestone, index) => (
            <MilestoneRow
              key={milestone.id}
              milestone={milestone}
              index={index}
              showValue={!isTM}
              currency={doc.currency}
            />
          ))}
        </div>
      </section>

      {/* 5 — Payment terms (adaptive) */}
      <section {...anchor('payment')}>
        <SectionLabel icon={DollarSign}>Payment terms</SectionLabel>
        {isTM ? (
          <TmTerms doc={doc} />
        ) : (
          <FixedTerms
            installments={doc.installments}
            priceCents={doc.priceCents}
            currency={doc.currency}
          />
        )}
      </section>

      {/* 6 — Terms (standard + optional supplement) */}
      <section {...anchor('terms')}>
        <SectionLabel icon={Shield}>Terms</SectionLabel>
        <div className="flex flex-col gap-2.5">
          <Collapsible className="border-border bg-muted/30 rounded-xl border">
            <CollapsibleTrigger className="group focus-visible:ring-ring flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left focus-visible:ring-2 focus-visible:outline-none">
              <span className="border-border bg-card flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[9px] border">
                <Lock className="text-muted-foreground h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-foreground text-[13.5px] font-semibold">
                  Balo standard terms apply
                </p>
                <p className="text-muted-foreground mt-px text-xs">
                  Platform engagement terms — IP, payment via Balo, disputes. Non-negotiable.
                </p>
              </div>
              <span className="text-primary inline-flex shrink-0 items-center gap-1 text-xs font-semibold">
                View
                <ChevronDown
                  className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="border-border text-muted-foreground mt-1 flex list-disc flex-col gap-1.5 border-t px-4 py-3 pl-9 text-xs leading-relaxed">
                {STANDARD_TERMS.map((term) => (
                  <li key={term}>{term}</li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
          {termsSupplement !== undefined && (
            <div className="border-border flex items-center gap-3 rounded-xl border px-3.5 py-2.5">
              <FileTile />
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-[13px] font-semibold">
                  {termsSupplement.fileName}
                </p>
                <p className="text-muted-foreground text-[11.5px]">
                  {doc.expert.name}&apos;s additional terms ·{' '}
                  {formatBytes(termsSupplement.sizeBytes)}
                </p>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 7 — Not included (deliberately NOT in the nav) */}
      {doc.exclusionsHtml !== null && (
        <section>
          <SectionLabel icon={AlertCircle}>Not included</SectionLabel>
          <RichTextViewer value={doc.exclusionsHtml} />
        </section>
      )}

      {/* 8 — Attachments (non-terms only) */}
      {fileAttachments.length > 0 && (
        <section {...anchor('attachments')}>
          <SectionLabel icon={Paperclip}>Attachments</SectionLabel>
          <div className="flex flex-col gap-2">
            {fileAttachments.map((attachment) => (
              <AttachmentRow key={attachment.id} attachment={attachment} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MilestoneRow({
  milestone,
  index,
  showValue,
  currency,
}: Readonly<{
  milestone: ProposalReviewMilestone;
  index: number;
  showValue: boolean;
  currency: string;
}>): React.JSX.Element {
  const hasDescription =
    milestone.descriptionHtml !== null && !isDescriptionEmpty(milestone.descriptionHtml);
  return (
    <div className="border-border bg-card flex gap-3 rounded-xl border p-4">
      <span className="bg-primary/10 text-primary flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex justify-between gap-2.5">
          <p className="text-foreground text-sm font-semibold">{milestone.title}</p>
          {showValue && milestone.valueCents !== null && (
            <p className="text-foreground shrink-0 text-sm font-semibold tabular-nums">
              {formatWholeCurrency(milestone.valueCents, currency)}
            </p>
          )}
        </div>
        {hasDescription && (
          <div className="mt-1.5">
            <RichTextViewer value={milestone.descriptionHtml ?? ''} />
          </div>
        )}
        {milestone.acceptanceCriteria !== null && milestone.acceptanceCriteria !== '' && (
          <p className="text-muted-foreground mt-1.5 flex items-center gap-1.5 text-xs">
            <Check className="text-success h-3 w-3 shrink-0" aria-hidden="true" />
            <span>
              <span className="font-medium">Done when: </span>
              {milestone.acceptanceCriteria}
            </span>
          </p>
        )}
      </div>
    </div>
  );
}

function FixedTerms({
  installments,
  priceCents,
  currency,
}: Readonly<{
  installments: ProposalReviewDoc['installments'];
  priceCents: number;
  currency: string;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="border-border flex h-[38px] overflow-hidden rounded-[10px] border">
        {installments.map((inst, i) => (
          <div
            key={inst.id}
            className={cn(
              'flex items-center justify-center text-xs font-bold',
              i === 0 ? 'bg-primary text-primary-foreground' : 'bg-muted/40 text-muted-foreground'
            )}
            style={{ flexGrow: inst.pct, flexBasis: 0 }}
          >
            {inst.pct}%
          </div>
        ))}
      </div>
      {installments.map((inst, i) => (
        <div key={inst.id} className="flex items-center justify-between gap-2.5 px-1 py-2">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'h-2.5 w-2.5 shrink-0 rounded-sm',
                i === 0 ? 'bg-primary' : 'bg-border'
              )}
            />
            <span className="text-foreground text-[13.5px] font-semibold">
              {inst.label} —{' '}
              {formatWholeCurrency(Math.round((priceCents * inst.pct) / 100), currency)}
            </span>
          </div>
          <span className="text-muted-foreground text-xs">{inst.pct}%</span>
        </div>
      ))}
    </div>
  );
}

function TmTerms({ doc }: Readonly<{ doc: ProposalReviewDoc }>): React.JSX.Element {
  const deposit =
    doc.depositCents !== null
      ? `${formatWholeCurrency(doc.depositCents, doc.currency)} deposit on acceptance`
      : null;
  const rate =
    doc.rateCents !== null ? `${formatWholeCurrency(doc.rateCents, doc.currency)}/hr` : null;
  const invoiced = doc.cadence !== null ? `Invoiced ${doc.cadence}` : null;
  const parts = [deposit, rate, invoiced].filter((p): p is string => p !== null);

  return (
    <div className="border-border rounded-xl border px-4 py-3.5">
      <p className="text-foreground text-[13.5px] leading-relaxed">
        {parts.length > 0 ? <span className="font-semibold">{parts.join(', then ')}. </span> : null}
        {formatWholeCurrency(doc.priceCents, doc.currency)} is an estimate, not a cap.
      </p>
    </div>
  );
}

function AttachmentRow({
  attachment,
}: Readonly<{ attachment: ProposalReviewAttachment }>): React.JSX.Element {
  return (
    <div className="border-border bg-card flex items-center gap-3 rounded-xl border px-3.5 py-2.5">
      <FileTile />
      <div className="min-w-0 flex-1">
        <p className="text-foreground truncate text-[13px] font-semibold">{attachment.fileName}</p>
        <p className="text-muted-foreground text-[11.5px]">{formatBytes(attachment.sizeBytes)}</p>
      </div>
    </div>
  );
}
