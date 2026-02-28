# Components & Forms — Balo

## Component Architecture

```
apps/web/src/components/
├── ui/                    # Shadcn base primitives (auto-generated, don't customize)
│   ├── button.tsx
│   ├── card.tsx
│   ├── input.tsx
│   └── ...
├── enhanced/              # shadcnspace variants (DEFAULT for user-facing UI)
│   ├── input-floating.tsx       # @shadcn-space/input-09: floating label
│   ├── input-validation.tsx     # @shadcn-space/input-04: real-time validation + password strength
│   ├── input-error.tsx          # @shadcn-space/input-14: error state
│   ├── input-required.tsx       # @shadcn-space/input-15: required indicator
│   ├── input-character-count.tsx # @shadcn-space/input-06: character counter
│   ├── input-search.tsx         # @shadcn-space/input-10: clear button
│   ├── input-addons.tsx         # @shadcn-space/input-08: URL prefix/suffix
│   └── card-hover.tsx           # Card with Motion hover lift
└── balo/                  # Domain-specific components
    ├── expert-card.tsx
    ├── case-status-badge.tsx
    ├── credit-balance.tsx
    ├── availability-indicator.tsx
    └── auth-modal.tsx
```

**Shadcn components:** Generated via CLI, live in `ui/`. Don't customize these directly — extend via composition. Only use directly when no shadcnspace alternative exists.

**Shadcnspace components (DEFAULT):** Copy from shadcnspace.com, adapt to Balo tokens. Live in `enhanced/`. These ARE customized. **Always check shadcnspace first before using a plain shadcn component for user-facing UI.**

**Balo components:** Domain-specific, built on top of enhanced + shadcn + Motion. Live in `balo/`.

## Shadcnspace Component Guide

### When to Use Enhanced vs Base

**Default to shadcnspace.** Only fall back to plain shadcn when no enhanced variant exists or the component is purely structural.

| Scenario                               | Use                                            | Why                                        |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| Any text input in a form               | `@shadcn-space/input-09` (floating label)      | Polished, saves space, animates on focus   |
| Input that needs validation feedback   | `@shadcn-space/input-04`                       | Integrated error/success color transitions |
| Input with error state                 | `@shadcn-space/input-14`                       | Pre-styled destructive color error input   |
| Required field indicator               | `@shadcn-space/input-15`                       | Integrated asterisk + label styling        |
| Bio/description with length limit      | `@shadcn-space/input-06`                       | Built-in character counter                 |
| Password field                         | `@shadcn-space/input-04` (password + strength) | Show/hide toggle + strength indicator      |
| Search field with clear                | `@shadcn-space/input-10`                       | Clear button, works with search patterns   |
| URL/domain input                       | `@shadcn-space/input-08`                       | https:// prefix, .com suffix add-ons       |
| Clickable card (expert, pricing)       | shadcnspace Card + Motion hover                | Hover lift + shadow = feels interactive    |
| Auth forms (login, signup)             | shadcnspace Auth blocks                        | Social buttons, dividers, layout polish    |
| Stat/metric display                    | shadcnspace Stats blocks                       | Trend arrows, sparklines, comparison       |
| Empty states                           | shadcnspace Empty state blocks                 | Illustration + CTA, consistent pattern     |
| File/image upload                      | `@shadcn-space/file-upload-01`                 | Drag-and-drop, preview, progress bar       |
| Animated counter (credits, stats)      | `@magicui/number-ticker`                       | Smooth count-up animation                  |
| Glowing card border (premium feel)     | `@magicui/border-beam`                         | Animated border glow effect                |
| Simple label-only input (rare)         | shadcn `Input`                                 | Only if floating label is genuinely wrong  |
| Static info card (no interaction)      | shadcn `Card`                                  | No click/hover behavior needed             |
| Basic dropdown                         | shadcn `Select`                                | Standard behavior, no enhanced needed      |
| Multi-select with search               | shadcn `Combobox` (Command)                    | Skill selection — no shadcnspace equiv     |
| Simple date field (due dates, filters) | shadcn Calendar (react-day-picker)             | Date-only picking                          |
| Consultation booking                   | `@shadcn-space/calendar-03`                    | Date + available time slots side by side   |

