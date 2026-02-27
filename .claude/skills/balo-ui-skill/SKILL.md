---
name: balo-ui
description: Balo design system and UI component patterns using Shadcn/ui, shadcnspace, Motion, and Tailwind CSS. Use when building any user-facing component, page, or layout. Covers color tokens, typography, spacing, dark mode, micro-interactions, animations, loading/empty/error states, form patterns, responsive design, and component selection (when to use base shadcn vs shadcnspace enhanced variants). Follows Monday.com-inspired density and Lumen-inspired gradient polish.
---

# Balo UI — Design System

## Design DNA

**Tone:** Professional confidence with modern warmth. Not boring enterprise, not chaotic startup. Polished, approachable, trustworthy — a platform that justifies $200+/hr consultant rates.

**Target users:** Technology consultants and enterprise clients. They need to trust the platform with real money and real projects. The UI must feel premium enough to match the service quality.

**References:**

- **Monday.com** — Navigation, spacing, micro-interactions, spacious density
- **Lumen template** (shadcnblocks.com) — Gradient glows, SaaS polish, hero sections
- **Linear** — Keyboard navigation, snappy transitions (but NOT Linear's density — too compact)

### Design Quality Principles

**Commit to a cohesive aesthetic.** Every screen should feel like it belongs to the same product. Dominant brand color with sharp accents outperforms a timid, evenly-distributed palette. When in doubt, lean into Balo Blue confidently.

**Typography carries authority.** The font stack is the first thing that communicates "professional platform" or "template site." Pair display headings with refined body text. Never settle for defaults when a distinctive choice elevates the experience.

**Orchestrate motion, don't scatter it.** One well-choreographed page load with staggered reveals creates more delight than random hover effects everywhere. Focus animation budget on high-impact moments: first paint, meaningful state changes, success confirmations.

**Create atmosphere, not just layouts.** Backgrounds should create depth — subtle gradients, layered transparencies, gentle texture. Avoid flat white pages with floating cards. The space between and around components matters as much as the components themselves.

**Every detail is intentional.** Shadows should have consistent direction. Border radii should be from a defined set. Spacing should follow a scale. Accidental inconsistency signals carelessness; intentional variation signals sophistication.

## Component Stack

```
Tailwind CSS          → Utility-first styling, design tokens via CSS variables
    ↓
Shadcn/ui             → Base primitives (Button, Input, Dialog, Card, etc.)
    ↓
shadcnspace           → Enhanced variants with micro-interactions
    ↓
Motion (motion.dev)   → Animations, scroll effects, page transitions
    ↓
Balo custom           → Domain-specific components (ExpertCard, CaseTimeline, etc.)
```

**Import:** `import { motion } from "motion/react"`

## Decision Tree

**Building a form?** → Read [references/components-forms.md](references/components-forms.md)
**Adding animations or transitions?** → Read [references/motion-patterns.md](references/motion-patterns.md)
**Creating a page layout or data display?** → Read [references/layouts-states.md](references/layouts-states.md)

## Color System

### CSS Variables (globals.css)

```css
:root {
  --primary: 217 91% 50%; /* Balo Blue */
  --primary-foreground: 0 0% 100%;
  --background: 0 0% 100%;
  --foreground: 222 47% 11%;
  --card: 0 0% 100%;
  --card-foreground: 222 47% 11%;
  --muted: 210 40% 96%;
  --muted-foreground: 215 16% 47%;
  --border: 214 32% 91%;
  --input: 214 32% 91%;
  --ring: 217 91% 50%;
  --success: 142 76% 36%;
  --warning: 38 92% 50%;
  --destructive: 0 84% 60%;
}

.dark {
  --primary: 217 91% 60%; /* Brighter for dark contrast */
  --primary-foreground: 0 0% 100%;
  --background: 222 47% 5%;
  --foreground: 210 40% 98%;
  --card: 222 47% 8%;
  --card-foreground: 210 40% 98%;
  --muted: 217 33% 17%;
  --muted-foreground: 215 20% 65%;
  --border: 217 33% 17%;
  --input: 217 33% 17%;
  --ring: 217 91% 60%;
}
```

### Usage Rules

- Never hardcode hex values — always use `text-primary`, `bg-muted`, etc.
- Status colors are semantic: `text-success`, `text-warning`, `text-destructive`
- **Hero/feature sections:** Blue → purple gradient spectrum for energy and premium feel
- **Backgrounds:** Create depth with subtle gradients, layered card shadows, and gentle color washes rather than flat white/dark surfaces. A `bg-gradient-to-b from-background to-muted/30` adds atmosphere without distraction.
- **Dark mode gradients:** MORE vivid and saturated. Light mode gradients: subtler and softer. Dark mode is where the brand really glows.
- **Accent usage:** Use `primary` boldly but sparingly — one accent color per viewport section. Too many competing accents create visual noise.

## Typography

### Font Stack

- **Primary (body):** Geist Sans — clean, modern, excellent for UI text and data-dense screens
- **Display (headings, hero):** Geist Sans at larger weights, or a distinctive display font for marketing pages
- **Mono (code, IDs):** Geist Mono — for case IDs, credit amounts, technical references

### Rules

- **Headings:** `font-semibold`, never `font-bold` (too heavy for Geist). Display headings (`text-3xl`+) can use `font-bold` sparingly for hero sections.
- **Body:** `font-normal`, `leading-relaxed` for readability in paragraphs, `leading-normal` for UI labels
- **Small text/labels:** `text-sm text-muted-foreground` — muted, not invisible
- **Numbers/currency:** `font-mono tabular-nums` — ensures columns of numbers align properly
- **Hierarchy:** Establish clear visual hierarchy through size + weight + color, not just size alone. A `text-sm font-medium text-foreground` label reads louder than a `text-base font-normal text-muted-foreground` description.

## Spacing & Density

**Monday-level spacious.** Not Linear-dense. Consultants scanning expert profiles need breathing room.

| Element               | Spacing                |
| --------------------- | ---------------------- |
| Card padding          | `p-6` minimum          |
| Section spacing       | `py-16` to `py-24`     |
| Between cards in grid | `gap-4` to `gap-6`     |
| Form field spacing    | `space-y-4`            |
| Page max width        | `max-w-7xl mx-auto`    |
| Content padding       | `px-4 sm:px-6 lg:px-8` |

## Dark Mode

Implemented from day one. Not optional.

- **Provider:** `next-themes` with `attribute="class"`
- **Detection:** System preference (`prefers-color-scheme`)
- **Toggle:** Manual in user settings, persisted to localStorage
- **Rule:** Always use `dark:` variants or CSS variables. Never assume light mode.
- **`suppressHydrationWarning`** on `<html>` tag to prevent flash

## Component Selection

| Need                           | Source                             | Notes                   |
| ------------------------------ | ---------------------------------- | ----------------------- |
| Basic button, input, dialog    | shadcn/ui                          | `npx shadcn add button` |
| Input with floating label      | shadcnspace Input-08               | Form polish             |
| Input with character count     | shadcnspace Input-06               | Bio/description fields  |
| Input with validation feedback | shadcnspace Input-04               | Real-time validation    |
| Card with hover lift           | shadcnspace Card variants          | Expert cards, pricing   |
| Dashboard sidebar              | shadcnspace Sidebar blocks         | App navigation          |
| Toasts                         | Sonner (via shadcn)                | `npx shadcn add sonner` |
| Data tables                    | TanStack Table + shadcn DataTable  | Sortable, filterable    |
| Simple date field              | shadcn Calendar (react-day-picker) | Due dates, date filters |
| Consultation booking calendar  | shadcnspace Calendar-03            | Date + time slot picker |
| Rich text                      | Tiptap                             | Expert bios, proposals  |

## Key Rules

### ALWAYS

- ✅ Run the Normalization Checklist (see components-forms.md) on every third-party component before committing
- ✅ Test both light and dark mode
- ✅ Include all four states: loading, empty, error, success
- ✅ Toast on every user-initiated mutation (create, update, delete, payment) — no silent successes
- ✅ Use `FormDescription` helper text on any form field that isn't immediately obvious
- ✅ Use `focus-visible:ring-2` for keyboard navigation (accessibility)
- ✅ Test at 375px viewport (mobile) minimum
- ✅ Use Motion for orchestrated transitions — prioritize page load reveals and state changes over scattered micro-interactions
- ✅ Use semantic color tokens, not hardcoded values

### NEVER

- ❌ Hardcode colors (`#2563EB`) — use CSS variables
- ❌ Skip loading/error states — every async component needs them
- ❌ Complete a mutation silently — always confirm success or failure to the user
- ❌ Use hover-only tooltips as the sole way to explain something — mobile can't hover
- ❌ Over-animate — Motion is for polish, not distraction
- ❌ Use Linear-level density — keep it spacious
- ❌ Forget dark mode variants
- ❌ Use `font-bold` on headings — use `font-semibold`
- ❌ Make interactive elements smaller than 44px tap target (mobile)
