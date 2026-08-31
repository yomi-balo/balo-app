'use client';

/**
 * BAL-510 — the /v2 hero, ported from the design ref (`Hero`, ref :999-1125): aurora,
 * live pill, H1, rotator line, the search form, the ghost brief CTA, proof line and the
 * product ticker.
 *
 * ⚠ Net-new vs. the ref (technical plan, "Hero search — the net-new bit (M2)"): the
 * ref's `.mk2-search` is a `<div role="search">` around a `type="button"` submit with NO
 * handler — not accessible and not a port. Here it is a real `<form role="search"
 * onSubmit={…}>`; the submit button is `type="submit"`, every other button inside stays
 * `type="button"` so it cannot submit, and the popover's own search input swallows
 * Enter (`ProductFacet`) so it can't bubble into this form's submit.
 *
 * ⚠ Do not add or remove any element inside `.mk2-wrap` — the hero's staggered entry
 * animation is `.mk2-hero .mk2-wrap > :nth-child(1…6)` (`v2.css`). Children stay exactly:
 * live pill, h1, rotator line, search form, `.mk2-alt`, proof line.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { avatarGradient, CLUSTER, initials, LIVE_COUNT, VERTICAL } from '../_lib/content';
import { buildExpertsHref, resolveTickerHref } from '../_lib/experts-href';
import { selectedProductIds, type V2Taxonomy } from '../_lib/product-facet-model';
import { I } from './icons';
import { useReduced, useRotator } from './motion';
import { ProductFacet } from './product-facet';

export interface HeroProps {
  taxonomy: V2Taxonomy;
}

export function Hero({ taxonomy }: Readonly<HeroProps>): React.JSX.Element {
  const reduced = useReduced();
  const [rot, out] = useRotator(VERTICAL.rotator, reduced);
  const [q, setQ] = useState('');
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [facetOpen, setFacetOpen] = useState(false);
  const searchRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  const toggleProduct = (key: string): void => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    if (!facetOpen) return;
    const handlePointerDown = (e: MouseEvent): void => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setFacetOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFacetOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [facetOpen]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    const productIds = selectedProductIds(selectedKeys, taxonomy);
    router.push(buildExpertsHref({ q, productIds }));
  };

  // See the prettier-plugin-tailwindcss note in `motion.tsx` — computed outside
  // `className={...}` so the leading space before `is-out` survives `pnpm format`.
  const rotClassName = `mk2-rot${out ? ' is-out' : ''}`;

  return (
    <section className="mk2-hero" id="top">
      <div className="mk2-aurora" aria-hidden="true">
        <div className="mk2-aur mk2-aur-a" />
        <div className="mk2-aur mk2-aur-b" />
        <div className="mk2-aur mk2-aur-c" />
        <div className="mk2-hero-fade" />
      </div>
      <div className="mk2-wrap">
        <div className="mk2-live">
          <span className="mk2-avs" aria-hidden="true">
            {CLUSTER.map((n) => (
              <span key={n} className="mk2-av" style={{ background: avatarGradient(n) }}>
                {initials(n)}
              </span>
            ))}
          </span>
          <span className="mk2-live-dot" />
          <span>
            <b className="mk2-mono">{LIVE_COUNT}</b> experts available now
          </span>
        </div>

        <h1 className="mk2-h1">
          Not a day rate.
          <br />
          <span className="mk2-h1-grad">A minute.</span>
        </h1>

        <p className="mk2-rotline">
          Top {VERTICAL.name} experts, on demand — for the{' '}
          <span className={rotClassName}>{rot}</span>
        </p>

        <form className="mk2-search" role="search" ref={searchRef} onSubmit={handleSubmit}>
          <span className="mk2-search-icon">
            <I.search size={19} />
          </span>
          <input
            className="mk2-search-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Describe what you're stuck on…"
            aria-label={`Describe what you need help with in ${VERTICAL.name}`}
          />
          <span className="mk2-sdiv" aria-hidden="true" />
          <ProductFacet
            taxonomy={taxonomy}
            // Degraded mode: no item carries a real id, so `selectedProductIds()` can emit
            // nothing and the filter cannot reach the URL. Render the control inert rather
            // than letting it look applied. See `ProductFacetProps.unavailable`.
            unavailable={taxonomy.source === 'fallback'}
            selectedKeys={selectedKeys}
            toggle={toggleProduct}
            clear={() => setSelectedKeys(new Set())}
            open={facetOpen}
            setOpen={setFacetOpen}
          />
          <button type="submit" className="mk2-btn mk2-btn-grad">
            Find an expert
            <I.arrow size={15} />
          </button>
        </form>

        {/* O3 (build-rulings): no project-intake route exists — routes to /experts,
            the precedented answer (`NEW_REQUEST_HREF` in the projects dashboard). */}
        <div className="mk2-alt">
          <Link className="mk2-btn mk2-btn-ghost" href="/experts" prefetch={false}>
            Submit a project brief
          </Link>
        </div>

        <p className="mk2-proofline">
          Top <b>1%</b> of applicants · avg first session <b>&lt; 2 hrs</b> · pay for the minutes
          you use
        </p>
      </div>

      {/* Product coverage, one line — O2: ticker items link to a filtered /experts
          search on an exact name hit, or plain /experts on a miss (no aliasing). */}
      <div className="mk2-ticker" aria-label={`${VERTICAL.name} products covered by Balo experts`}>
        <div className="mk2-ticker-track">
          {[false, true].map((dup) => (
            <div key={dup ? 'b' : 'a'} className="mk2-ticker-half" aria-hidden={dup || undefined}>
              {VERTICAL.ticker.map((p) => (
                <span key={p}>
                  <Link
                    className="mk2-tick"
                    href={resolveTickerHref(p, taxonomy)}
                    tabIndex={dup ? -1 : undefined}
                    prefetch={false}
                  >
                    {p}
                  </Link>
                  <span className="mk2-tickdot" />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
