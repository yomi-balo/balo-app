'use client';

import type { ReactNode } from 'react';
import { Parallax } from '@/components/marketing/motion/parallax';
import {
  FX_RECEIPT,
  FX_GLOW_A,
  FX_GLOW_B,
  type ParallaxCompute,
} from '@/components/marketing/motion/fx';

const PRESETS = {
  receipt: FX_RECEIPT,
  'glow-a': FX_GLOW_A,
  'glow-b': FX_GLOW_B,
} as const satisfies Record<string, ParallaxCompute>;

interface PresetParallaxProps {
  readonly preset: keyof typeof PRESETS;
  readonly className?: string;
  /** Forwarded to `<Parallax>` — see its docblock. Opt-in, decorative layers only. */
  readonly ariaHidden?: boolean;
  readonly children: ReactNode;
}

/**
 * BAL-493 P4b3 bugfix — `<Parallax compute={...}>` is a Client Component, and `compute` is a
 * plain function. `pricing-section.tsx` and `expert-band-section.tsx` are Server Components
 * (per P4b2's handoff table); passing `FX_RECEIPT`/`FX_GLOW_A`/`FX_GLOW_B` straight through as
 * the `compute` prop crosses the Server→Client boundary with a bare function reference, which
 * `next build` rejects at prerender time: "Functions cannot be passed directly to Client
 * Components unless you explicitly expose it by marking it with 'use server'." Not caught by
 * `pnpm typecheck`/`lint`/`vitest` — only `next build`'s RSC serialization check surfaces it,
 * because `/` is the only route that renders these two sections.
 *
 * Fix: a thin client wrapper that receives a serializable `preset` key instead of a function,
 * and resolves it to the real `ParallaxCompute` INSIDE the client boundary — the exact pattern
 * `bench-rows.tsx` already uses (it imports its own `FX_BENCH_A`/`FX_BENCH_B` client-side
 * rather than accepting them as props). `<Parallax>` itself is untouched.
 */
export function PresetParallax({
  preset,
  className,
  ariaHidden,
  children,
}: Readonly<PresetParallaxProps>): React.JSX.Element {
  return (
    <Parallax compute={PRESETS[preset]} className={className} ariaHidden={ariaHidden}>
      {children}
    </Parallax>
  );
}
