'use client';

import { ChevronDown, Loader2, Check, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * BAL-593 §[F] — the sticky bottom save bar. Design ref 2064-2182.
 */

export interface EditSaveBarChange {
  readonly section: string;
  readonly text: string;
}

export interface EditSaveBarProps {
  readonly changes: readonly EditSaveBarChange[];
  readonly saving: boolean;
  readonly live: boolean;
  readonly firstName: string;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  /**
   * True while the experience section's lead/project
   * counts are invalid, so Save stays disabled even though there ARE changes to describe.
   */
  readonly disableSave?: boolean;
}

function groupBySection(
  changes: readonly EditSaveBarChange[]
): { section: string; texts: string[] }[] {
  const order: string[] = [];
  const bySection = new Map<string, string[]>();
  for (const change of changes) {
    const existing = bySection.get(change.section);
    if (existing) {
      existing.push(change.text);
    } else {
      bySection.set(change.section, [change.text]);
      order.push(change.section);
    }
  }
  return order.map((section) => ({ section, texts: bySection.get(section) ?? [] }));
}

export function EditSaveBar({
  changes,
  saving,
  live,
  firstName,
  open,
  onToggle,
  onCancel,
  onSave,
  disableSave = false,
}: Readonly<EditSaveBarProps>): React.JSX.Element {
  const n = changes.length;
  const grouped = groupBySection(changes);

  return (
    <div className="sticky bottom-4 z-20 mt-7">
      {open && n > 0 && (
        <div
          id="staff-edit-changes"
          className="border-border bg-card mb-2 max-h-60 overflow-y-auto rounded-xl border p-4 shadow-lg"
        >
          <p className="text-muted-foreground mb-1.5 text-[11px] font-semibold tracking-wide uppercase">
            Changes in this edit
          </p>
          <ul className="space-y-1">
            {grouped.map((group) =>
              group.texts.map((text, i) => (
                <li key={`${group.section}:${text}`} className="flex gap-3 py-0.5 text-sm">
                  <span className="text-muted-foreground w-24 shrink-0">
                    {i === 0 ? group.section : ''}
                  </span>
                  <span>{text}</span>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
      <div className="border-border bg-card flex flex-wrap items-center gap-2 rounded-xl border p-3 shadow-lg">
        <div className="min-w-[220px] flex-1">
          {n === 0 ? (
            <span className="text-muted-foreground text-sm">No changes yet</span>
          ) : (
            <button
              type="button"
              aria-expanded={open}
              aria-controls="staff-edit-changes"
              onClick={onToggle}
              className="hover:bg-muted -mx-1.5 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-semibold"
            >
              {n} {n === 1 ? 'change' : 'changes'}
              <ChevronDown
                className={cn('size-3.5 transition-transform', open && 'rotate-180')}
                aria-hidden="true"
              />
            </button>
          )}
          {live && (
            <p className="text-muted-foreground mt-0.5 flex items-start gap-1.5 text-xs leading-relaxed">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {firstName} is live on Balo. Saving updates their public profile and search results
              straight away, and emails {firstName} that Balo updated their expertise.
            </p>
          )}
        </div>
        <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={n === 0 || saving || disableSave} onClick={onSave}>
          {saving ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="size-4" aria-hidden="true" />
          )}
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
