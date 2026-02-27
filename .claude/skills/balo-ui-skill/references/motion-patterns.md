# Motion Patterns — Balo

## Setup

```bash
pnpm add motion --filter web
```

```tsx
import { motion, AnimatePresence } from 'motion/react';
```

## Animation Philosophy

Animations in Balo serve three purposes:

1. **Orientation** — help users understand where things come from and go to
2. **Feedback** — confirm that an action was registered
3. **Polish** — elevate the perceived quality of the product

If an animation doesn't serve one of these, remove it. Over-animating is worse than no animation.

## Timing Guidelines

| Category          | Duration  | Easing      | Example                      |
| ----------------- | --------- | ----------- | ---------------------------- |
| Micro-interaction | 100–200ms | `ease`      | Button hover, focus ring     |
| State change      | 200–300ms | `easeOut`   | Toggle, checkbox, tab switch |
| Content reveal    | 300–500ms | `easeOut`   | Card appear, section fade-in |
| Page transition   | 300–400ms | `easeInOut` | Route change                 |
| Stagger delay     | 50–100ms  | —           | Between list items           |

**Rule of thumb:** If you're debating the duration, go shorter. Snappy > smooth.

## Common Patterns

### Fade In on Mount

The most common pattern. Used for cards, sections, page content.

```tsx
<motion.div
  initial={{ opacity: 0, y: 20 }}
  animate={{ opacity: 1, y: 0 }}
  transition={{ duration: 0.3, ease: 'easeOut' }}
>
  <Card>...</Card>
</motion.div>
```

### Hover Lift (Cards)

Interactive cards get a subtle lift on hover. This is THE signature Balo micro-interaction.

```tsx
<motion.div
  whileHover={{ y: -4 }}
  transition={{ duration: 0.2, ease: 'easeOut' }}
  className="cursor-pointer"
>
  <Card className="transition-shadow duration-200 hover:shadow-md">{/* Card content */}</Card>
</motion.div>
```

**Combined with CSS for shadow (better performance):**

```tsx
// Motion handles the transform (GPU-accelerated)
// Tailwind handles the shadow (CSS transition)
<motion.div whileHover={{ y: -4 }} transition={{ duration: 0.2 }}>
  <Card className="dark:hover:shadow-primary/5 transition-shadow duration-200 hover:shadow-lg">
    ...
  </Card>
</motion.div>
```

### Staggered List (Expert Cards, Search Results)

Cards animate in with a cascading delay. Critical for the marketplace feel.

```tsx
const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
    },
  },
};

const item = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: 'easeOut' },
  },
};

function ExpertGrid({ experts }: { experts: Expert[] }) {
  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3"
    >
      {experts.map((expert) => (
        <motion.div key={expert.id} variants={item}>
          <ExpertCard expert={expert} />
        </motion.div>
      ))}
    </motion.div>
  );
}
```

### Scroll-Triggered Sections (Marketing Pages)

Sections fade in as the user scrolls. `viewport={{ once: true }}` means it only fires once.

```tsx
<motion.section
  initial={{ opacity: 0, y: 40 }}
  whileInView={{ opacity: 1, y: 0 }}
  viewport={{ once: true, margin: '-100px' }}
  transition={{ duration: 0.6, ease: 'easeOut' }}
  className="py-24"
>
  <h2 className="text-3xl font-semibold">How It Works</h2>
  {/* ... */}
</motion.section>
```

### Page/Route Transitions

Wrap page content in AnimatePresence for cross-fade between routes.

```tsx
// app/(dashboard)/layout.tsx
'use client';

import { AnimatePresence, motion } from 'motion/react';
import { usePathname } from 'next/navigation';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <AnimatePresence mode="wait">
      <motion.main
        key={pathname}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.2 }}
      >
        {children}
      </motion.main>
    </AnimatePresence>
  );
}
```

### Button Press Feedback

Subtle scale on press — feels tactile.

```tsx
<motion.button
  whileTap={{ scale: 0.98 }}
  className="..." // Your Button styles
>
  Book Consultation
</motion.button>
```

### Expanding/Collapsing Content

Layout animations for smooth height transitions.

```tsx
<motion.div
  layout
  initial={false}
  animate={{ height: isOpen ? 'auto' : 0 }}
  transition={{ duration: 0.3, ease: 'easeInOut' }}
  className="overflow-hidden"
>
  {/* Expandable content */}
</motion.div>
```

### Loading Skeleton Pulse

Not strictly Motion — use CSS animation for skeleton pulse (lower overhead).

```tsx
function ExpertCardSkeleton() {
  return (
    <Card className="p-6">
      <div className="flex items-center gap-3">
        <div className="bg-muted h-11 w-11 animate-pulse rounded-xl" />
        <div className="space-y-2">
          <div className="bg-muted h-4 w-24 animate-pulse rounded" />
          <div className="bg-muted h-3 w-32 animate-pulse rounded" />
        </div>
      </div>
      <div className="bg-muted mt-4 h-3 w-full animate-pulse rounded" />
      <div className="bg-muted mt-2 h-3 w-2/3 animate-pulse rounded" />
    </Card>
  );
}
```

### Number Counter (Stats, Pricing)

Animated number that counts up on scroll.

```tsx
import { useInView } from 'motion/react';
import { useRef, useEffect, useState } from 'react';

function AnimatedStat({ value, label }: { value: number; label: string }) {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!isInView) return;
    const duration = 1000;
    const start = Date.now();
    const tick = () => {
      const elapsed = Date.now() - start;
      const progress = Math.min(elapsed / duration, 1);
      setDisplay(Math.floor(progress * value));
      if (progress < 1) requestAnimationFrame(tick);
    };
    tick();
  }, [isInView, value]);

  return (
    <div ref={ref} className="text-center">
      <p className="text-4xl font-semibold">{display.toLocaleString()}+</p>
      <p className="text-muted-foreground mt-1 text-sm">{label}</p>
    </div>
  );
}
```

## Gradient Glow Effect (Lumen-Inspired)

For hero sections and feature highlights:

```tsx
function GlowBackground({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden">
      {/* Glow orbs */}
      <div className="absolute inset-0 -z-10">
        <div className="bg-primary/20 absolute top-1/4 left-1/4 h-96 w-96 rounded-full blur-3xl" />
        <div className="absolute top-1/3 right-1/4 h-80 w-80 rounded-full bg-purple-500/15 blur-3xl" />
        <div className="absolute bottom-1/4 left-1/3 h-72 w-72 rounded-full bg-pink-500/10 blur-3xl" />
      </div>
      {children}
    </div>
  );
}
```

**Dark mode:** Glow orbs become more vivid (`bg-primary/30` instead of `/20`).

## Performance Rules

- Use `will-change: transform` on frequently animated elements (via `className="will-change-transform"`)
- Prefer `transform` and `opacity` animations (GPU-accelerated) over `width`, `height`, `top`, `left`
- Use CSS `transition` for simple hover effects — Motion for complex sequences
- Test on throttled CPU (Chrome DevTools → Performance → 4x slowdown)
- `AnimatePresence` mode `"wait"` for sequential transitions, `"sync"` for overlapping
- Skeleton loaders use CSS `animate-pulse`, not Motion (lower overhead)

## Anti-Patterns

- ❌ Animating every element on page load (overwhelming)
- ❌ Bounce/spring easings on business UI (feels childish)
- ❌ Animations longer than 500ms (feels sluggish)
- ❌ Parallax scrolling (motion sickness, performance)
- ❌ Auto-playing carousels (accessibility, user control)
- ❌ Animating layout properties (width, height) without `layout` prop
