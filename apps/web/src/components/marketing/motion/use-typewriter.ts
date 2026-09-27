'use client';

import { useEffect, useState } from 'react';

/** Delay before the first character types, and the pause between erase → next phrase. */
const TYPE_START_DELAY_MS = 900;
const NEXT_PHRASE_DELAY_MS = 360;
/** How long a fully-typed phrase holds before it starts erasing. */
const HOLD_MS = 2000;
/** Per-character typing speed: a base plus jitter, so it doesn't read as a metronome. */
const TYPE_BASE_MS = 32;
const TYPE_JITTER_MS = 34;
const ERASE_MS = 14;

/**
 * BAL-493 §11 — the hero search's typewriter phrase cycle. Mirrors the design reference's
 * `useTypewriter` (`marketing-home.jsx:1465-1503`).
 *
 * Under reduced motion, returns `phrases[0]` statically (no caret, no cycling) — and does so
 * from the very first render, not just after an effect runs, since the initial `useState`
 * already resolves to it.
 *
 * BAL-582 §1 — `phrases` changes identity when the hero's sentence toggle swaps mode (a
 * different `VERTICAL.phrases` / `.projectPhrases` array is passed in). Without resetting `text`
 * at the top of the effect, the OLD mode's partially-typed phrase would linger on screen for a
 * full `TYPE_START_DELAY_MS` (900ms) before the new cycle's first tick overwrites it.
 */
export function useTypewriter(phrases: readonly string[], reduced: boolean): string {
  const [firstPhrase] = phrases;
  const [text, setText] = useState(reduced ? (firstPhrase ?? '') : '');

  useEffect(() => {
    if (reduced) {
      setText(firstPhrase ?? '');
      return undefined;
    }
    if (phrases.length === 0) return undefined;

    setText('');
    let phraseIndex = 0;
    let charIndex = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = (): void => {
      const phrase = phrases[phraseIndex] ?? '';
      if (deleting) {
        charIndex -= 1;
        setText(phrase.slice(0, charIndex));
        if (charIndex === 0) {
          deleting = false;
          phraseIndex = (phraseIndex + 1) % phrases.length;
          timer = setTimeout(tick, NEXT_PHRASE_DELAY_MS);
          return;
        }
        timer = setTimeout(tick, ERASE_MS);
      } else {
        charIndex += 1;
        setText(phrase.slice(0, charIndex));
        if (charIndex === phrase.length) {
          deleting = true;
          timer = setTimeout(tick, HOLD_MS);
          return;
        }
        // SonarCloud S2245 — `Math.random()` is a cryptography-flagged source; the cadence only
        // needs to look non-mechanical, not be unpredictable, so the jitter is derived from the
        // loop's own advancing `charIndex` instead. `% (TYPE_JITTER_MS + 1)` keeps it in
        // [0, TYPE_JITTER_MS], so the per-character delay stays within the documented
        // [TYPE_BASE_MS, TYPE_BASE_MS + TYPE_JITTER_MS] range while still varying tick to tick.
        timer = setTimeout(tick, TYPE_BASE_MS + ((charIndex * 7) % (TYPE_JITTER_MS + 1)));
      }
    };

    timer = setTimeout(tick, TYPE_START_DELAY_MS);
    return () => clearTimeout(timer);
  }, [phrases, reduced, firstPhrase]);

  return text;
}
