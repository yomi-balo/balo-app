'use client';

import { motion } from 'motion/react';
import { IconBadge } from '@/components/balo/icon-badge';
import { Code2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface TabPlaceholderProps {
  icon: LucideIcon;
  iconColor: string;
  title: string;
  description: string;
  /**
   * The dev-facing "which ticket builds this" chip. Optional — a client-facing placeholder (the
   * BAL-503 Settings sections) omits it entirely, since surfacing a raw `BAL-xxx` id to a client
   * user is wrong. Renders only when supplied.
   */
  task?: string;
  /**
   * ⚠ Defaults to `'h2'`, NOT `'h3'`. The dashboard chrome renders each page's `<h1>` from the
   * breadcrumb trail (`breadcrumbs.tsx`), so a placeholder whose only heading is an `h3` yields
   * `h1 → h3` on the composed route and trips axe's `heading-order`. Pass `'h3'` only when this
   * renders BELOW an existing `h2` on the same page.
   */
  headingLevel?: 'h2' | 'h3';
}

/**
 * MOVED from `(dashboard)/expert/settings/_components/tab-placeholder.tsx` (BAL-503 / O7) to
 * `components/balo/` — a route-private `_components` dir under a DIFFERENT route cannot
 * idiomatically be imported by the settings tree, and this was never expert-settings-specific.
 * Had zero consumers and zero tests before the move.
 */
export function TabPlaceholder({
  icon,
  iconColor,
  title,
  description,
  task,
  headingLevel: Heading = 'h2',
}: Readonly<TabPlaceholderProps>): React.JSX.Element {
  return (
    <motion.div
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="border-border bg-card rounded-xl border p-12 text-center md:p-16"
    >
      <div className="mx-auto flex flex-col items-center">
        <IconBadge icon={icon} color={iconColor} size={56} iconSize={26} className="mb-4" />
        <Heading className="text-foreground text-xl font-semibold">{title}</Heading>
        <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
          {description}
        </p>
        {task !== undefined && (
          <div className="bg-muted text-muted-foreground mt-6 inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm">
            <Code2 className="h-4 w-4" />
            <span>{task}</span>
          </div>
        )}
      </div>
    </motion.div>
  );
}
