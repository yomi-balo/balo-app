'use client';

import { CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PROPOSAL_CHANGE_SECTIONS,
  type ProposalChangeSection,
} from '@balo/shared/project-requests';
import { COMPOSER_TARGET } from './proposal-composer-state';
import { personAtCompany } from './proposal-format';

type ChangeSection = ProposalChangeSection;

/** "asked for a change to {phrase}". */
const SECTION_PHRASE: Record<ChangeSection, string> = {
  general: 'the proposal',
  milestones: 'the milestones',
  pricing: 'the pricing',
  payment_terms: 'the payment schedule',
  timeline: 'the timeline',
};

/** Short noun used in the checklist item "{name}'s note on {noun} isn't marked as addressed". */
export const CHANGE_SECTION_NOUN: Record<ChangeSection, string> = {
  general: 'the proposal',
  milestones: 'milestones',
  pricing: 'pricing',
  payment_terms: 'payments',
  timeline: 'the timeline',
};

/** Narrow the DB `proposalChangeSectionEnum` string; anything unknown reads as general. */
export function asChangeSection(section: string): ChangeSection {
  return PROPOSAL_CHANGE_SECTIONS.find((candidate) => candidate === section) ?? 'general';
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase();
}

interface ChangeRequestNoteProps {
  /** The DB `proposalChangeSectionEnum` value; picks the heading phrase. */
  section: string;
  clientName: string;
  /** The client company, named alongside the person on the first mention only. */
  company?: string | null;
  note: string;
  addressed: boolean;
  onToggle: () => void;
}

/**
 * The client's change request pinned beside the section it is about (revise mode).
 * A jump target (`data-flash`, focusable) that collapses to a "Marked as addressed"
 * line once the expert ticks it off; "Show note" brings the quote back.
 */
export function ChangeRequestNote({
  section,
  clientName,
  company,
  note,
  addressed,
  onToggle,
}: Readonly<ChangeRequestNoteProps>): React.JSX.Element {
  return (
    <div
      id={COMPOSER_TARGET.changeNote}
      data-flash=""
      tabIndex={-1}
      className={cn(
        'mb-5 grid grid-cols-[2rem_minmax(0,1fr)] gap-3 rounded-[14px] border p-4 outline-none',
        addressed ? 'border-border bg-card' : 'border-info/30 bg-info/10'
      )}
    >
      <span
        aria-hidden="true"
        className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-full text-xs font-semibold"
      >
        {initialsOf(clientName)}
      </span>
      <div className="min-w-0">
        <p className="text-foreground/80 text-sm">
          <strong className="text-foreground font-semibold">
            {personAtCompany(clientName, company)}
          </strong>{' '}
          asked for a change to {SECTION_PHRASE[asChangeSection(section)]}
        </p>
        {addressed ? (
          <span className="text-success-strong mt-1 inline-flex items-center gap-1.5 text-[13.5px]">
            <CheckCircle2 className="size-3.5" aria-hidden="true" />
            Marked as addressed
          </span>
        ) : (
          <p className="text-foreground mt-1.5 text-[14.5px] whitespace-pre-wrap">
            &ldquo;{note}&rdquo;
          </p>
        )}
        <button
          type="button"
          onClick={onToggle}
          className="text-primary focus-visible:ring-ring mt-1 flex min-h-11 w-fit items-center rounded text-[13.5px] font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {addressed ? 'Show note' : 'Mark as addressed'}
        </button>
      </div>
    </div>
  );
}
