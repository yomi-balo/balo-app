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
  task: string;
}

export function TabPlaceholder({
  icon,
  iconColor,
  title,
  description,
  task,
}: TabPlaceholderProps): React.JSX.Element {
  return (
    <motion.div
      initial={{ y: 12, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="border-border bg-card rounded-xl border p-12 text-center md:p-16"
    >
      <div className="mx-auto flex flex-col items-center">
        <IconBadge icon={icon} color={iconColor} size={56} iconSize={26} className="mb-4" />
        <h3 className="text-foreground text-xl font-semibold">{title}</h3>
        <p className="text-muted-foreground mx-auto mt-2 max-w-md text-sm leading-relaxed">
          {description}
        </p>
        <div className="bg-muted text-muted-foreground mt-6 inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm">
          <Code2 className="h-4 w-4" />
          <span>{task}</span>
        </div>
      </div>
    </motion.div>
  );
}
