'use client';

import { Sparkles } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { Card } from '@/components/ui/card';
import { SectionLabel } from '@/components/expert/profile';

interface AboutSectionProps {
  bio: string | null;
  firstName: string;
}

/** "About" — the expert's bio, split on blank lines into paragraphs. */
export function AboutSection({ bio, firstName }: Readonly<AboutSectionProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const paragraphs = bio
    ? bio
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 18 }}
      whileInView={reduce ? undefined : { opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.5, ease: 'easeOut' }}
    >
      <Card className="gap-0 p-7">
        <SectionLabel icon={Sparkles} tone="accent" className="mb-4">
          About
        </SectionLabel>
        {paragraphs.length > 0 ? (
          paragraphs.map((paragraph, i) => (
            <p
              key={paragraph.slice(0, 24) + i}
              className={
                i === 0
                  ? 'text-muted-foreground leading-relaxed'
                  : 'text-muted-foreground mt-3.5 leading-relaxed'
              }
            >
              {paragraph}
            </p>
          ))
        ) : (
          <p className="text-muted-foreground text-sm leading-relaxed">
            {firstName} hasn&apos;t added a bio yet.
          </p>
        )}
      </Card>
    </motion.div>
  );
}
