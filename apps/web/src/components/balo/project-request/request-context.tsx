import { Building2, Clock, FileText, Paperclip, User } from 'lucide-react';
import type { RequestDetailView } from '@/lib/project-request/request-detail-view';
import { RequestCard } from './request-card';
import { RichText } from './rich-text';
import { DocumentList } from './document-list';

interface RequestContextProps {
  view: RequestDetailView;
  /** `full` = Phase-1 hero / admin main stage. `compact` = Phase-2 3-card panel. */
  variant: 'full' | 'compact';
}

/** Uppercase section eyebrow used across the cards. */
function SectionLabel({
  icon: Icon,
  children,
}: Readonly<{
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <div className="text-muted-foreground mb-3 flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="text-[11px] font-bold tracking-wider uppercase">{children}</span>
    </div>
  );
}

function ProductChips({ products }: Readonly<{ products: { name: string }[] }>): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {products.map((p) => (
        <span
          key={p.name}
          className="border-primary/30 bg-primary/5 text-primary inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
        >
          {p.name}
        </span>
      ))}
    </div>
  );
}

/** Label → value row for the compact Details card. */
function DetailRow({
  label,
  value,
}: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground text-right font-medium">{value}</span>
    </div>
  );
}

/** Boxed stat (Phase-1 hero Budget / Timeline). */
function HeroStat({ label, value }: Readonly<{ label: string; value: string }>): React.JSX.Element {
  return (
    <div className="bg-muted rounded-xl px-3.5 py-2.5">
      <p className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
        {label}
      </p>
      <p className="text-foreground mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function CompactRequestContext({ view }: Readonly<{ view: RequestDetailView }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3.5">
      {/* Card 1 — Request: title + product chips + bounded-scroll description. */}
      <RequestCard className="overflow-hidden">
        <div className="border-border border-b p-4 pb-3">
          <SectionLabel icon={FileText}>The request</SectionLabel>
          <h2 className="text-foreground mb-2 text-[15px] leading-snug font-semibold">
            {view.title}
          </h2>
          {view.products.length > 0 && <ProductChips products={view.products} />}
        </div>
        {/* ONLY the description scrolls — the single unbounded-length element. */}
        <div className="max-h-[200px] overflow-y-auto p-4">
          <RichText html={view.descriptionHtml} size="sm" />
        </div>
      </RequestCard>

      {/* Card 2 — Details: always renders the Posted row; Budget / Timeline /
          Contact are conditional rows inside it. Never empty. */}
      <RequestCard className="p-4">
        <SectionLabel icon={Building2}>Details</SectionLabel>
        <div className="flex flex-col gap-2.5">
          {view.budget !== null && <DetailRow label="Budget" value={view.budget} />}
          {view.timeline !== null && <DetailRow label="Timeline" value={view.timeline} />}
          {view.contact !== null && <DetailRow label="Contact" value={view.contact.name} />}
          <DetailRow label="Posted" value={`Posted ${view.postedRelative}`} />
        </div>
      </RequestCard>

      {/* Card 3 — Documents (fully visible, never behind a scroll). */}
      <RequestCard className="p-4">
        <SectionLabel icon={Paperclip}>Request documents</SectionLabel>
        <DocumentList documents={view.documents} compact />
      </RequestCard>
    </div>
  );
}

function FullRequestContext({ view }: Readonly<{ view: RequestDetailView }>): React.JSX.Element {
  const hasStats = view.budget !== null || view.timeline !== null;

  return (
    <RequestCard className="p-6">
      {(view.products.length > 0 || view.tags.length > 0) && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <ProductChips products={view.products} />
          {view.tags.map((t) => (
            <span
              key={t.name}
              className="border-border bg-muted text-muted-foreground inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
            >
              {t.name}
            </span>
          ))}
        </div>
      )}

      {/* Section heading under the dashboard chrome's page <h1> (TopNav) — h2, not
          h1, so the request detail has a single page-level heading. */}
      <h2 className="text-foreground mb-1.5 text-2xl font-semibold tracking-[-0.01em]">
        {view.title}
      </h2>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <span className="inline-flex items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
          {view.companyName}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Posted {view.postedRelative}
        </span>
        {view.contact !== null && (
          <span className="inline-flex items-center gap-1.5">
            <User className="h-3.5 w-3.5" aria-hidden="true" />
            {view.contact.name}
          </span>
        )}
      </div>

      <div className="mt-4">
        <RichText html={view.descriptionHtml} size="base" />
      </div>

      {hasStats && (
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {view.budget !== null && <HeroStat label="Budget" value={view.budget} />}
          {view.timeline !== null && <HeroStat label="Timeline" value={view.timeline} />}
        </div>
      )}

      <div className="mt-5">
        <SectionLabel icon={Paperclip}>Attached documents</SectionLabel>
        <DocumentList documents={view.documents} />
      </div>
    </RequestCard>
  );
}

/**
 * The request brief in two renderings. `full` is the Phase-1 hero (and the admin
 * main stage); `compact` is the bounded three-card Phase-2 context panel. Contact
 * visibility is enforced upstream in the mapper (`view.contact` is `null` when
 * gated) — this component renders only what the view-model carries.
 */
export function RequestContext({
  view,
  variant,
}: Readonly<RequestContextProps>): React.JSX.Element {
  if (variant === 'compact') return <CompactRequestContext view={view} />;
  return <FullRequestContext view={view} />;
}
