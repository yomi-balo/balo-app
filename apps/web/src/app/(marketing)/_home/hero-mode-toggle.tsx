import { ChevronsUpDown } from 'lucide-react';
import type { MarketingHomeHeroMode, MarketingHomeHeroModeSource } from '@/lib/analytics';
import { HERO_MODE_COPY } from './copy';

export interface HeroModeToggleProps {
  readonly mode: MarketingHomeHeroMode;
  readonly onChange: (
    next: MarketingHomeHeroMode,
    source: Extract<MarketingHomeHeroModeSource, 'phrase' | 'tail'>
  ) => void;
}

function otherModeOf(mode: MarketingHomeHeroMode): MarketingHomeHeroMode {
  return mode === 'consultation' ? 'project' : 'consultation';
}

/**
 * BAL-582 §1 — the hero's one-line sentence mode toggle (V1.5 ref, option E,
 * `marketing-home.jsx:1992-2018`). Purely presentational: `HeroSearch` owns `mode` and decides
 * what a mode change means (analytics, panel opening); this component only renders the sentence
 * and reports which button was pressed.
 *
 * Root element is `<p className="mk-sent">` — one of `HeroSearch`'s three top-level
 * `.mk-hero-inner` children. No `role="tablist"` (plan §1): the bold phrase is a plain
 * `aria-pressed` toggle button, and the trailing "or …" tail is a second, independent button that
 * always names and selects the OTHER mode.
 */
export function HeroModeToggle({
  mode,
  onChange,
}: Readonly<HeroModeToggleProps>): React.JSX.Element {
  const otherMode = otherModeOf(mode);

  return (
    <p className="mk-sent">
      {HERO_MODE_COPY.sentencePrefix}
      <button
        type="button"
        className="mk-sent-btn"
        aria-pressed={mode === 'project'}
        title={`Switch to ${HERO_MODE_COPY.modes[otherMode]}`}
        aria-label={`Mode: ${HERO_MODE_COPY.modes[mode]}. Switch to ${HERO_MODE_COPY.modes[otherMode]}`}
        onClick={() => onChange(otherMode, 'phrase')}
      >
        <span key={mode} className="mk-sent-word">
          {HERO_MODE_COPY.modes[mode]}
        </span>
        <span className="mk-sent-flip">
          <ChevronsUpDown size={14} aria-hidden="true" />
        </span>
      </button>
      <span className="mk-sent-alt">
        or{' '}
        <button type="button" onClick={() => onChange(otherMode, 'tail')}>
          <span key={otherMode} className="mk-sent-alt-word">
            {HERO_MODE_COPY.modes[otherMode]}
          </span>
        </button>
      </span>
    </p>
  );
}
