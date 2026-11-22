'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GripVertical, Info, Plus, Trash2 } from 'lucide-react';
import { MotionConfig, Reorder, useDragControls } from 'motion/react';
import { toast } from 'sonner';
import {
  PROPOSAL_CLAUSE_COUNT_FROM,
  PROPOSAL_CLAUSE_MAX_CHARS,
  PROPOSAL_CLAUSE_MAX_ITEMS,
  clauseMentionsAmount,
  normalizeClauseBody,
  splitPastedClauses,
  type ProposalClauseKind,
} from '@balo/shared/project-requests';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { nextDraftKey, type ProposalClauseDraft } from './proposal-composer-state';

interface ClauseKindCopy {
  /** The singular noun, used in aria-labels ("assumption 2"). */
  one: string;
  /** The empty row's label and, once the list has items, its placeholder. */
  add: string;
  /** The empty row's placeholder while the list has no items. */
  example: (companyName: string) => string;
  /** The toast shown when an item with text is removed. */
  removed: string;
}

export const CLAUSE_KIND_COPY: Record<ProposalClauseKind, ClauseKindCopy> = {
  assumption: {
    one: 'assumption',
    add: 'Add an assumption',
    example: (companyName) => `For example: ${companyName} gives us sandbox access by kickoff`,
    removed: 'Assumption removed',
  },
  exclusion: {
    one: 'exclusion',
    add: 'Add an exclusion',
    example: () => 'For example: Migrating historical quotes from your spreadsheets',
    removed: 'Exclusion removed',
  },
  additional_term: {
    one: 'term',
    add: 'Add a term',
    example: () => 'For example: One round of revisions is included per milestone',
    removed: 'Term removed',
  },
};

const FULL_MESSAGE = `That’s ${PROPOSAL_CLAUSE_MAX_ITEMS}, the most a list holds. Combine related points to add another.`;

const LIST_HINT = 'Enter adds the next. Paste a list to add one per line.';

/** The Sonner id of a list's "removed" toast, so the composer can dismiss it with the edit screen. */
export function clauseRemovedToastId(kind: ProposalClauseKind): string {
  return `proposal-clause-removed-${kind}`;
}

function itemFieldId(kind: ProposalClauseKind, key: string): string {
  return `proposal-clause-${kind}-${key}`;
}

function gripId(kind: ProposalClauseKind, key: string): string {
  return `proposal-clause-grip-${kind}-${key}`;
}

/** Typed or pasted line breaks become a space, and the cap holds even if `maxLength` is bypassed. */
function singleLine(text: string): string {
  return text.replaceAll(/\n+/g, ' ').slice(0, PROPOSAL_CLAUSE_MAX_CHARS);
}

const TEXTAREA_CLASS =
  'hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-ring/50 min-h-11 resize-none overflow-hidden border-transparent bg-transparent px-2 py-2.5 text-[15px] leading-6 shadow-none focus-visible:ring-2 md:text-[15px]';

type AutoGrowTextareaProps = Omit<React.ComponentProps<'textarea'>, 'ref' | 'value'> & {
  value: string;
};

/** A one-row textarea that grows to fit its text. */
function AutoGrowTextarea({
  value,
  className,
  ...rest
}: Readonly<AutoGrowTextareaProps>): React.JSX.Element {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.style.height = 'auto';
    if (element.scrollHeight > 0) element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  return (
    <Textarea
      ref={ref}
      rows={1}
      value={value}
      maxLength={PROPOSAL_CLAUSE_MAX_CHARS}
      className={cn(TEXTAREA_CLASS, className)}
      {...rest}
    />
  );
}

/** The "Enter adds the next" hint; visible only while focus is inside the list's section. */
export function ClauseListHint(): React.JSX.Element {
  return (
    <span className="text-muted-foreground invisible text-[13px] group-focus-within/clauses:visible">
      {LIST_HINT}
    </span>
  );
}

const ICON_BUTTON =
  'text-muted-foreground hover:bg-muted focus-visible:ring-ring flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none';

