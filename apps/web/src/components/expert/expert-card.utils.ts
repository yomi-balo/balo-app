import type { ReactNode } from 'react';
import { createElement } from 'react';
import type { ExpertiseItem, SkillType } from './expert-card.types';

// ── Deterministic gradient avatar ────────────────────────────────

function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
  }
  return hash;
}

const GRADIENT_PAIRS = [
  { from: 'from-blue-600', to: 'to-violet-600' },
  { from: 'from-emerald-600', to: 'to-cyan-600' },
  { from: 'from-orange-500', to: 'to-rose-500' },
  { from: 'from-violet-600', to: 'to-pink-500' },
  { from: 'from-cyan-600', to: 'to-blue-600' },
  { from: 'from-rose-500', to: 'to-orange-500' },
  { from: 'from-indigo-600', to: 'to-blue-500' },
  { from: 'from-teal-500', to: 'to-emerald-600' },
] as const;

export function getGradientFromId(id: string): { from: string; to: string } {
  return GRADIENT_PAIRS[hashString(id) % GRADIENT_PAIRS.length]!;
}

// ── Skill type labels (for orderBy matching) ────────────────────

export const SKILL_LABELS: Record<SkillType, string> = {
  technical: 'Technical / Dev',
  architecture: 'Architecture & Integrations',
  admin: 'Configuration & Admin',
  strategy: 'Strategy & Consulting',
};

const SKILL_LABELS_LOWER: Record<SkillType, string> = Object.fromEntries(
  Object.entries(SKILL_LABELS).map(([k, v]) => [k, v.toLowerCase()])
) as Record<SkillType, string>;

// ── Expertise ordering ───────────────────────────────────────────

export function getOrderedExpertise(
  expertise: ExpertiseItem[],
  orderBy?: string[]
): ExpertiseItem[] {
  if (!orderBy || orderBy.length === 0) return expertise;

  const terms = orderBy.map((t) => t.toLowerCase());

  const scored = expertise.map((item, originalIndex) => {
    const productLower = item.product.toLowerCase();
    const productScore = terms.reduce(
      (sum, term) => sum + (productLower.includes(term) ? 1 : 0),
      0
    );
    const skillScore = item.skills.reduce((sum, sk) => {
      const label = SKILL_LABELS_LOWER[sk];
      return sum + terms.reduce((s, t) => s + (label.includes(t) ? 1 : 0), 0);
    }, 0);
    const score = productScore + skillScore;
    return { item, score, originalIndex };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  return scored.map((s) => s.item);
}

// ── Tagline ──────────────────────────────────────────────────────

export function buildTagline(expertise: ExpertiseItem[]): string {
  if (expertise.length === 0) return '';
  return expertise
    .slice(0, 3)
    .map((e) => e.product)
    .join(' \u00B7 ');
}

// ── Tagline highlighting ─────────────────────────────────────────

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function highlightTagline(tagline: string, orderBy?: string[]): ReactNode {
  if (!orderBy || orderBy.length === 0 || !tagline) return tagline;

  const pattern = orderBy.map(escapeRegExp).join('|');
  const regex = new RegExp(`(${pattern})`, 'gi');
  const parts = tagline.split(regex);

  if (parts.length === 1) return tagline;

  return parts.map((part, i) => {
    // Split with a capturing group produces alternating non-match/match parts
    if (i % 2 === 1) {
      return createElement('span', { key: i, className: 'text-primary font-semibold' }, part);
    }
    return part;
  });
}