### Installing Shadcnspace Components

**Preferred: CLI install (always try this first)**

The `@shadcn-space` registry is configured in `apps/web/components.json`.

```bash
# From the apps/web directory:
npx shadcn@latest add @shadcn-space/input-04    # Password validation
npx shadcn@latest add @shadcn-space/input-09    # Floating label
npx shadcn@latest add @shadcn-space/input-14    # Error state
npx shadcn@latest add @shadcn-space/input-15    # Required indicator
npx shadcn@latest add @shadcn-space/input-08    # URL add-ons
npx shadcn@latest add @shadcn-space/input-06    # Character counter
npx shadcn@latest add @shadcn-space/input-10    # Clear button

# Or use direct URL (fallback)
npx shadcn@latest add https://shadcnspace.com/r/input-04.json
```

**After CLI install:**

1. Move the generated file from `components/ui/` to `components/enhanced/`
2. **Run the Normalization Checklist (below)**
3. Test in both light and dark mode
4. Commit

**Registry JSON pattern:** `https://shadcnspace.com/r/{component-name}.json`
**GitHub source:** `https://github.com/shadcnspace/shadcnspace/tree/main/src`

**For Magic UI visual effects:**

```bash
npx shadcn@latest add @magicui/number-ticker    # Animated counters (credits)
npx shadcn@latest add @magicui/border-beam      # Glowing card borders
npx shadcn@latest add @magicui/shimmer-button    # Premium CTA buttons
```

### Component Normalization Checklist

**MANDATORY** before committing any shadcnspace (or any third-party) component. This is what keeps styling consistent across libraries.

#### Colors — No Hardcoded Values

```
Find & replace:
  text-gray-*    → text-muted-foreground / text-foreground
  text-slate-*   → text-muted-foreground / text-foreground
  bg-gray-*      → bg-muted / bg-background / bg-card
  bg-slate-*     → bg-muted / bg-background / bg-card
  bg-white       → bg-background or bg-card
  bg-black       → bg-foreground
  border-gray-*  → border-border
  border-slate-* → border-border
  ring-gray-*    → ring-ring
  #XXXXXX        → CSS variable equivalent
  rgb()/hsl()    → CSS variable equivalent
```

Any hardcoded color is a dark mode bug waiting to happen.

#### Border Radius — Pick One, Use Everywhere

Balo standard: `rounded-lg` (8px). Normalize:

```
rounded-sm  → rounded-lg  (unless intentionally subtle, e.g. inner elements)
rounded     → rounded-lg
rounded-md  → rounded-lg
rounded-xl  → rounded-lg  (unless it's a card/container, which uses rounded-xl)
```

Hierarchy: Cards/containers use `rounded-xl`, interactive elements use `rounded-lg`, small badges use `rounded-md`.

#### Spacing — Match Balo Density

```
p-2, p-3 on cards → p-5 or p-6 (Monday-level spacious)
gap-1, gap-2      → gap-3 or gap-4 (breathing room)
py-2 on sections  → py-16 to py-24 (marketing), py-6 to py-8 (app)
```

If the component feels cramped after pulling it, the spacing is probably wrong.

#### Typography — Consistent Weights and Sizes

```
font-bold   → font-semibold  (Balo never uses bold on headings)
font-light  → font-normal    (light is too thin)
text-[13px] → text-sm        (use Tailwind scale, not arbitrary)
```

#### Shadows — Subtle, Not Heavy

```
shadow-lg (on resting cards) → shadow-sm or shadow
shadow-xl → shadow-md (reserve for hover states)
```

Resting state: `shadow-sm`. Hover: `shadow-lg`. Never `shadow-xl` or `shadow-2xl`.

#### Focus & Accessibility

Ensure the component has:

```
focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2
```

If the original uses `focus:ring` (without `-visible`), change it. Focus rings should only appear for keyboard users, not mouse clicks.

#### Dark Mode Verification

After normalizing:

