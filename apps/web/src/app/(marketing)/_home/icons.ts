import {
  TrendingUp,
  Headset,
  Sparkles,
  Database,
  Banknote,
  Megaphone,
  Code2,
  Globe,
  BarChart3,
  GitMerge,
  Wrench,
  Mail,
  ShoppingBag,
  Landmark,
  Hash,
  Activity,
  Heart,
  Video,
  Layers,
  Package,
  Shield,
  Users,
  Star,
  Clock,
  type LucideIcon,
} from 'lucide-react';
import type { MarketingBenchIconKey } from '@/lib/marketing/bench-tiles';

/**
 * BAL-493 §1.2 — maps the ref's neutral icon-key strings (`marketing-home.jsx`'s `I` glyph
 * table, reused verbatim as `MarketingBenchIconKey` by `lib/marketing/bench-tiles.ts`, plus a
 * handful more for the Ways/Vetting/Perks copy) to real `lucide-react` components.
 *
 * ⚠ NOTHING ELSE ON THIS PAGE IMPORTS LUCIDE BY REF-KEY. A component that needs an icon for a
 * fixed, non-data-driven purpose (the search icon, the arrow on a CTA, a checkmark) imports the
 * lucide component directly — this map exists ONLY for icon keys carried as data in `copy.ts` /
 * `MARKETING_BENCH_TILES`, so the data stays serialisable (a string, not a component).
 */
export type MarketingIconKey =
  | MarketingBenchIconKey
  | 'video'
  | 'layers'
  | 'box'
  | 'shield'
  | 'users'
  | 'star'
  | 'clock';

export const MARKETING_ICONS: Record<MarketingIconKey, LucideIcon> = {
  trending: TrendingUp,
  headset: Headset,
  sparkles: Sparkles,
  database: Database,
  banknote: Banknote,
  megaphone: Megaphone,
  code: Code2,
  globe: Globe,
  chart: BarChart3,
  gitMerge: GitMerge,
  wrench: Wrench,
  mail: Mail,
  bag: ShoppingBag,
  landmark: Landmark,
  hash: Hash,
  activity: Activity,
  heart: Heart,
  video: Video,
  layers: Layers,
  box: Package,
  shield: Shield,
  users: Users,
  star: Star,
  clock: Clock,
};
