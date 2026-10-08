'use client';

import { Globe, X, Undo2 } from 'lucide-react';
import type { Language } from '@balo/db';
import { EXPERT_LANGUAGES_MAX } from '@balo/shared/experts';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { AddPicker } from './add-picker';
import { ChangedDot } from './changed-dot';
import type { StaffEditModel } from '../../_lib/staff-edit-model';

/**
 * BAL-593 §[F] — languages, with remove/undo and an add-picker. Design ref 1467-1566.
 * Re-adding a removed language restores its ORIGINAL proficiency, never a reset default — the
 * same "restore from the locked snapshot" rule `products-edit-section` follows for ratings.
 */

const LANGUAGE_PROFICIENCIES: readonly NonNullable<
  StaffEditModel['languages']
>[number]['proficiency'][] = ['beginner', 'intermediate', 'advanced', 'native'];

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export interface LanguagesEditSectionProps {
  readonly draft: StaffEditModel;
  readonly initial: StaffEditModel;
  readonly update: (fn: (draft: StaffEditModel) => StaffEditModel) => void;
  readonly languages: readonly Language[];
  readonly disabled: boolean;
}

export function LanguagesEditSection({
  draft,
  initial,
  update,
  languages,
  disabled,
}: Readonly<LanguagesEditSectionProps>): React.JSX.Element {
  const languageById = new Map(languages.map((l) => [l.id, l]));
  const draftIds = new Set(draft.languages.map((l) => l.languageId));
  const removed = initial.languages.filter((l) => !draftIds.has(l.languageId));
  // The same cap the expert's own settings save enforces.
  const atCap = draft.languages.length >= EXPERT_LANGUAGES_MAX;

  const addLanguage = (languageId: string): void => {
    update((d) => {
      const original = initial.languages.find((l) => l.languageId === languageId);
      return {
        ...d,
        languages: [
          ...d.languages,
          { languageId, proficiency: original?.proficiency ?? 'intermediate' },
        ],
      };
    });
  };

  const removeLanguage = (languageId: string): void => {
    update((d) => ({
      ...d,
      languages: d.languages.filter((l) => l.languageId !== languageId),
    }));
  };

  const setProficiency = (
    languageId: string,
    proficiency: NonNullable<StaffEditModel['languages']>[number]['proficiency']
  ): void => {
    update((d) => ({
      ...d,
      languages: d.languages.map((l) => (l.languageId === languageId ? { ...l, proficiency } : l)),
    }));
  };

  const available = [
    {
      heading: null,
      items: languages.filter((l) => !draftIds.has(l.id)).map((l) => ({ id: l.id, name: l.name })),
    },
  ];

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="bg-muted flex size-[26px] items-center justify-center rounded-[7px]">
            <Globe className="text-muted-foreground size-3.5" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
            Languages
          </p>
        </div>
        <AddPicker
          label="Add language"
          groups={available}
          onPick={addLanguage}
          disabled={disabled || atCap}
        />
      </div>
      {atCap && (
        <p className="text-muted-foreground mb-2 text-xs">
          {/* pending-MJ */}
          Up to {EXPERT_LANGUAGES_MAX} languages — remove one to add another.
        </p>
      )}
      {draft.languages.length === 0 && removed.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No languages yet — add the ones this expert speaks.
        </p>
      ) : (
        <div className="border-border bg-card divide-border divide-y rounded-xl border">
          {draft.languages.map((l) => {
            const language = languageById.get(l.languageId);
            const before = initial.languages.find((o) => o.languageId === l.languageId);
            const isNew = !before;
            return (
              <div key={l.languageId} className="flex items-center gap-3 px-4 py-3">
                <span aria-hidden="true" className="w-6 text-lg">
                  {language?.flagEmoji ?? '🌐'}
                </span>
                <span className="text-foreground flex-1 text-sm font-medium">
                  {language?.name ?? l.languageId}
                </span>
                {isNew && (
                  <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10.5px] font-semibold">
                    New
                  </span>
                )}
                {before && before.proficiency !== l.proficiency && <ChangedDot />}
                <Select
                  value={l.proficiency}
                  disabled={disabled}
                  onValueChange={(value) =>
                    setProficiency(
                      l.languageId,
                      value as NonNullable<StaffEditModel['languages']>[number]['proficiency']
                    )
                  }
                >
                  <SelectTrigger
                    size="sm"
                    aria-label={`${language?.name ?? l.languageId} proficiency`}
                    className="w-36"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANGUAGE_PROFICIENCIES.map((level) => (
                      <SelectItem key={level} value={level}>
                        {capitalize(level)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  aria-label={`Remove ${language?.name ?? l.languageId}`}
                  onClick={() => removeLanguage(l.languageId)}
                >
                  <X className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            );
          })}
          {removed.map((l) => {
            const language = languageById.get(l.languageId);
            const name = language?.name ?? l.languageId;
            return (
              <div key={l.languageId} className="bg-muted/30 flex items-center gap-3 px-4 py-3">
                <span className="text-muted-foreground flex-1 text-sm">
                  <s>{name}</s>
                  <span className="ml-2 text-xs">Removed when you save</span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`Undo removing ${name}`}
                  onClick={() => addLanguage(l.languageId)}
                >
                  <Undo2 className="size-3.5" aria-hidden="true" />
                  Undo
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
