import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // BAL-502 FIX round — `active:scale-[.97]` is the design reference's `.bn-press` (motion spec
  // line 33: "press scale .97, 120-160ms"), applied broadly so every variant gets tactile press
  // feedback via the existing `transition-all` above (no separate `transition-transform` — that
  // would win a tailwind-merge conflict against `transition-all` and silently kill the hover
  // color/shadow transitions on every button). `gradient` overrides this with its own .98 +
  // hover lift below (the design reference's `.bn-cta`, reserved for the CTA class of button).
  // `motion-reduce:active:scale-100` is the stacked-variant idiom already proven in this repo
  // (`PaymentSection.tsx`) — it beats the plain `active:scale-[.97]` rule on source order at
  // equal specificity, so the press effect is fully inert under prefers-reduced-motion.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:scale-[.97] motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
        /**
         * BAL-502 — the signature blue→violet conversion CTA, promoted from ~20 inline
         * copies of this literal to a named variant (the design reference calls it
         * `variant="gradient"`). Reserved for conversion CTAs — never for a secondary action.
         * ⚠ BAL-493 (D3) — the marketing header's signed-out CTA is no longer "Get started"
         * and no longer `gradient`; it is now solid `--primary` "Find an expert" (`marketing-
         * header.tsx`). `gradient` itself is now reserved for the marketing HOME page's
         * (`(marketing)/_home/`) three highest-intent CTAs — the hero search submit, the
         * spotlight "Book a call", and the final CTA band — see AC-2's white-text amendment,
         * which this variant's `text-white` satisfies.
         * ⚠ tailwind-merge trap: a CONDITIONAL solid background layered over this needs an
         * explicit `bg-none` to win. See `(apply)/expert/apply/_components/wizard-action-bar.tsx:65`.
         *
         * BAL-502 FIX round — motion spec line 33 (`.bn-cta`): hover lift 1px + press scale
         * .98, both inert under `motion-reduce` via the stacked-variant idiom. `active:scale-[.98]`
         * overrides the base's broader `active:scale-[.97]` (this class string is concatenated
         * AFTER the base string, so tailwind-merge keeps this one).
         */
        gradient:
          'from-primary bg-gradient-to-r to-violet-600 text-white shadow-sm hover:shadow-md hover:-translate-y-px active:scale-[.98] motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100 dark:to-violet-500',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }): React.JSX.Element {
  const Comp = asChild ? Slot.Root : 'button';

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
