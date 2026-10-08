'use client';

import { Gauge, Trash2, Undo2 } from 'lucide-react';
import type { ProductsByCategory, SupportType } from '@balo/db';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { RatingRowEdit } from './rating-row';
import { addProductToDraft, removeProductFromDraft } from './products-edit-section';
import type { StaffEditModel } from '../../_lib/staff-edit-model';

/**
 * BAL-593 §[F] — the ratings section: a legend, one `ProductRatingCard` per visible product, or a
 * `RemovedProductCard` with Undo for a product the staffer removed this edit. Design ref
 * 1795-1840 (section) / 1259-1359 (the cards) / 1120-1152 (the legend).
 */

function RatingLegend(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="text-muted-foreground hidden items-center gap-3.5 text-xs sm:flex"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className="bg-primary inline-block h-1.5 w-3.5 rounded-full" />
        Balo’s rating
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="bg-foreground/55 inline-block h-3 w-0.5 rounded-full" />
        Self-rating
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="border-warning/40 bg-warning/15 inline-block h-2 w-3.5 rounded-sm border" />
        Difference
      </span>
    </div>
  );
}

export interface RatingsEditSectionProps {
  readonly draft: StaffEditModel;
  readonly initial: StaffEditModel;
  readonly update: (fn: (draft: StaffEditModel) => StaffEditModel) => void;
  readonly productsByCategory: readonly ProductsByCategory[];
  readonly supportTypes: readonly SupportType[];
  readonly disabled: boolean;
}

export function RatingsEditSection({
  draft,
  initial,
  update,
  productsByCategory,
  supportTypes,
  disabled,
}: Readonly<RatingsEditSectionProps>): React.JSX.Element | null {
  const productById = new Map(
    productsByCategory.flatMap((cat) => cat.products.map((p) => [p.id, p.name] as const))
  );
  const catalogueOrder = productsByCategory.flatMap((cat) => cat.products.map((p) => p.id));
  const ids = catalogueOrder.filter(
    (id) => draft.products.includes(id) || initial.products.includes(id)
  );

  if (ids.length === 0) return null;

  const addProduct = (productId: string): void => {
    update((d) => addProductToDraft(d, productId, supportTypes));
  };
  const removeProduct = (productId: string): void => {
    update((d) => removeProductFromDraft(d, productId));
  };
  const setRating = (productId: string, supportTypeId: string, value: number): void => {
    update((d) => {
      const cells = d.ratings[productId] ?? {};
      const cell = cells[supportTypeId] ?? { self: null, balo: 0 };
      return {
        ...d,
        ratings: {
          ...d.ratings,
          [productId]: { ...cells, [supportTypeId]: { ...cell, balo: value } },
        },
      };
    });
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="bg-muted flex size-[26px] items-center justify-center rounded-[7px]">
            <Gauge className="text-muted-foreground size-3.5" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
            Ratings (0–10)
          </p>
        </div>
        <RatingLegend />
      </div>
      <div className="flex flex-col gap-3">
        {ids.map((id) => {
          const name = productById.get(id) ?? id;
          if (!draft.products.includes(id)) {
            return (
              <div
                key={id}
                className="border-border bg-background flex items-center gap-3 rounded-xl border border-dashed p-4"
              >
                <div className="flex-1">
                  <p className="text-muted-foreground text-sm font-semibold">
                    <s>{name}</s>
                  </p>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Its ratings are deleted when you save.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`Undo removing ${name}`}
                  onClick={() => addProduct(id)}
                >
                  <Undo2 className="size-3.5" aria-hidden="true" />
                  Undo
                </Button>
              </div>
            );
          }

          const cells = draft.ratings[id] ?? {};
          const originalCells = initial.products.includes(id)
            ? (initial.ratings[id] ?? null)
            : null;
          const staffAdded = supportTypes.every((st) => (cells[st.id]?.self ?? null) === null);
          const adjusted = supportTypes.filter((st) => {
            const cell = cells[st.id];
            return cell !== undefined && cell.self !== null && cell.self !== cell.balo;
          }).length;
          const changedHere =
            originalCells === null ||
            supportTypes.some((st) => originalCells[st.id]?.balo !== cells[st.id]?.balo);

          return (
            <div
              key={id}
              className={
                'border-border bg-card rounded-xl border p-4' +
                (changedHere ? ' border-l-primary border-l-[3px]' : '')
              }
            >
              <div className="mb-1 flex min-h-7 items-center gap-2">
                <p className="text-foreground flex-1 text-sm font-semibold">{name}</p>
                {staffAdded ? (
                  <Badge variant="info">Added by Balo</Badge>
                ) : (
                  adjusted > 0 && <Badge variant="warning">{adjusted} adjusted</Badge>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  aria-label={`Remove ${name}`}
                  onClick={() => removeProduct(id)}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                  Remove
                </Button>
              </div>
              <div role="group" aria-label={`${name} ratings`}>
                {supportTypes.map((st) => (
                  <RatingRowEdit
                    key={st.id}
                    productName={name}
                    supportType={st}
                    rating={cells[st.id] ?? { self: null, balo: 0 }}
                    original={originalCells ? (originalCells[st.id]?.balo ?? null) : null}
                    onChange={(value) => setRating(id, st.id, value)}
                    disabled={disabled}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
