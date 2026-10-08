'use client';

import { Sparkles, X, Info } from 'lucide-react';
import type { ProductsByCategory, SupportType } from '@balo/db';
import { Button } from '@/components/ui/button';
import { AddPicker, type AddPickerGroup } from './add-picker';
import type { StaffEditModel } from '../../_lib/staff-edit-model';

/**
 * BAL-593 §[F] — product expertise: chips grouped by category, a primary ring + "New" pill for a
 * staff-added product, struck-through + Undo for a removed one, and the removal info note.
 * Design ref 1703-1793.
 *
 * Removing a product never deletes `draft.ratings[productId]` — only its membership in
 * `draft.products` — so re-adding (here or from `RatingsSection`'s `RemovedProductCard`) restores
 * the exact ratings it had a moment ago, and a remove-then-re-add with nothing else touched plans
 * to no delta (`buildStaffEdit`).
 */

export interface ProductsEditSectionProps {
  readonly draft: StaffEditModel;
  readonly initial: StaffEditModel;
  readonly update: (fn: (draft: StaffEditModel) => StaffEditModel) => void;
  readonly productsByCategory: readonly ProductsByCategory[];
  readonly supportTypes: readonly SupportType[];
  readonly disabled: boolean;
}

export function addProductToDraft(
  draft: StaffEditModel,
  productId: string,
  supportTypes: readonly SupportType[]
): StaffEditModel {
  const products = draft.products.includes(productId)
    ? draft.products
    : [...draft.products, productId];
  const existingRatings = draft.ratings[productId];
  const ratings = existingRatings
    ? draft.ratings
    : {
        ...draft.ratings,
        [productId]: Object.fromEntries(supportTypes.map((st) => [st.id, { self: null, balo: 0 }])),
      };
  return { ...draft, products, ratings };
}

export function removeProductFromDraft(draft: StaffEditModel, productId: string): StaffEditModel {
  return { ...draft, products: draft.products.filter((id) => id !== productId) };
}

export function ProductsEditSection({
  draft,
  initial,
  update,
  productsByCategory,
  supportTypes,
  disabled,
}: Readonly<ProductsEditSectionProps>): React.JSX.Element {
  const isVisible = (id: string): boolean =>
    draft.products.includes(id) || initial.products.includes(id);

  const groups = productsByCategory
    .map((cat) => ({
      category: cat.category.name,
      items: cat.products.filter((p) => isVisible(p.id)),
    }))
    .filter((g) => g.items.length > 0);

  const availableGroups: AddPickerGroup[] = productsByCategory
    .map((cat) => ({
      heading: cat.category.name,
      items: cat.products
        .filter((p) => !draft.products.includes(p.id))
        .map((p) => ({ id: p.id, name: p.name })),
    }))
    .filter((g) => g.items.length > 0);

  const removedCount = initial.products.filter((id) => !draft.products.includes(id)).length;

  const addProduct = (productId: string): void => {
    update((d) => addProductToDraft(d, productId, supportTypes));
  };
  const removeProduct = (productId: string): void => {
    update((d) => removeProductFromDraft(d, productId));
  };

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="bg-muted flex size-[26px] items-center justify-center rounded-[7px]">
            <Sparkles className="text-muted-foreground size-3.5" aria-hidden="true" />
          </div>
          <p className="text-muted-foreground text-[11px] font-semibold tracking-[0.08em] uppercase">
            Product expertise
          </p>
        </div>
        <AddPicker
          label="Add product"
          groups={availableGroups}
          onPick={addProduct}
          disabled={disabled}
        />
      </div>
      <div className="border-border bg-card rounded-xl border p-5">
        {groups.length === 0 && (
          <p className="text-muted-foreground text-xs">
            No products yet — add what this expert can support.
          </p>
        )}
        {groups.map((group, i) => (
          <div key={group.category} className={i === 0 ? '' : 'mt-4'}>
            <p className="text-muted-foreground mb-2 text-[11px] font-semibold tracking-wide uppercase">
              {group.category}
            </p>
            <div className="flex flex-wrap gap-2">
              {group.items.map((p) =>
                draft.products.includes(p.id) ? (
                  <span
                    key={p.id}
                    className={
                      'bg-primary/10 text-primary inline-flex h-7 items-center gap-1 rounded-full py-0.5 pr-1 pl-3 text-xs font-medium' +
                      (initial.products.includes(p.id) ? '' : ' ring-primary ring-2')
                    }
                  >
                    {p.name}
                    {!initial.products.includes(p.id) && (
                      <span className="ml-1 text-[10.5px] font-bold">New</span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={disabled}
                      aria-label={`Remove ${p.name}`}
                      onClick={() => removeProduct(p.id)}
                    >
                      <X className="size-3" aria-hidden="true" />
                    </Button>
                  </span>
                ) : (
                  <span
                    key={p.id}
                    className="border-border text-muted-foreground inline-flex h-7 items-center gap-1 rounded-full border border-dashed py-0.5 pr-1 pl-3 text-xs"
                  >
                    <s>{p.name}</s>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={`Undo removing ${p.name}`}
                      onClick={() => addProduct(p.id)}
                    >
                      Undo
                    </Button>
                  </span>
                )
              )}
            </div>
          </div>
        ))}
        {removedCount > 0 && (
          <p className="text-muted-foreground border-border mt-4 flex items-start gap-2 border-t pt-3 text-xs leading-relaxed">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Removing a product deletes its ratings when you save. The expert’s self-ratings stay in
            the audit record.
          </p>
        )}
      </div>
    </section>
  );
}