1. Toggle to dark mode
2. Check every text color is readable (contrast ≥ 4.5:1)
3. Check borders are visible but subtle
4. Check backgrounds aren't the same as their parent
5. Check status colors still pop (success green, error red)

#### Quick Regex Audit

Run this in your editor to find remaining issues:

```bash
# Find hardcoded colors
grep -n "text-gray\|text-slate\|bg-gray\|bg-slate\|bg-white\|bg-black\|border-gray\|border-slate" component.tsx

# Find hardcoded hex/rgb
grep -n "#[0-9a-fA-F]\{3,6\}\|rgb(\|rgba(" component.tsx

# Find font-bold (should be font-semibold)
grep -n "font-bold" component.tsx
```

If any of these return results, the component isn't ready to commit.

## Expert Card — Anatomy

The expert card is Balo's most important component. It appears in search results, marketplace browsing, and recommendations.

```tsx
// packages/ui/src/components/balo/expert-card.tsx
'use client';

import { motion } from 'motion/react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Star } from 'lucide-react';
import { AvailabilityIndicator } from './availability-indicator';

interface ExpertCardProps {
  expert: {
    id: string;
    firstName: string;
    lastName: string;
    title: string;
    avatarUrl: string | null;
    hourlyRateCents: number;
    rating: number;
    reviewCount: number;
    topCertification: string;
    certificationColor: string;
    availability: 'available_now' | 'available_today' | 'available_this_week' | 'unavailable';
    nextAvailableSlot?: string;
  };
  onClick?: () => void;
}

export function ExpertCard({ expert, onClick }: ExpertCardProps) {
  const rate = (expert.hourlyRateCents / 100).toFixed(0);

  return (
    <motion.div
      whileHover={{ y: -4 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      onClick={onClick}
      className="cursor-pointer"
    >
      <Card className="dark:hover:shadow-primary/5 border-border border p-5 transition-shadow duration-200 hover:shadow-lg">
        {/* Header: Avatar + Name */}
        <div className="flex items-center gap-3">
          <div className="relative">
            <img
              src={expert.avatarUrl || '/default-avatar.png'}
              alt={`${expert.firstName} ${expert.lastName}`}
              className="border-border group-hover:border-primary/20 h-11 w-11 rounded-xl border-2 object-cover transition-colors duration-200"
            />
            <AvailabilityIndicator status={expert.availability} />
          </div>
          <div>
            <p className="text-foreground text-sm font-semibold">
              {expert.firstName} {expert.lastName}
            </p>
            <p className="text-muted-foreground text-xs">{expert.title}</p>
          </div>
        </div>

        {/* Certification + Rating */}
        <div className="mt-3 flex items-center gap-2">
          <Badge
            variant="outline"
            className="text-xs font-semibold"
            style={{
              backgroundColor: `${expert.certificationColor}0D`,
              color: expert.certificationColor,
              borderColor: `${expert.certificationColor}33`,
            }}
          >
            {expert.topCertification}
          </Badge>
          <span className="text-muted-foreground ml-auto flex items-center gap-1 text-xs font-medium">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
            {expert.rating.toFixed(1)}
            <span className="text-muted-foreground/60">({expert.reviewCount})</span>
          </span>
        </div>

        {/* Rate + Availability */}
        <div className="border-border mt-3 flex items-center justify-between border-t pt-3">
          <span className="text-foreground text-base font-semibold">
            ${rate}
            <span className="text-muted-foreground text-xs font-normal">/hr</span>
          </span>
          <span
            className={`text-xs font-medium ${
              expert.availability === 'available_now' ? 'text-success' : 'text-muted-foreground'
            }`}
          >
            {expert.availability === 'available_now'
              ? 'Available now'
              : expert.nextAvailableSlot || 'Check availability'}
          </span>
        </div>
      </Card>
    </motion.div>
  );
}
```

### Availability Indicator

Green pulsing dot for "available now":