interface ClauseRowProps {
  kind: ProposalClauseKind;
  item: ProposalClauseDraft;
  index: number;
  companyName: string;
  priceSectionLabel: string;
  onTextChange: (key: string, text: string) => void;
  onItemKeyDown: (key: string, event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onItemBlur: (key: string) => void;
  onItemPaste: (key: string, event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onRemove: (key: string) => void;
  onMove: (key: string, direction: -1 | 1) => void;
}

function ClauseRow({
  kind,
  item,
  index,
  companyName,
  priceSectionLabel,
  onTextChange,
  onItemKeyDown,
  onItemBlur,
  onItemPaste,
  onRemove,
  onMove,
}: Readonly<ClauseRowProps>): React.JSX.Element {
  const controls = useDragControls();
  const { one } = CLAUSE_KIND_COPY[kind];
  const n = index + 1;
  const length = item.body.length;

  const handleGripPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>): void => controls.start(event),
    [controls]
  );
  const handleGripKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        onMove(item.key, -1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        onMove(item.key, 1);
      }
    },
    [item.key, onMove]
  );
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void =>
      onTextChange(item.key, event.target.value),
    [item.key, onTextChange]
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => onItemKeyDown(item.key, event),
    [item.key, onItemKeyDown]
  );
  const handleBlur = useCallback((): void => onItemBlur(item.key), [item.key, onItemBlur]);
  const handlePaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>): void => onItemPaste(item.key, event),
    [item.key, onItemPaste]
  );
  const handleRemove = useCallback((): void => onRemove(item.key), [item.key, onRemove]);

  return (
    <Reorder.Item
      as="li"
      value={item}
      dragListener={false}
      dragControls={controls}
      className="group bg-card border-border flex items-start gap-1.5 border-b py-0.5 pr-1 pl-1.5"
    >
      <button
        type="button"
        id={gripId(kind, item.key)}
        aria-label={`Reorder ${one} ${n}. Use the up and down arrow keys.`}
        onPointerDown={handleGripPointerDown}
        onKeyDown={handleGripKeyDown}
        className="text-muted-foreground/60 hover:text-muted-foreground focus-visible:ring-ring relative flex h-11 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-md after:absolute after:-inset-x-2 after:inset-y-0 after:content-[''] focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
      >
        <GripVertical className="size-4" aria-hidden="true" />
      </button>
      <span className="text-muted-foreground flex h-11 w-5 shrink-0 items-center justify-center text-[13px] tabular-nums">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <AutoGrowTextarea
          id={itemFieldId(kind, item.key)}
          aria-label={`${one} ${n}`}
          value={item.body}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onPaste={handlePaste}
        />
        {length >= PROPOSAL_CLAUSE_COUNT_FROM && (
          <span
            className={cn(
              'block px-2 text-right text-xs tabular-nums',
              length >= PROPOSAL_CLAUSE_MAX_CHARS ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {length} / {PROPOSAL_CLAUSE_MAX_CHARS}
          </span>
        )}
        {clauseMentionsAmount(item.body) && (
          <output className="text-warning-strong flex items-start gap-1.5 px-2 pb-2 text-[13px] leading-snug">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {companyName} would see this amount exactly as typed, without Balo’s margin. Keep
              prices in {priceSectionLabel}.
            </span>
          </output>
        )}
      </div>
      <button
        type="button"
        aria-label={`Remove ${one} ${n}`}
        onClick={handleRemove}
        className={cn(
          ICON_BUTTON,
          'hover:text-destructive group-focus-within:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100'
        )}
      >
        <Trash2 className="size-4" aria-hidden="true" />
      </button>
    </Reorder.Item>
  );
}

interface ClauseListEditorProps {
  kind: ProposalClauseKind;
  items: ProposalClauseDraft[];
  onChange: (items: ProposalClauseDraft[]) => void;
  /** The draft's id for analytics; null until the first autosave creates it. */
  proposalId: string | null;
  companyName: string;
  /** The title of the price section, named in the amount warning. */
  priceSectionLabel: string;
  /** DOM id of the empty row's textarea: the jump target for the section's checklist item. */
  newRowId: string;
}

interface RemoveOptions {
  refocus: boolean;
  undo: boolean;
}

/**
 * One ordered list of plain-text clauses (assumptions, exclusions or additional terms). Each
 * item is a single auto-growing line; the list ends in an empty row that adds the next. Enter,
 * Backspace, blur, paste and the grip's arrow keys all edit the list without a mouse.
 */
export function ClauseListEditor({
  kind,
  items,
  onChange,
  proposalId,
  companyName,
  priceSectionLabel,
  newRowId,
}: Readonly<ClauseListEditorProps>): React.JSX.Element {
  const copy = CLAUSE_KIND_COPY[kind];
  const [ghost, setGhost] = useState('');
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const warnedRef = useRef(new Set<string>());
  const full = items.length >= PROPOSAL_CLAUSE_MAX_ITEMS;

  // Focus a field once the row that owns it has rendered, with the caret at the end.
  useEffect(() => {
    if (pendingFocusId === null) return;
    const target = document.getElementById(pendingFocusId);
    if (target !== null) {
      target.focus();
      if (target instanceof HTMLTextAreaElement) {
        target.setSelectionRange(target.value.length, target.value.length);
      }
    }
    setPendingFocusId(null);
  }, [pendingFocusId, items]);

  // The amount warning is shown once per item for the life of the editor.
  useEffect(() => {
    for (const item of items) {
      if (
        proposalId !== null &&
        !warnedRef.current.has(item.key) &&
        clauseMentionsAmount(item.body)
      ) {
        warnedRef.current.add(item.key);
        track(PROJECT_EVENTS.PROPOSAL_CLAUSE_AMOUNT_WARNING_SHOWN, {
          proposal_id: proposalId,
          kind,
        });
      }
    }
  }, [items, kind, proposalId]);

  // When the 20th item lands the empty row unmounts and takes focus with it: move focus to the
  // last item and say why the row is gone.
  const wasFullRef = useRef(full);
  useEffect(() => {
    const justFilled = full && !wasFullRef.current;
    wasFullRef.current = full;
    if (!justFilled) return;
    setAnnouncement(FULL_MESSAGE);
    const last = items.at(-1);
    if (last !== undefined && document.activeElement === document.body) {
      document.getElementById(itemFieldId(kind, last.key))?.focus();
    }
  }, [full, items, kind]);

  const handleTextChange = useCallback(
    (key: string, text: string): void => {
      onChange(
        itemsRef.current.map((item) =>
          item.key === key ? { ...item, body: singleLine(text) } : item
        )
      );
    },
    [onChange]
  );

  const insertAfter = useCallback(
    (key: string): void => {
      const current = itemsRef.current;
      const at = current.findIndex((item) => item.key === key);
      if (at < 0 || current.length >= PROPOSAL_CLAUSE_MAX_ITEMS) return;
      const fresh: ProposalClauseDraft = { key: nextDraftKey(), body: '' };
      onChange([...current.slice(0, at + 1), fresh, ...current.slice(at + 1)]);
      setPendingFocusId(itemFieldId(kind, fresh.key));
    },
    [kind, onChange]
  );

  const restoreItem = useCallback(
    (removed: ProposalClauseDraft, index: number): void => {
      const current = itemsRef.current;
      if (current.some((item) => item.key === removed.key)) return;
      if (current.length >= PROPOSAL_CLAUSE_MAX_ITEMS) return;
      const at = Math.min(index, current.length);
      onChange([...current.slice(0, at), removed, ...current.slice(at)]);
    },
    [onChange]
  );

  const removeItem = useCallback(
    (key: string, { refocus, undo }: RemoveOptions): void => {
      const before = itemsRef.current;
      const at = before.findIndex((item) => item.key === key);
      const removed = before[at];
      if (removed === undefined) return;
      const after = before.filter((item) => item.key !== key);
      onChange(after);
      if (refocus) {
        const neighbour = after[at - 1] ?? after[0];
        setPendingFocusId(neighbour === undefined ? newRowId : itemFieldId(kind, neighbour.key));
      }
      if (undo && removed.body.trim().length > 0) {
        toast(copy.removed, {
          id: clauseRemovedToastId(kind),
          action: { label: 'Undo', onClick: () => restoreItem(removed, at) },
        });
      }
    },
    [copy.removed, kind, newRowId, onChange, restoreItem]
  );

  const handleRemoveClick = useCallback(
    (key: string): void => removeItem(key, { refocus: true, undo: true }),
    [removeItem]
  );

  const handleItemBlur = useCallback(
    (key: string): void => {
      const item = itemsRef.current.find((candidate) => candidate.key === key);
      if (item !== undefined && item.body.trim().length === 0) {
        removeItem(key, { refocus: false, undo: false });
      }
    },
    [removeItem]
  );

  const handleItemKeyDown = useCallback(
    (key: string, event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.nativeEvent.isComposing) return;
      const current = itemsRef.current;
      const index = current.findIndex((item) => item.key === key);
      const item = current[index];
      if (item === undefined) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        if (item.body.trim().length === 0) return;
        if (index < current.length - 1) {
          insertAfter(key);
        } else if (current.length < PROPOSAL_CLAUSE_MAX_ITEMS) {
          setPendingFocusId(newRowId);
        }
        return;
      }
      if (event.key === 'Backspace' && item.body === '') {
        event.preventDefault();
        removeItem(key, { refocus: true, undo: false });
      }
    },
    [insertAfter, newRowId, removeItem]
  );

  const move = useCallback(
    (key: string, direction: -1 | 1): void => {
      const current = itemsRef.current;
      const index = current.findIndex((item) => item.key === key);
      const target = index + direction;
      const a = current[index];
      const b = current[target];
      if (a === undefined || b === undefined) return;
      const next = [...current];
      next[index] = b;
      next[target] = a;
      onChange(next);
      setPendingFocusId(gripId(kind, key));
      setAnnouncement(`Moved ${copy.one} ${index + 1} to position ${target + 1} of ${next.length}`);
    },
    [copy.one, kind, onChange]
  );

  /** Pasting two or more lines adds one item per line; a single line pastes as ordinary text. */
  const pasteLines = useCallback(
    (key: string | null, event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
      const lines = splitPastedClauses(event.clipboardData.getData('text'));
      if (lines.length < 2) return;
      event.preventDefault();
      const current = itemsRef.current;
      const room = Math.max(0, PROPOSAL_CLAUSE_MAX_ITEMS - current.length);
      const added = lines.slice(0, room).map((body) => ({
        key: nextDraftKey(),
        body: body.slice(0, PROPOSAL_CLAUSE_MAX_CHARS),
      }));
      const at = key === null ? current.length - 1 : current.findIndex((item) => item.key === key);
      if (key !== null && at < 0) return;
      onChange([...current.slice(0, at + 1), ...added, ...current.slice(at + 1)]);
      if (key === null) setGhost('');
      if (proposalId !== null) {
        track(PROJECT_EVENTS.PROPOSAL_CLAUSES_PASTED, {
          proposal_id: proposalId,
          kind,
          line_count: lines.length,
        });
      }
      if (lines.length > room) {
        toast(
          `Added ${added.length} of ${lines.length}. A list holds up to ${PROPOSAL_CLAUSE_MAX_ITEMS}.`
        );
      }
    },
    [kind, onChange, proposalId]
  );

  const handleItemPaste = useCallback(
    (key: string, event: React.ClipboardEvent<HTMLTextAreaElement>): void => pasteLines(key, event),
    [pasteLines]
  );
  const handleGhostPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>): void => pasteLines(null, event),
    [pasteLines]
  );

  const commitGhost = useCallback((): void => {
    const body = normalizeClauseBody(ghost).slice(0, PROPOSAL_CLAUSE_MAX_CHARS);
    if (body.length === 0) return;
    onChange([...itemsRef.current, { key: nextDraftKey(), body }]);
    setGhost('');
  }, [ghost, onChange]);

  const handleGhostChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    setGhost(singleLine(event.target.value));
  }, []);

  const handleGhostKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        commitGhost();
        return;
      }
      const last = itemsRef.current.at(-1);
      if (event.key === 'Backspace' && ghost === '' && last !== undefined) {
        event.preventDefault();
        setPendingFocusId(itemFieldId(kind, last.key));
      }
    },
    [commitGhost, ghost, kind]
  );

  return (
    <div>
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <div className="border-border overflow-hidden rounded-[14px] border">
        <MotionConfig reducedMotion="user">
          <Reorder.Group as="ol" axis="y" values={items} onReorder={onChange}>
            {items.map((item, index) => (
              <ClauseRow
                key={item.key}
                kind={kind}
                item={item}
                index={index}
                companyName={companyName}
                priceSectionLabel={priceSectionLabel}
                onTextChange={handleTextChange}
                onItemKeyDown={handleItemKeyDown}
                onItemBlur={handleItemBlur}
                onItemPaste={handleItemPaste}
                onRemove={handleRemoveClick}
                onMove={move}
              />
            ))}
          </Reorder.Group>
        </MotionConfig>
        {full ? (
          <p className="text-muted-foreground px-4 py-3 text-sm">{FULL_MESSAGE}</p>
        ) : (
          <div data-flash="" className="flex items-start gap-1.5 py-0.5 pr-1 pl-1.5">
            <span aria-hidden="true" className="w-5 shrink-0" />
            <span
              aria-hidden="true"
              className="text-muted-foreground flex h-11 w-5 shrink-0 items-center justify-center"
            >
              <Plus className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1">
              <AutoGrowTextarea
                id={newRowId}
                aria-label={copy.add}
                placeholder={items.length === 0 ? copy.example(companyName) : copy.add}
                value={ghost}
                onChange={handleGhostChange}
                onKeyDown={handleGhostKeyDown}
                onBlur={commitGhost}
                onPaste={handleGhostPaste}
              />
            </div>
            <span aria-hidden="true" className="size-11 shrink-0" />
          </div>
        )}
      </div>
    </div>
  );
}
