'use client';

/**
 * BAL-510 — motion context + hooks for the /v2 preview, ported from the design ref
 * (ref :712-782): `MotionCtx`/`useReduced`, `usePrefersReduced`, `useInView`, `Group`,
 * `useRotator`. The ref's motion is hand-rolled (CSS keyframes + one
 * IntersectionObserver, specific durations) rather than Motion (`motion/react`) — see
 * the technical plan's "Deliberate skill deviations" — so this is a faithful port, not
 * a re-expression in the app's usual animation library.
 *
 * Two lint-driven deviations from the ref's literal syntax (behaviour unchanged):
 * - `window.matchMedia` → `globalThis.matchMedia` (`unicorn/prefer-global-this`, S7764,
 *   an error in the diff-scoped sonar ruleset).
 * - `items[i]` is narrowed with a `??` fallback, never `!` — `noUncheckedIndexedAccess`
 *   types it `T | undefined`, and SonarCloud flags an index-position `!` as an
 *   "unnecessary non-null assertion" false positive.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';

export const MotionCtx = createContext(false);

export function useReduced(): boolean {
  return useContext(MotionCtx);
}

export function usePrefersReduced(): boolean {
  const [pref, setPref] = useState(false);
  useEffect(() => {
    const mq = globalThis.matchMedia('(prefers-reduced-motion: reduce)');
    setPref(mq.matches);
    const listener = (e: MediaQueryListEvent): void => setPref(e.matches);
    mq.addEventListener('change', listener);
    return () => mq.removeEventListener('change', listener);
  }, []);
  return pref;
}

export function useInView(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold: 0.2, rootMargin: '0px 0px -8% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView];
}

export interface GroupProps extends Readonly<HTMLAttributes<HTMLDivElement>> {
  children: ReactNode;
  className?: string;
}

export function Group({ children, className = '', ...rest }: GroupProps): React.JSX.Element {
  const [ref, inView] = useInView();
  // Built outside the `className` JSX attribute, deliberately: `prettier-plugin-tailwindcss`
  // treats a template literal authored directly in `className={...}` as a class list and
  // re-serializes it, silently collapsing the significant leading space in ' is-in' (the
  // space that separates it from `mk2-reveal-group`). Assigning to a variable first keeps
  // this string outside that rewrite.
  const groupClassName = `mk2-reveal-group${inView ? ' is-in' : ''} ${className}`;
  return (
    <div ref={ref} className={groupClassName} {...rest}>
      {children}
    </div>
  );
}

/** Rotating hero line — Viktor's rotating-copy device (ref :758-782). */
export function useRotator(items: string[], reduced: boolean): [string, boolean] {
  const [i, setI] = useState(0);
  const [out, setOut] = useState(false);
  useEffect(() => {
    if (reduced) {
      setI(0);
      setOut(false);
      return;
    }
    let alive = true;
    const cycle = setInterval(() => {
      setOut(true);
      setTimeout(() => {
        if (!alive) return;
        setI((v) => (v + 1) % items.length);
        setOut(false);
      }, 360);
    }, 2800);
    return () => {
      alive = false;
      clearInterval(cycle);
    };
  }, [items, reduced]);
  const current = items[i] ?? items[0] ?? '';
  return [current, out];
}