```tsx
export function AvailabilityIndicator({ status }: { status: string }) {
  if (status !== 'available_now') return null;

  return (
    <span className="absolute -right-0.5 -bottom-0.5 flex h-3 w-3">
      <span className="bg-success absolute inline-flex h-full w-full animate-ping rounded-full opacity-75" />
      <span className="bg-success border-background relative inline-flex h-3 w-3 rounded-full border-2" />
    </span>
  );
}
```

## Form Patterns

### Form Layout

```tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Form, FormField, FormItem, FormControl, FormMessage } from '@/components/ui/form';
import { InputFloating } from '@/components/enhanced/input-floating';
import { InputCharacterCount } from '@/components/enhanced/input-character-count';
import { Button } from '@/components/ui/button';

const schema = z.object({
  title: z.string().min(3, 'Title must be at least 3 characters'),
  description: z.string().max(500, 'Description too long').optional(),
});

export function CreateCaseForm({ onSubmit }: { onSubmit: (data: z.infer<typeof schema>) => void }) {
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { title: '', description: '' },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                {/* shadcnspace Input-08: floating label animates on focus */}
                <InputFloating
                  label="Title"
                  placeholder="Describe your Salesforce challenge"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                {/* shadcnspace Input-06: character counter for length-limited fields */}
                <InputCharacterCount label="Description (optional)" maxLength={500} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Creating...' : 'Create Case'}
        </Button>
      </form>
    </Form>
  );
}
```

### Form Rules

- **Always** use React Hook Form + Zod resolver
- **Always** show validation errors inline (not toast)
- **Always** disable submit button while submitting
- **Always** show loading state in submit button text
- **Always** toast on successful submission (see layouts-states.md Toast Rules)
- **Never** use uncontrolled inputs for forms with validation
- **Never** use alerts/modals for validation errors — use `FormMessage`
- Input labels above the field, not as placeholder text (accessibility)
- Error messages appear below the field, not in a toast

### Contextual Help — Making Things Clear Without Clutter

**Principle:** If a user might pause and wonder "what does this mean?", you need help text. But hover-only tooltips are invisible on mobile. Use the right pattern for the context.

#### Tier 1: Persistent Helper Text (Forms)

For form fields, use `FormDescription` — always visible, works everywhere.

```tsx
<FormField
  control={form.control}
  name="hourlyRate"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Hourly Rate</FormLabel>
      <FormControl>
        <Input type="number" placeholder="150" {...field} />
      </FormControl>
      <FormDescription>
        This is what you charge per hour. Clients see this rate plus a 25% platform fee.
      </FormDescription>
      <FormMessage />
    </FormItem>
  )}
/>
```

**When to use:** Any form field where the label alone doesn't fully explain what's expected, what the impact is, or what format is needed.

**Examples that need helper text:**

- "Hourly Rate" → explain markup visibility
- "Availability Window" → explain what this controls
- "Slug" → explain where this appears

**Examples that DON'T need it:**

- "First Name" — obvious
- "Email Address" — obvious
- "Password" — obvious (but confirm requirements in FormDescription)

#### Tier 2: Tooltip + Popover Hybrid (Data Displays)

For dashboard metrics, status badges, or column headers that might be unclear. Desktop gets hover tooltip, mobile gets tap popover.

```tsx
'use client';

import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useIsMobile } from '@/hooks/use-mobile';

interface InfoHintProps {
  content: string;
  className?: string;
}

export function InfoHint({ content, className }: InfoHintProps) {
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              'inline-flex items-center justify-center rounded-full',
              'text-muted-foreground hover:text-foreground transition-colors',
              'ml-1 h-5 w-5',
              className
            )}
            aria-label="More information"
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="max-w-[260px] text-sm" side="top">
          {content}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex items-center justify-center',
              'text-muted-foreground hover:text-foreground transition-colors',
              'ml-1 h-5 w-5 cursor-help',
              className
            )}
          >
            <Info className="h-3.5 w-3.5" />
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[260px]">{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// Usage — next to a dashboard metric:
<div className="flex items-center">
  <span className="text-muted-foreground text-sm font-medium">Utilization Rate</span>
  <InfoHint content="Percentage of your available hours that were booked in the last 30 days." />
</div>;
```

