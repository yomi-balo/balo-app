'use client';

import { Sparkles, Pencil, FileText, Image as ImageIcon, User } from 'lucide-react';
import { getAvatarUrl } from '@/lib/storage/avatar-url';
import { RichTextViewer } from '@/components/balo/rich-text-editor';
import { formatBytes } from '@/components/balo/document-uploader/upload-file';
import { formatBudgetRange } from '@/lib/utils/currency';
import type { ProjectDraft } from './use-project-draft';

interface ReviewSummaryProps {
  draft: ProjectDraft;
  /**
   * Expert display data. Absent → context-free mode: the Direct routing block
   * renders neutral "Going to an expert" copy + person glyph.
   */
  expertName?: string;
  expertInitials?: string;
  expertAvatarKey?: string | null;
  /** id→name maps for rendering tag/product chips read-only. */
  tagNameMap: Record<string, string>;
  productNameMap: Record<string, string>;
  /** Jump back to the manual step to edit. */
  onEdit: () => void;
}

interface SummaryBlockProps {
  label: string;
  onEdit: () => void;
  children: React.ReactNode;
}

function SummaryBlock({ label, onEdit, children }: Readonly<SummaryBlockProps>): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-xl border p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
          {label}
        </span>
        <button
          type="button"
          onClick={onEdit}
          className="text-primary hover:text-primary/80 focus-visible:ring-ring inline-flex items-center gap-1 rounded-md text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
        </button>
      </div>
      {children}
    </div>
  );
}

function ReadOnlyChips({
  ids,
  nameMap,
}: Readonly<{ ids: string[]; nameMap: Record<string, string> }>): React.JSX.Element {
  if (ids.length === 0) {
    return <p className="text-muted-foreground text-sm">None</p>;
  }
  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => (
        <span
          key={id}
          className="border-primary/40 bg-primary/5 text-primary inline-flex items-center rounded-lg border px-3 py-1.5 text-[13px] font-medium"
        >
          {nameMap[id] ?? id}
        </span>
      ))}
    </div>
  );
}

/**
 * Read-only review of the brief (design §3 review step). Renders each editable
 * field as a summary block with an "Edit" link back to `manual`. The description
 * is shown through the locked read-only viewer (HTML re-parsed through the
 * allow-list), so the user verifies exactly what the expert will receive.
 */
export function ReviewSummary({
  draft,
  expertName,
  expertInitials,
  expertAvatarKey,
  tagNameMap,
  productNameMap,
  onEdit,
}: Readonly<ReviewSummaryProps>): React.JSX.Element {
  // Direct routing only resolves to a named expert when one is bound; a
  // context-free Direct selection still renders neutral "an expert" copy.
  const isDirect = draft.routing === 'direct';
  const hasExpert = expertName !== undefined;
  const directToNamedExpert = isDirect && hasExpert;
  const avatarUrl = getAvatarUrl(expertAvatarKey ?? null, 'thumbnail');

  let routingMedia: React.ReactNode;
  if (directToNamedExpert && avatarUrl) {
    routingMedia = (
      <span className="border-border bg-muted flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
        {/* eslint-disable-next-line @next/next/no-img-element -- avatar from Cloudflare Image Resizing */}
        <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
      </span>
    );
  } else if (directToNamedExpert) {
    routingMedia = (
      <span className="border-border bg-muted flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full">
        <span className="text-foreground text-xs font-semibold">{expertInitials}</span>
      </span>
    );
  } else if (isDirect) {
    routingMedia = (
      <span className="border-border bg-muted text-muted-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full border">
        <User className="h-4.5 w-4.5" aria-hidden="true" />
      </span>
    );
  } else {
    routingMedia = (
      <span className="border-primary/25 bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full border">
        <Sparkles className="h-4.5 w-4.5" aria-hidden="true" />
      </span>
    );
  }

  let routingLabel: string;
  if (directToNamedExpert) routingLabel = `Going to ${expertName}`;
  else if (isDirect) routingLabel = 'Going to an expert';
  else routingLabel = "We'll match you with an expert";

  return (
    <div className="space-y-3">
      {/* Routing block (emphasised) */}
      <div className="border-primary/30 bg-primary/[0.04] flex items-center gap-3 rounded-xl border p-4">
        {routingMedia}
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-sm font-semibold">{routingLabel}</p>
        </div>
        <button
          type="button"
          onClick={onEdit}
          className="text-primary hover:text-primary/80 focus-visible:ring-ring inline-flex items-center gap-1 rounded-md text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          <Pencil className="h-3 w-3" aria-hidden="true" /> Edit
        </button>
      </div>

      <SummaryBlock label="Project title" onEdit={onEdit}>
        <p className="text-foreground text-sm">{draft.title.trim() || 'Untitled'}</p>
      </SummaryBlock>

      <SummaryBlock label="Description" onEdit={onEdit}>
        <RichTextViewer value={draft.descriptionHtml} />
      </SummaryBlock>

      <SummaryBlock label="Project type" onEdit={onEdit}>
        <ReadOnlyChips ids={draft.tagIds} nameMap={tagNameMap} />
      </SummaryBlock>

      <SummaryBlock label="Salesforce products" onEdit={onEdit}>
        <ReadOnlyChips ids={draft.productIds} nameMap={productNameMap} />
      </SummaryBlock>

      <SummaryBlock label="Budget & timeline" onEdit={onEdit}>
        <dl className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <dt className="text-muted-foreground">Budget</dt>
            <dd className="text-foreground text-right font-medium">
              {formatBudgetRange(draft.budgetMinCents, draft.budgetMaxCents, 'aud') ??
                'Not specified'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-3 text-sm">
            <dt className="text-muted-foreground">Timeline</dt>
            <dd className="text-foreground text-right font-medium">
              {draft.timeline ?? 'Not specified'}
            </dd>
          </div>
        </dl>
      </SummaryBlock>

      <SummaryBlock label="Documents" onEdit={onEdit}>
        {draft.documents.length === 0 ? (
          <p className="text-muted-foreground text-sm">None</p>
        ) : (
          <ul className="space-y-1.5">
            {draft.documents.map((doc) => {
              const Glyph = doc.contentType.startsWith('image/') ? ImageIcon : FileText;
              return (
                <li key={doc.r2Key} className="flex items-center gap-2 text-sm">
                  <Glyph className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="text-foreground truncate">{doc.fileName}</span>
                  <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
                    {formatBytes(doc.sizeBytes)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </SummaryBlock>
    </div>
  );
}