**When to use:** Dashboard stats, table column headers, status labels, pricing breakdowns — anywhere a label is concise but the concept needs explanation.

#### Tier 3: Inline Explanation (Complex UI)

For truly complex interactions (e.g. pricing calculator, availability setup), don't use tooltips at all. Put the explanation directly in the UI as muted text.

```tsx
<div className="space-y-3">
  <h3 className="text-sm font-semibold">Weekly Availability</h3>
  <p className="text-muted-foreground text-sm">
    Set the hours you're available for consultations. Clients can only book within these windows.
    Times are shown in your local timezone ({timezone}).
  </p>
  {/* Availability grid */}
</div>
```

#### Decision Guide

```
Is it a form field?
  → YES: Use FormDescription (Tier 1)
  → NO: ↓

Is the concept explainable in one sentence?
  → YES: Use InfoHint tooltip/popover (Tier 2)
  → NO: ↓

Is it a complex flow or multi-step process?
  → YES: Use inline explanation paragraph (Tier 3)
  → NO: The label probably just needs rewriting
```

#### Mobile Hook

```tsx
// hooks/use-mobile.ts
'use client';

import { useEffect, useState } from 'react';

export function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < breakpoint);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [breakpoint]);

  return isMobile;
}
```

### Button Variants

| Context          | Variant                 | Example             |
| ---------------- | ----------------------- | ------------------- |
| Primary CTA      | `default`               | "Book Consultation" |
| Secondary action | `outline`               | "View Profile"      |
| Destructive      | `destructive`           | "Cancel Case"       |
| Subtle/tertiary  | `ghost`                 | "Skip for now"      |
| In-toolbar       | `ghost` + `size="icon"` | Edit, Delete icons  |
| Link-style       | `link`                  | "Forgot password?"  |

### Button Sizing

```tsx
// Primary CTA — prominent, full-width on mobile
<Button size="lg" className="w-full sm:w-auto">Book Consultation</Button>

// Standard action
<Button>Save Changes</Button>

// Compact/toolbar
<Button size="sm" variant="ghost">Edit</Button>

// Icon-only
<Button size="icon" variant="ghost"><Pencil className="h-4 w-4" /></Button>
```

## Status Badges

Consistent status indication across the app:

```tsx
const statusConfig: Record<string, { label: string; variant: string; className: string }> = {
  pending: {
    label: 'Pending',
    variant: 'outline',
    className: 'border-warning/30 bg-warning/10 text-warning',
  },
  active: {
    label: 'Active',
    variant: 'outline',
    className: 'border-success/30 bg-success/10 text-success',
  },
  resolved: {
    label: 'Resolved',
    variant: 'outline',
    className: 'border-primary/30 bg-primary/10 text-primary',
  },
  cancelled: {
    label: 'Cancelled',
    variant: 'outline',
    className: 'border-destructive/30 bg-destructive/10 text-destructive',
  },
};

export function CaseStatusBadge({ status }: { status: string }) {
  const config = statusConfig[status] ?? statusConfig.pending;
  return (
    <Badge variant="outline" className={config.className}>
      {config.label}
    </Badge>
  );
}
```

## Responsive Breakpoints

Follow Tailwind defaults. Mobile-first.

```
sm: 640px   — Small tablets
md: 768px   — Tablets
lg: 1024px  — Desktop
xl: 1280px  — Wide desktop
2xl: 1536px — Ultra-wide
```

### Common Responsive Patterns

```tsx
// Grid: 1 col mobile → 2 tablet → 3 desktop
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

// Stack on mobile, row on desktop
<div className="flex flex-col sm:flex-row gap-4">

// Full width button on mobile, auto on desktop
<Button className="w-full sm:w-auto">

// Hide on mobile, show on desktop
<div className="hidden lg:block">

// Padding scales with viewport
<div className="px-4 sm:px-6 lg:px-8">
```

### Mobile-Specific Rules

- Minimum tap target: 44×44px
- Bottom navigation for primary app actions (not hamburger menu)
- Sheets (bottom drawers) instead of modals on mobile
- No hover-only interactions — everything must work with tap
