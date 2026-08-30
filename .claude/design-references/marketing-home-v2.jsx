import { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react';

// ─────────────────────────────────────────────────────────────────
// BALO MARKETING HOME — V2 "AIRY" (Balo 2.0)
// Design reference — alternative direction to marketing-home.jsx (V1).
// BAL-493 currently points at V1; if V2 wins, repoint the ticket's
// source-of-truth path and rebuild its background-rhythm table.
// ─────────────────────────────────────────────────────────────────
//
// CONCEPT (vs V1)
// V1 is search-first and product-dense: composer bar, tile bench,
// fragment cards, eleven sections. V2 is TYPE-FIRST and sparse: the
// copy system carries the page, and every section is one idea, one
// artifact, a lot of air. Roughly half the sections, a third of the
// words.
//
// REFERENCE — viktor.com (per Yomi: "the text hierarchy of the copy…
// feels more airy"). What was actually borrowed:
// • The copy ladder: tiny kicker → short FRAGMENT-PAIR heading
//   ("Not a tool. A hire.") → at most one line of body. Nothing longer.
// • Rotating line: one sentence whose ending cycles — their
//   "…work you can't get to / can't justify hiring for / …".
// • Contrast section ("A chatbot answers. Viktor delivers.") —
//   rebuilt here as agency-procurement vs Balo timelines.
// • Vertical air: ~150px section rhythm, almost no borders, one
//   visual artifact per section.
// NOT borrowed: their dense mega-nav, FAQ accordion, logo walls.
//
// COPY SYSTEM (the actual deliverable of V2)
// h1  : two fragments, ≤4 words each. "Not a day rate. / A minute."
// h2  : fragment pair, ≤7 words total. "An agency scopes. Balo solves."
// body: ONE line, ≤10 words. If it needs two lines, it's cut.
// kicker: 1–3 words, mono, uppercase.
// Every measured value (times, minutes, rates, counts) is Geist Mono —
// the metered-and-precise type signature carried over from V1.
//
// SIGNATURE ELEMENT
// The hero: "Not a day rate." set enormous, then "A minute." in the
// brand gradient — the whole pricing model in six words — followed by
// a rotating "For the ___" line cycling real Salesforce problems, and
// a single mono PRODUCT TICKER (marquee) as the only list on the page.
// V1's bench tiles compress into that one ticker line.
//
// TYPE SCALE (the hierarchy IS the design)
// display : clamp(48px, 9.5vw, 112px) / 0.98 / -0.045em / 750
// h2      : clamp(34px, 5vw, 58px) / 1.04 / -0.035em / 720
// body    : 17px max, usually one line, text2
// kicker  : 11px Geist Mono uppercase, +0.08em
// Sections: 150px vertical padding desktop, 88px mobile. Wrap 1080px.
//
// MOTION (calmer than V1 — airy means still)
// • No scroll parallax, no blobs, no rAF. Three devices only:
//   1. Rotating hero line (fade/slide swap every ~2.8s).
//   2. Product ticker marquee (55s linear loop, pauses on hover).
//   3. IO reveals: fade-up once, 100ms stagger.
//   Plus a 7s idle float on the receipt. Reduced motion: rotator
//   static on the first phrase, ticker static (two rows, clipped),
//   reveals instant, float off.
//
// CARRIED RULES (established in V1 review + BAL-493)
// • Nav "Find an expert" = SOLID --primary, white text (per Yomi).
// • Spotlight renders REAL experts (BAL-493: featured_experts config
//   + deterministic fallback, canonical ExpertCard, public serializer).
//   Cards here are minimal visual stand-ins.
// • Fee concealment: all-in client rate only; "Service fee included"
//   is the only fee language. Nothing about margin on the expert band.
// • Gradient = signature: hero "A minute.", primary CTAs, nothing else.
// • Gender-neutral copy. VERTICAL config is the multi-vertical seam.
// • prefers-reduced-motion honoured via OS AND the control strip.
//
// DELIBERATE OMISSIONS (decisions, not gaps — flag if wrong)
// • (Resolved 2026-08-30: the hero DOES carry the search bar now —
//   see REVISIONS V2.2. Production mounts the real BAL-249 composer;
//   the ProductFacet below is its visual stand-in.)
// • No metrics band, no vetting strip, no step fragments, no FAQ.
//   Proof compresses to: avatar pill, one mono proof line, one quote.
// • Testimonials: ONE centred pull-quote, not three cards.
//
// PLACEHOLDERS — all sample, none are claims
// Live count (38), avatar cluster, proof line numbers, ticker product
// list, spotlight experts, receipt maths, the quote, footer links.
// MJ holds copy checkpoints on all money strings and the H1.
//
// SUGGESTED ANALYTICS (subset of BAL-493's — same event names)
// cta_clicked {placement: nav|hero|ways|experts|pricing|band|final,
// label}, ticker_product_clicked {product}, spotlight_expert_clicked
// {expert_id, action}, section_viewed {section_id}.
//
// REVISIONS (V2 → V2.1, per Yomi 2026-08-29 — "more colour splash")
// Colour now carries the section rhythm (was: all-white + night):
//   Hero        #fff + AURORA (blue/violet radial glows, slow drift,
//               white fade before the ticker)
//   Contrast    tint-blue  #F3F6FF
//   Ways        #fff
//   Steps       tint-violet #F8F5FF
//   Spotlight   #fff
//   Pricing     #fff + blue/violet glow behind the receipt
//   Quote       gradient tint (135deg #EFF6FF → #F5F3FF)
//   Expert band --night + two radial glows (blue/violet)
//   Final       gradient CARD (blue→violet, radial highlights) on #fff
//   Footer      #fff
// Plus: kickers are now primary with a gradient dash (V1's eyebrow),
// ticker dots primary, hover states warm to blue. Still no parallax,
// no rAF — the aurora is ambient drift only, off under reduced motion.
//
// REVISIONS (V2.1 → V2.2, per Yomi 2026-08-30, from live /v2 review)
// • SEARCH-FIRST after all: the composer bar (FTS + Product facet +
//   gradient submit) is now IN the hero, ported from V1/BAL-249. The
//   rotator above it stays as the animated problem line, so the input
//   placeholder is static — one moving thing at a time.
// • The hero CTA pair is gone: the gradient "Find an expert" is now
//   the search submit; the secondary became "Submit a project brief"
//   (ghost, under the bar; destination TBD — see OPEN QUESTIONS).
// • PRIMARY-CTA STANDARD (applies to V1 + V2 + product surfaces that
//   use marketing CTAs): blue→violet gradient background with WHITE
//   text. The first /v2 build rendered dark text on the gradient —
//   an implementation override (this ref always sets #fff). BAL-510
//   carries an explicit AC; don't let a shared Button variant win.
//
// OPEN QUESTIONS
// 1. H1 "Not a day rate. A minute." — sharper than V1's "Top
//    Salesforce experts, on demand." but leads with a negation; the
//    approved V1 line survives as this page's rotator+proof copy. MJ.
// 2. "Submit a project brief" — copy (MJ) and destination: existing
//    project-intake route if one exists, else WorkOS sign-up with a
//    returnTo into project creation.
// 3. The agency-timeline contrast punches at the industry — confirm
//    the tone is us. (Timeline days are illustrative.)
// ─────────────────────────────────────────────────────────────────

// ── Vertical config (the seam) ─────────────────────────────────────
const VERTICAL = {
  name: 'Salesforce',
  // Hero rotator: "For the ___" + entry. Keep each ≤5 words.
  rotator: [
    'Flow that broke on Friday.',
    'CPQ quote due tomorrow.',
    'Data Cloud rollout.',
    'Agentforce pilot.',
    'report nobody can build.',
  ],
  // Ticker = product coverage in one line (V1's bench, compressed).
  ticker: [
    'Sales Cloud',
    'Service Cloud',
    'Agentforce',
    'Data Cloud',
    'Revenue Cloud & CPQ',
    'Marketing Cloud',
    'Platform & Apex',
    'Experience Cloud',
    'Tableau',
    'Flow & Automation',
    'MuleSoft',
    'Field Service',
    'Account Engagement',
    'Commerce Cloud',
    'Financial Services Cloud',
    'Slack',
    'Health Cloud',
    'Nonprofit Cloud',
  ],
};

// Mirrors the BAL-249 SearchComposer taxonomy (that file is the source
// of truth) — used by the Product facet popover.
const TAXONOMY = [
  { group: 'AI', items: ['Agentforce'] },
  { group: 'Data Cloud', items: ['Data Cloud'] },
  { group: 'Sales Cloud', items: ['CPQ', 'Sales Cloud'] },
  {
    group: 'Service Cloud',
    items: ['Digital Engagement', 'Field Service', 'Service Cloud', 'Voice'],
  },
  {
    group: 'Marketing Cloud',
    items: [
      'Account Engagement',
      'Engagement',
      'Intelligence',
      'Loyalty Management',
      'Personalisation',
    ],
  },
  { group: 'Slack', items: ['Slack'] },
  { group: 'Experience Cloud', items: ['Experience Cloud'] },
  { group: 'Commerce Cloud', items: ['B2B Commerce', 'B2C Commerce', 'Order Management'] },
  {
    group: 'Platform',
    items: ['AppExchange', 'Heroku', 'Hyperforce', 'Salesforce Platform', 'Security', 'Shield'],
  },
  { group: 'Tableau', items: ['CRM Analytics', 'Tableau'] },
  { group: 'MuleSoft', items: ['MuleSoft'] },
  {
    group: 'Industries',
    items: [
      'Communications Cloud',
      'Consumer Goods Cloud',
      'Education Cloud',
      'Energy & Utilities Cloud',
      'Financial Services Cloud',
      'Government Cloud',
      'Health Cloud',
      'Manufacturing Cloud',
      'Media Cloud',
      'Nonprofit Cloud',
      'OmniStudio',
    ],
  },
  { group: 'Net Zero Cloud', items: ['Net Zero Cloud'] },
];
const DENSE_CAP = 4; // per-group chip cap before "+n more" (matches BAL-249)

// ── Design tokens (palette shared with V1 for brand continuity) ────
const c = {
  ink: '#111827',
  night: '#0B1220',
  text2: '#4B5563',
  text3: '#9CA3AF',
  line: '#E5E9F0',
  lineSoft: '#EEF1F6',
  mist: '#F5F7FB',
  primary: '#2563EB',
  primaryDeep: '#1D4ED8',
  violet: '#7C3AED',
  success: '#059669',
  gradient: 'linear-gradient(135deg, #2563EB 0%, #7C3AED 100%)',
  gradientHover: 'linear-gradient(135deg, #1D4ED8 0%, #6D28D9 100%)',
};

// ── Global styles ──────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400..800&family=Geist+Mono:wght@400..600&display=swap');

*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
html, body { margin: 0; }
body { background: ${c.night}; }

/* ── Page root + tokens ── */
.mk2-page {
  --ink: ${c.ink}; --night: ${c.night}; --text2: ${c.text2}; --text3: ${c.text3};
  --line: ${c.line}; --line-soft: ${c.lineSoft}; --mist: ${c.mist};
  --primary: ${c.primary}; --primary-deep: ${c.primaryDeep}; --violet: ${c.violet};
  --success: ${c.success};
  --grad: ${c.gradient}; --grad-hover: ${c.gradientHover};
  --sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  --ease: cubic-bezier(.22, .61, .36, 1);
  --wrap: 1080px;
  font-family: var(--sans);
  color: var(--ink);
  background: #fff;
  line-height: 1.5;
  -webkit-font-smoothing: antialiased;
  overflow-x: clip;
}
.mk2-wrap { max-width: var(--wrap); margin: 0 auto; padding: 0 24px; }
.mk2-mono { font-family: var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.mk2-page a { color: inherit; }
.mk2-page button { font-family: inherit; }
.mk2-page :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

/* ── Control strip (prototype only) ── */
.mk2-ctl { background: ${c.night}; color: #fff; font-family: var(--mono); font-size: 11px; padding: 10px 20px; display: flex; align-items: center; gap: 22px; flex-wrap: wrap; border-bottom: 1px solid rgba(255,255,255,.08); }
.mk2-ctl-title { font-family: var(--sans); font-weight: 600; font-size: 12px; margin-right: auto; }
.mk2-ctl-title span { color: rgba(255,255,255,.4); font-weight: 500; }
.mk2-ctl-label { color: rgba(255,255,255,.45); text-transform: uppercase; letter-spacing: .08em; font-size: 10px; }
.mk2-ctl-note { color: rgba(255,255,255,.45); font-size: 10px; }
.mk2-seg { display: flex; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); border-radius: 8px; padding: 2px; }
.mk2-seg button { background: transparent; border: none; color: rgba(255,255,255,.55); font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer; transition: all .15s; text-transform: capitalize; }
.mk2-seg button.on { background: #fff; color: ${c.night}; font-weight: 600; }

/* ── Buttons ── */
.mk2-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 46px; padding: 0 22px; border-radius: 12px; font: 600 14.5px/1 var(--sans); cursor: pointer; text-decoration: none; white-space: nowrap; border: 1px solid transparent; transition: transform .2s var(--ease), box-shadow .2s var(--ease), background .2s, border-color .2s, color .2s; }
.mk2-btn:active { transform: translateY(0) scale(.98); }
.mk2-btn-lg { height: 54px; padding: 0 28px; font-size: 15.5px; border-radius: 14px; }
.mk2-btn-grad { position: relative; overflow: hidden; isolation: isolate; background: var(--grad); color: #fff; box-shadow: 0 2px 10px rgba(37,99,235,.28); }
.mk2-btn-grad::before { content: ''; position: absolute; inset: 0; background: var(--grad-hover); opacity: 0; transition: opacity .25s; z-index: -1; }
.mk2-btn-grad:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(37,99,235,.32); }
.mk2-btn-grad:hover::before { opacity: 1; }
.mk2-btn-solid { background: var(--primary); color: #fff; box-shadow: 0 2px 8px rgba(37,99,235,.25); }
.mk2-btn-solid:hover { background: var(--primary-deep); transform: translateY(-1px); box-shadow: 0 6px 18px rgba(37,99,235,.3); }
.mk2-btn-ghost { background: transparent; color: var(--ink); border-color: var(--line); }
.mk2-btn-ghost:hover { background: var(--mist); border-color: #D5DAE3; }
.mk2-btn-text { background: transparent; color: var(--text2); padding: 0 12px; }
.mk2-btn-text:hover { color: var(--ink); background: var(--mist); }
.mk2-btn-white { background: #fff; color: var(--ink); }
.mk2-btn-white:hover { transform: translateY(-1px); box-shadow: 0 8px 22px rgba(0,0,0,.18); }
.mk2-btn svg { transition: transform .2s var(--ease); }
.mk2-btn:hover svg.mk2-arrow { transform: translateX(3px); }

/* ── Nav ── */
.mk2-nav { position: sticky; top: 0; z-index: 40; border-bottom: 1px solid transparent; transition: background .3s, border-color .3s; }
.mk2-nav.is-scrolled { background: rgba(255,255,255,.86); -webkit-backdrop-filter: saturate(180%) blur(14px); backdrop-filter: saturate(180%) blur(14px); border-color: var(--line); }
.mk2-nav-inner { height: 70px; display: flex; align-items: center; gap: 28px; }
.mk2-logo { display: flex; align-items: center; gap: 9px; font-weight: 700; font-size: 19px; letter-spacing: -.02em; text-decoration: none; }
.mk2-logo-mark { width: 28px; height: 28px; border-radius: 8px; background: var(--grad); position: relative; box-shadow: 0 2px 6px rgba(37,99,235,.3); }
.mk2-logo-mark::after { content: ''; position: absolute; left: 8px; top: 8px; width: 12px; height: 12px; border-radius: 4px 4px 4px 1px; background: #fff; }
.mk2-nav-links { display: flex; gap: 2px; margin-left: 6px; }
.mk2-nav-link { position: relative; padding: 8px 12px; font-size: 14px; font-weight: 500; color: var(--text2); text-decoration: none; border-radius: 8px; transition: color .15s; }
.mk2-nav-link:hover { color: var(--ink); }
.mk2-nav-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.mk2-burger { display: none; width: 44px; height: 44px; border-radius: 12px; border: 1px solid var(--line); background: #fff; color: var(--ink); align-items: center; justify-content: center; cursor: pointer; }
.mk2-mnav { position: absolute; left: 0; right: 0; top: 100%; z-index: 39; background: rgba(255,255,255,.97); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); border-bottom: 1px solid var(--line); padding: 12px 24px 20px; display: flex; flex-direction: column; gap: 4px; animation: mk2-drop .25s var(--ease) both; }
.mk2-mnav-link { padding: 12px 10px; font-size: 16px; font-weight: 500; text-decoration: none; border-radius: 10px; }
.mk2-mnav-link:hover { background: var(--mist); }
@media (max-width: 860px) {
  .mk2-nav-links, .mk2-nav-login { display: none; }
  .mk2-burger { display: flex; }
}

/* ── Copy ladder (the system) ── */
.mk2-kicker { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 11px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase; color: var(--primary); margin-bottom: 22px; }
.mk2-kicker::before { content: ''; width: 18px; height: 2px; background: var(--grad); border-radius: 2px; }
.mk2-h2 { font-size: clamp(34px, 5vw, 58px); line-height: 1.04; letter-spacing: -.035em; font-weight: 720; margin: 0; text-wrap: balance; }
.mk2-h2 em { font-style: normal; color: var(--text3); }
.mk2-line { font-size: 17px; color: var(--text2); margin: 18px 0 0; line-height: 1.5; }

/* ── Sections (the air) ── */
.mk2-sec { padding: 150px 0; }
.mk2-tint-blue { background: #F3F6FF; }
.mk2-tint-violet { background: #F8F5FF; }
.mk2-tint-grad { background: linear-gradient(135deg, #EFF6FF 0%, #F5F3FF 100%); }
.mk2-sec-tight { padding: 110px 0; }
.mk2-center { text-align: center; }
.mk2-center .mk2-line { margin-left: auto; margin-right: auto; max-width: 560px; }
@media (max-width: 720px) { .mk2-sec { padding: 88px 0; } .mk2-sec-tight { padding: 64px 0; } }

/* ── Reveals ── */
.mk2-reveal { opacity: 0; transform: translateY(16px); transition: opacity .8s var(--ease), transform .8s var(--ease); transition-delay: calc(var(--i, 0) * 100ms); }
.mk2-reveal-group.is-in .mk2-reveal { opacity: 1; transform: none; }

/* ── Hero ── */
.mk2-hero { position: relative; overflow: hidden; padding: 92px 0 0; text-align: center; }
.mk2-hero .mk2-wrap { position: relative; }
.mk2-aurora { position: absolute; inset: 0; pointer-events: none; }
.mk2-aur { position: absolute; border-radius: 50%; filter: blur(60px); will-change: transform; }
.mk2-aur-a { width: 560px; height: 560px; left: -140px; top: -220px; background: radial-gradient(circle at 40% 40%, rgba(37,99,235,.22), rgba(37,99,235,0) 65%); animation: mk2-drift-a 28s ease-in-out infinite alternate; }
.mk2-aur-b { width: 640px; height: 640px; right: -180px; top: -200px; background: radial-gradient(circle at 60% 40%, rgba(124,58,237,.18), rgba(124,58,237,0) 65%); animation: mk2-drift-b 32s ease-in-out infinite alternate; }
.mk2-aur-c { width: 560px; height: 340px; left: 50%; top: 190px; margin-left: -280px; background: radial-gradient(ellipse, rgba(37,99,235,.10), transparent 65%); }
.mk2-hero-fade { position: absolute; left: 0; right: 0; bottom: 0; height: 150px; background: linear-gradient(to bottom, rgba(255,255,255,0), #fff); }
.mk2-hero .mk2-wrap > * { animation: mk2-up .8s var(--ease) both; }
.mk2-hero .mk2-wrap > :nth-child(1) { animation-delay: .05s; }
.mk2-hero .mk2-wrap > :nth-child(2) { animation-delay: .15s; }
.mk2-hero .mk2-wrap > :nth-child(3) { animation-delay: .26s; }
.mk2-hero .mk2-wrap > :nth-child(4) { animation-delay: .37s; }
.mk2-hero .mk2-wrap > :nth-child(5) { animation-delay: .48s; }
.mk2-hero .mk2-wrap > :nth-child(6) { animation-delay: .58s; }
.mk2-hero > .mk2-ticker { animation: mk2-up .9s var(--ease) .68s both; }

.mk2-live { display: inline-flex; align-items: center; gap: 10px; padding: 6px 14px 6px 7px; border-radius: 999px; background: #fff; border: 1px solid var(--line); box-shadow: 0 1px 2px rgba(0,0,0,.04); font-size: 13px; font-weight: 500; color: var(--text2); }
.mk2-avs { display: flex; }
.mk2-av { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #fff; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 9px; font-weight: 700; margin-left: -7px; }
.mk2-av:first-child { margin-left: 0; }
.mk2-live-dot { width: 7px; height: 7px; border-radius: 50%; background: #34D399; animation: mk2-ping 2s infinite; }
.mk2-live b { color: var(--ink); font-weight: 600; }

.mk2-h1 { font-size: clamp(40px, 9.5vw, 112px); line-height: .98; letter-spacing: -.045em; font-weight: 750; margin: 34px 0 0; }
.mk2-h1-grad { background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }

.mk2-rotline { font-size: clamp(17px, 2vw, 21px); color: var(--text2); margin: 26px 0 0; min-height: 1.6em; }
.mk2-rot { display: inline-block; font-weight: 600; color: var(--ink); transition: opacity .35s var(--ease), transform .35s var(--ease); }
.mk2-rot.is-out { opacity: 0; transform: translateY(8px); }

/* ── Hero search (mirrors the BAL-249 unified bar; see REVISIONS) ── */
.mk2-search { position: relative; display: flex; align-items: center; gap: 6px; max-width: 760px; margin: 34px auto 0; background: #fff; border: 1px solid var(--line); border-radius: 18px; padding: 8px 8px 8px 18px; box-shadow: 0 10px 34px -14px rgba(17,24,39,.16), 0 1px 3px rgba(17,24,39,.05); text-align: left; transition: box-shadow .25s var(--ease), border-color .2s; }
.mk2-search:focus-within { border-color: rgba(37,99,235,.55); box-shadow: 0 14px 40px -14px rgba(37,99,235,.3), 0 0 0 4px rgba(37,99,235,.10); }
.mk2-search-icon { color: var(--text3); display: flex; flex-shrink: 0; }
.mk2-search-input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: 500 16px var(--sans); color: var(--ink); padding: 10px 4px; }
.mk2-search-input::placeholder { color: var(--text3); }
.mk2-search-input:focus-visible { outline: none; }
.mk2-sdiv { width: 1px; align-self: stretch; margin: 8px 0; background: var(--line-soft); flex-shrink: 0; }
.mk2-facet { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 12px; border: none; background: transparent; border-radius: 10px; cursor: pointer; color: var(--text2); transition: background .15s; flex-shrink: 0; }
.mk2-facet:hover, .mk2-facet.is-open { background: var(--mist); }
.mk2-facet-txt { display: flex; flex-direction: column; align-items: flex-start; line-height: 1.15; }
.mk2-facet-lab { font-family: var(--mono); font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: var(--text3); }
.mk2-facet-val { font-size: 13px; font-weight: 500; color: var(--text3); max-width: 110px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mk2-facet-val.has { color: var(--ink); font-weight: 600; }
.mk2-facet-badge { min-width: 17px; height: 17px; padding: 0 4px; border-radius: 9px; background: var(--primary); color: #fff; font-size: 10.5px; font-weight: 600; display: flex; align-items: center; justify-content: center; }
.mk2-facet svg { transition: transform .2s var(--ease); }
.mk2-facet svg.mk2-rot180 { transform: rotate(180deg); }
.mk2-facet-pop { position: absolute; top: calc(100% + 10px); right: 0; width: min(460px, calc(100vw - 48px)); background: #fff; border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 24px 60px -12px rgba(17,24,39,.25); padding: 14px; z-index: 30; text-align: left; animation: mk2-drop .2s var(--ease) both; }
.mk2-pop-search { display: flex; align-items: center; gap: 8px; height: 38px; padding: 0 12px; border: 1px solid var(--line); border-radius: 10px; color: var(--text3); }
.mk2-pop-search input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font: 500 13.5px var(--sans); color: var(--ink); }
.mk2-pop-x { display: flex; background: none; border: none; cursor: pointer; color: var(--text3); padding: 2px; }
.mk2-pop-sel { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 11px; color: var(--text2); }
.mk2-pop-sel button { background: none; border: none; cursor: pointer; font: 500 12px var(--sans); color: var(--text2); text-decoration: underline; }
.mk2-pop-scroll { max-height: 280px; overflow-y: auto; margin-top: 12px; padding-right: 4px; }
.mk2-pop-group { margin-bottom: 14px; }
.mk2-pop-glab { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--text2); margin-bottom: 8px; }
.mk2-pop-glab em { font-style: normal; color: var(--text3); margin-left: 6px; }
.mk2-pop-chips { display: flex; flex-wrap: wrap; gap: 7px; }
.mk2-pchip { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: 9px; font: 500 12.5px var(--sans); color: var(--ink); background: #fff; border: 1px solid var(--line); cursor: pointer; transition: all .15s var(--ease); }
.mk2-pchip:hover { border-color: rgba(37,99,235,.45); background: var(--mist); }
.mk2-pchip.on { color: var(--primary); background: #EFF6FF; border-color: #BFDBFE; font-weight: 600; }
.mk2-pchip-more { border-style: dashed; color: var(--text2); }
.mk2-pop-none { font-size: 13px; color: var(--text3); text-align: center; padding: 18px 0; margin: 0; }
.mk2-alt { margin-top: 14px; }
@media (max-width: 640px) {
  .mk2-search { flex-wrap: wrap; padding: 10px; border-radius: 16px; gap: 8px; }
  .mk2-search-icon { display: none; }
  .mk2-search-input { flex-basis: 100%; padding: 8px; }
  .mk2-sdiv { display: none; }
  .mk2-facet { flex: 1; justify-content: center; border: 1px solid var(--line); border-radius: 12px; }
  .mk2-search .mk2-btn { flex: 1; }
  .mk2-facet-pop { left: 0; right: 0; width: auto; }
}
.mk2-proofline { font-family: var(--mono); font-size: 12px; color: var(--text3); margin-top: 22px; letter-spacing: .01em; }
.mk2-proofline b { color: var(--text2); font-weight: 500; }

/* ── Ticker (the only list on the page) ── */
.mk2-ticker { position: relative; margin-top: 84px; padding: 22px 0; border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft); overflow: hidden; -webkit-mask-image: linear-gradient(to right, transparent, #000 8%, #000 92%, transparent); mask-image: linear-gradient(to right, transparent, #000 8%, #000 92%, transparent); }
.mk2-ticker-track { display: flex; align-items: center; width: max-content; animation: mk2-scroll 55s linear infinite; }
.mk2-ticker-half { display: flex; align-items: center; gap: 34px; padding-right: 34px; }
.mk2-ticker-half > span { display: flex; align-items: center; gap: 34px; }
.mk2-ticker:hover .mk2-ticker-track { animation-play-state: paused; }
.mk2-tick { font-family: var(--mono); font-size: 13px; color: var(--text2); text-decoration: none; white-space: nowrap; transition: color .15s; }
.mk2-tick:hover { color: var(--primary); }
.mk2-tickdot { width: 4px; height: 4px; border-radius: 50%; background: var(--primary); opacity: .35; flex-shrink: 0; }

/* ── Contrast (agency vs Balo) ── */
.mk2-vs { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; margin-top: 56px; text-align: left; }
.mk2-vs-card { border-radius: 20px; padding: 26px 28px; }
.mk2-vs-old { border: 1px dashed var(--line); color: var(--text3); }
.mk2-vs-balo { border: 1px solid transparent; background: linear-gradient(#fff, #fff) padding-box, var(--grad) border-box; box-shadow: 0 18px 44px -24px rgba(37,99,235,.35); }
.mk2-vs-label { font-family: var(--mono); font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 18px; }
.mk2-vs-old .mk2-vs-label { color: var(--text3); }
.mk2-vs-balo .mk2-vs-label { color: var(--primary); }
.mk2-vs-row { display: flex; align-items: baseline; gap: 14px; padding: 9px 0; font-size: 14.5px; }
.mk2-vs-old .mk2-vs-row { color: var(--text3); }
.mk2-vs-when { font-family: var(--mono); font-size: 12px; flex-shrink: 0; min-width: 64px; }
.mk2-vs-balo .mk2-vs-when { color: var(--primary); }
.mk2-vs-check { color: var(--success); display: inline-flex; margin-left: auto; }
.mk2-vs-foot { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--line-soft); font-family: var(--mono); font-size: 12.5px; }
.mk2-vs-old .mk2-vs-foot { border-top-style: dashed; border-color: var(--line); }
.mk2-vs-balo .mk2-vs-foot { color: var(--ink); font-weight: 500; }
@media (max-width: 760px) { .mk2-vs { grid-template-columns: 1fr; } }

/* ── Ways (typographic ledger) ── */
.mk2-ways { margin-top: 56px; border-top: 1px solid var(--line); }
.mk2-way { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 24px; padding: 34px 6px; border-bottom: 1px solid var(--line); text-decoration: none; transition: background .2s; }
.mk2-way:hover { background: #F3F6FF; }
.mk2-way-name { font-size: clamp(26px, 3.4vw, 40px); font-weight: 720; letter-spacing: -.03em; line-height: 1.05; transition: transform .25s var(--ease); }
.mk2-way:hover .mk2-way-name { transform: translateX(8px); }
.mk2-way-desc { font-size: 15.5px; color: var(--text2); text-align: right; }
.mk2-way-desc .mk2-mono { color: var(--ink); font-weight: 500; font-size: 13.5px; }
.mk2-way-arrow { color: var(--text3); display: flex; transition: transform .25s var(--ease), color .2s; }
.mk2-way:hover .mk2-way-arrow { transform: translateX(4px); color: var(--primary); }
@media (max-width: 680px) {
  .mk2-way { grid-template-columns: 1fr auto; row-gap: 8px; padding: 26px 2px; }
  .mk2-way-desc { grid-column: 1 / -1; text-align: left; }
}

/* ── Steps (typographic, a real sequence) ── */
.mk2-steps { display: grid; grid-template-columns: repeat(3, 1fr); gap: 44px; margin-top: 64px; text-align: left; }
.mk2-step-num { font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--primary); letter-spacing: .06em; }
.mk2-step h3 { font-size: clamp(22px, 2.6vw, 30px); font-weight: 720; letter-spacing: -.025em; margin: 12px 0 8px; }
.mk2-step p { font-size: 15.5px; color: var(--text2); margin: 0; }
.mk2-step { position: relative; padding-top: 22px; }
.mk2-step::before { content: ''; position: absolute; top: 0; left: 0; width: 44px; height: 2px; background: var(--grad); border-radius: 2px; transform: scaleX(0); transform-origin: left; transition: transform .9s var(--ease); transition-delay: calc(var(--i, 0) * 180ms); }
.mk2-reveal-group.is-in .mk2-step::before { transform: scaleX(1); }
@media (max-width: 760px) { .mk2-steps { grid-template-columns: 1fr; gap: 36px; } }

/* ── Spotlight (real experts — see BAL-493) ── */
.mk2-experts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 56px; text-align: left; }
.mk2-xc { border: 1px solid var(--line); border-radius: 20px; padding: 24px; background: #fff; display: flex; flex-direction: column; gap: 4px; transition: transform .3s var(--ease), box-shadow .3s var(--ease), border-color .2s; }
.mk2-xc:hover { transform: translateY(-4px); box-shadow: 0 24px 48px -26px rgba(37,99,235,.28); border-color: rgba(37,99,235,.35); }
.mk2-xc-top { display: flex; align-items: center; gap: 14px; margin-bottom: 12px; }
.mk2-xc-av { width: 52px; height: 52px; border-radius: 15px; display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 16px; letter-spacing: -.02em; flex-shrink: 0; position: relative; }
.mk2-xc-avdot { position: absolute; right: -3px; bottom: -3px; width: 11px; height: 11px; border-radius: 50%; background: #34D399; border: 2px solid #fff; }
.mk2-xc-name { font-size: 16.5px; font-weight: 650; letter-spacing: -.015em; line-height: 1.2; }
.mk2-xc-spec { font-size: 13px; color: var(--text2); margin-top: 3px; }
.mk2-xc-rate { font-family: var(--mono); font-size: 13.5px; font-weight: 600; }
.mk2-xc-rate small { color: var(--text3); font-weight: 400; font-size: 11px; margin-left: 4px; }
.mk2-xc-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
.mk2-xc-book { display: inline-flex; align-items: center; gap: 6px; font-size: 13.5px; font-weight: 600; color: #fff; background: var(--grad); border: none; border-radius: 10px; height: 38px; padding: 0 16px; cursor: pointer; transition: transform .2s var(--ease), box-shadow .2s var(--ease); }
.mk2-xc-book:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(37,99,235,.32); }
.mk2-xc-profile { font-size: 13.5px; font-weight: 550; color: var(--text2); text-decoration: none; }
.mk2-xc-profile:hover { color: var(--ink); }
.mk2-browse { display: inline-flex; align-items: center; gap: 7px; margin-top: 36px; font-size: 15px; font-weight: 600; color: var(--primary); text-decoration: none; }
.mk2-browse svg { transition: transform .2s var(--ease); }
.mk2-browse:hover svg { transform: translateX(3px); }
@media (max-width: 860px) { .mk2-experts { grid-template-columns: 1fr; } }

/* ── Pricing ── */
.mk2-price-wrap { position: relative; display: flex; justify-content: center; margin-top: 56px; }
.mk2-price-glow { position: absolute; inset: -40px 18%; background: radial-gradient(ellipse at 30% 40%, rgba(37,99,235,.16), transparent 60%), radial-gradient(ellipse at 70% 60%, rgba(124,58,237,.14), transparent 60%); filter: blur(30px); pointer-events: none; }
.mk2-receipt { position: relative; width: 340px; max-width: 100%; background: #fff; border-radius: 20px; border: 1px solid var(--line); box-shadow: 0 30px 60px -30px rgba(17,24,39,.3), 0 2px 6px rgba(17,24,39,.06); padding: 24px; text-align: left; animation: mk2-float 7s ease-in-out infinite alternate; }
.mk2-receipt-head { display: flex; justify-content: space-between; align-items: baseline; padding-bottom: 14px; border-bottom: 1px solid var(--line-soft); }
.mk2-receipt-title { font-size: 13.5px; font-weight: 650; }
.mk2-receipt-tag { font-family: var(--mono); font-size: 10.5px; color: var(--text3); }
.mk2-receipt-row { display: flex; justify-content: space-between; padding: 11px 0; font-size: 14px; color: var(--text2); border-bottom: 1px solid var(--line-soft); }
.mk2-receipt-row .mk2-mono { color: var(--ink); font-weight: 500; }
.mk2-receipt-total { display: flex; justify-content: space-between; align-items: baseline; padding-top: 14px; }
.mk2-receipt-total span { font-size: 13.5px; font-weight: 600; }
.mk2-receipt-total .mk2-mono { font-size: 24px; font-weight: 600; letter-spacing: -.02em; }
.mk2-receipt-foot { margin-top: 12px; display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; color: var(--success); background: rgba(5,150,105,.09); border-radius: 999px; padding: 5px 10px; }
.mk2-nos { font-family: var(--mono); font-size: 12.5px; color: var(--text3); margin-top: 36px; letter-spacing: .01em; }

/* ── Quote ── */
.mk2-quote { max-width: 760px; margin: 0 auto; }
.mk2-quote blockquote { font-size: clamp(22px, 3vw, 32px); line-height: 1.3; letter-spacing: -.02em; font-weight: 550; margin: 0; text-wrap: balance; }
.mk2-quote blockquote::before { content: '“'; color: var(--primary); }
.mk2-quote blockquote::after { content: '”'; color: var(--primary); }
.mk2-quote-who { margin-top: 26px; display: flex; align-items: center; justify-content: center; gap: 12px; }
.mk2-quote-av { width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 12px; font-weight: 700; }
.mk2-quote-name { font-size: 14px; font-weight: 600; text-align: left; }
.mk2-quote-role { font-size: 12.5px; color: var(--text2); }

/* ── Expert band ── */
.mk2-band { position: relative; overflow: hidden; background: var(--night); color: #fff; }
.mk2-band .mk2-reveal-group { position: relative; }
.mk2-band-glow { position: absolute; border-radius: 50%; filter: blur(70px); pointer-events: none; }
.mk2-band-glow-a { width: 520px; height: 520px; left: -140px; top: -160px; background: radial-gradient(circle, rgba(37,99,235,.35), transparent 65%); }
.mk2-band-glow-b { width: 560px; height: 560px; right: -160px; bottom: -200px; background: radial-gradient(circle, rgba(124,58,237,.3), transparent 65%); }
.mk2-band .mk2-kicker { color: rgba(255,255,255,.55); }
.mk2-band .mk2-h2 { color: #fff; }
.mk2-band .mk2-line { color: rgba(255,255,255,.65); }
.mk2-band-ctas { margin-top: 34px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.mk2-btn-outline-light { background: rgba(255,255,255,.06); color: #fff; border-color: rgba(255,255,255,.25); }
.mk2-btn-outline-light:hover { background: rgba(255,255,255,.12); border-color: rgba(255,255,255,.4); }

/* ── Final ── */
.mk2-final-card { position: relative; overflow: hidden; border-radius: 28px; background: var(--grad); color: #fff; padding: 76px 40px; }
.mk2-final-card::before { content: ''; position: absolute; inset: 0; background: radial-gradient(circle at 18% 20%, rgba(255,255,255,.2), transparent 45%), radial-gradient(circle at 85% 85%, rgba(255,255,255,.14), transparent 40%); }
.mk2-final-card > * { position: relative; }
.mk2-final-card .mk2-h2 { color: #fff; }
.mk2-final-card .mk2-h2 em { color: rgba(255,255,255,.72); }
.mk2-final-ctas { margin-top: 36px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
@media (max-width: 720px) { .mk2-final-card { padding: 52px 24px; border-radius: 22px; } }

/* ── Footer (compact, one row) ── */
.mk2-footer { border-top: 1px solid var(--line); padding: 34px 0; }
.mk2-footer-inner { display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
.mk2-footer-links { display: flex; gap: 22px; flex-wrap: wrap; }
.mk2-footer-links a { font-size: 13.5px; color: var(--text2); text-decoration: none; }
.mk2-footer-links a:hover { color: var(--ink); }
.mk2-footer-legal { font-size: 12.5px; color: var(--text3); }

/* ── Reduced motion ── */
.mk2-page.reduced .mk2-hero > * { animation: none; }
.mk2-page.reduced .mk2-live-dot, .mk2-page.reduced .mk2-aur { animation: none; }
.mk2-page.reduced .mk2-ticker-track { animation: none; width: auto; }
.mk2-page.reduced .mk2-ticker-half[aria-hidden] { display: none; }
.mk2-page.reduced .mk2-ticker-half { flex-wrap: wrap; justify-content: center; padding-right: 0; width: 100%; }
.mk2-page.reduced .mk2-receipt { animation: none; }
.mk2-page.reduced .mk2-reveal { opacity: 1; transform: none; transition: none; }
.mk2-page.reduced .mk2-step::before { transition: none; transform: scaleX(1); }
.mk2-page.reduced .mk2-rot { transition: none; }
.mk2-page.reduced .mk2-facet-pop { animation: none; }
.mk2-page.reduced .mk2-btn, .mk2-page.reduced .mk2-way, .mk2-page.reduced .mk2-xc, .mk2-page.reduced .mk2-pchip, .mk2-page.reduced .mk2-facet { transition-duration: .01s; }

/* ── Keyframes ── */
@keyframes mk2-up { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes mk2-drop { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes mk2-ping { 0% { box-shadow: 0 0 0 0 rgba(52,211,153,.55); } 70% { box-shadow: 0 0 0 7px rgba(52,211,153,0); } 100% { box-shadow: 0 0 0 0 rgba(52,211,153,0); } }
@keyframes mk2-scroll { from { transform: translate3d(0,0,0); } to { transform: translate3d(-50%,0,0); } }
@keyframes mk2-float { from { transform: translateY(0); } to { transform: translateY(-12px); } }
@keyframes mk2-drift-a { from { transform: translate3d(0,0,0); } to { transform: translate3d(60px, 44px, 0); } }
@keyframes mk2-drift-b { from { transform: translate3d(0,0,0); } to { transform: translate3d(-52px, 60px, 0); } }
`;

// ── Inline SVG icons (Lucide, stroke 2, round caps) ────────────────
const Svg = ({ size = 16, color = 'currentColor', className, children }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);
const I = {
  arrow: (p) => (
    <Svg {...p} className="mk2-arrow">
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </Svg>
  ),
  arrowPlain: (p) => (
    <Svg {...p}>
      <path d="M5 12h14" />
      <path d="M12 5l7 7-7 7" />
    </Svg>
  ),
  check: (p) => (
    <Svg {...p}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  video: (p) => (
    <Svg {...p}>
      <polygon points="23 7 16 12 23 17 23 7" />
      <rect x="1" y="5" width="15" height="14" rx="2" />
    </Svg>
  ),
  menu: (p) => (
    <Svg {...p}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </Svg>
  ),
  x: (p) => (
    <Svg {...p}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  ),
  search: (p) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </Svg>
  ),
  box: (p) => (
    <Svg {...p}>
      <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </Svg>
  ),
  chev: (p) => (
    <Svg {...p}>
      <polyline points="6 9 12 15 18 9" />
    </Svg>
  ),
};

// ── Avatar helpers (same hash + gradients as ExpertCard, BAL-214) ──
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #0F4C81 0%, #2a7fd4 100%)',
  'linear-gradient(135deg, #1e3a5f 0%, #0F4C81 100%)',
  'linear-gradient(135deg, #3b0764 0%, #7C3AED 100%)',
  'linear-gradient(135deg, #064e3b 0%, #059669 100%)',
  'linear-gradient(135deg, #7c2d12 0%, #ea580c 100%)',
  'linear-gradient(135deg, #1e1b4b 0%, #4F46E5 100%)',
];
const avatarGradient = (key) =>
  AVATAR_GRADIENTS[
    key.split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) % AVATAR_GRADIENTS.length
  ];
const initials = (name) =>
  name
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

// ── Sample data (ALL PLACEHOLDER — see header) ─────────────────────
const LIVE_COUNT = 38;
const CLUSTER = ['Priya Nair', 'Tom Okafor', 'Mei-Ling Chao', 'Diego Ferreira', 'Zoe Adeyemi'];

// Spotlight — production renders REAL experts via ExpertCard (BAL-493).
const EXPERTS = [
  { id: 'usr_priya', n: 'Priya Nair', s: 'Data Cloud · Agentforce', r: 2.4 },
  { id: 'usr_tom', n: 'Tom Okafor', s: 'Sales Cloud · CPQ', r: 1.85 },
  { id: 'usr_amara', n: 'Amara Diallo', s: 'Financial Services Cloud', r: 2.55 },
];

const WAYS = [
  { name: 'Consultations', desc: 'By the minute.', tag: 'From A$1.20/min', href: '#experts' },
  {
    name: 'Projects',
    desc: 'Scoped and milestoned, end to end.',
    tag: 'Fixed scope',
    href: '#experts',
  },
  {
    name: 'Packages',
    desc: 'A set price for a known outcome.',
    tag: 'Fixed price',
    href: '#experts',
  },
];

const STEPS = [
  { num: '01', title: 'Describe it', body: 'A sentence is enough.' },
  { num: '02', title: 'Pick your expert', body: 'Vetted, rated, priced upfront.' },
  { num: '03', title: 'Get on a call', body: 'Screen-share. Fix it together. Done.' },
];

const QUOTE = {
  text: 'We ask the small questions now instead of saving them up for a paid workshop.',
  name: 'Alex Rivera',
  role: 'Salesforce Admin · nonprofit',
};

const FOOTER_LINKS = [
  ['Find experts', '#experts'],
  ['How it works', '#how'],
  ['Pricing', '#pricing'],
  ['For experts', '#for-experts'],
  ['Privacy', '#'],
  ['Terms', '#'],
];

// ─────────────────────────────────────────────────────────────────
// MOTION CONTEXT + HOOKS
// ─────────────────────────────────────────────────────────────────
const MotionCtx = createContext(false);
const useReduced = () => useContext(MotionCtx);

function usePrefersReduced() {
  const [pref, setPref] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPref(mq.matches);
    const f = (e) => setPref(e.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  return pref;
}

function useInView() {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
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

function Group({ children, className = '', ...rest }) {
  const [ref, inView] = useInView();
  return (
    <div ref={ref} className={`mk2-reveal-group${inView ? ' is-in' : ''} ${className}`} {...rest}>
      {children}
    </div>
  );
}

// Rotating hero line — Viktor's rotating-copy device.
function useRotator(items, reduced) {
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
  return [items[i], out];
}

// ─────────────────────────────────────────────────────────────────
// CONTROL STRIP (prototype only — do not ship)
// ─────────────────────────────────────────────────────────────────
function Seg({ value, onChange, options }) {
  return (
    <div className="mk2-seg" role="group">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          className={value === o ? 'on' : ''}
          onClick={() => onChange(o)}
          aria-pressed={value === o}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function ControlStrip({ motion, setMotion, prefersReduced }) {
  return (
    <div className="mk2-ctl">
      <span className="mk2-ctl-title">
        Balo — Marketing Home V2 <span>· design ref · compare with marketing-home.jsx (V1)</span>
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span className="mk2-ctl-label">Motion</span>
        <Seg value={motion} onChange={setMotion} options={['full', 'reduced']} />
        {prefersReduced && <span className="mk2-ctl-note">OS prefers reduced</span>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// NAV — transparent → frosted glass; CTA is SOLID (per Yomi, V1 rule)
// ─────────────────────────────────────────────────────────────────
const NAV_LINKS = [
  ['Find experts', '#experts'],
  ['How it works', '#how'],
  ['Pricing', '#pricing'],
  ['For experts', '#for-experts'],
];

function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const f = () => setScrolled((window.scrollY || 0) > 24);
    f();
    window.addEventListener('scroll', f, { passive: true });
    return () => window.removeEventListener('scroll', f);
  }, []);
  return (
    <header className={`mk2-nav${scrolled || open ? ' is-scrolled' : ''}`}>
      <div className="mk2-wrap mk2-nav-inner">
        {/* Logo mark is a stand-in — swap for the real asset */}
        <a className="mk2-logo" href="#top" aria-label="Balo home">
          <span className="mk2-logo-mark" />
          Balo
        </a>
        <nav className="mk2-nav-links" aria-label="Primary">
          {NAV_LINKS.map(([l, h]) => (
            <a key={h} className="mk2-nav-link" href={h}>
              {l}
            </a>
          ))}
        </nav>
        <div className="mk2-nav-right">
          <a className="mk2-btn mk2-btn-text mk2-nav-login" href="#top">
            Log in
          </a>
          <a className="mk2-btn mk2-btn-solid" href="#experts">
            Find an expert
          </a>
          <button
            type="button"
            className="mk2-burger"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={open ? 'Close menu' : 'Open menu'}
          >
            {open ? <I.x size={20} /> : <I.menu size={20} />}
          </button>
        </div>
      </div>
      {open && (
        <div className="mk2-mnav">
          {NAV_LINKS.map(([l, h]) => (
            <a key={h} className="mk2-mnav-link" href={h} onClick={() => setOpen(false)}>
              {l}
            </a>
          ))}
          <a className="mk2-mnav-link" href="#top" onClick={() => setOpen(false)}>
            Log in
          </a>
        </div>
      )}
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────
// HERO — the whole model in six words, then a rotating problem line
// ─────────────────────────────────────────────────────────────────
// Visual stand-in for the BAL-249 ProductSelector (search-composer.jsx):
// mini search + grouped chips + dense-cap "+n more" + tokens summary.
// Production mounts the real component; omitted here: match highlighting.
function ProductFacet({ products, toggle, clear, open, setOpen }) {
  const [pq, setPq] = useState('');
  const [expanded, setExpanded] = useState({});
  const arr = [...products];
  const summary =
    arr.length === 0 ? 'Any' : arr.length === 1 ? arr[0] : `${arr[0]} +${arr.length - 1}`;
  const filtered = useMemo(() => {
    if (!pq) return TAXONOMY;
    const ql = pq.toLowerCase();
    return TAXONOMY.map((g) => ({
      ...g,
      items: g.items.filter((i) => i.toLowerCase().includes(ql)),
    })).filter((g) => g.items.length > 0 || g.group.toLowerCase().includes(ql));
  }, [pq]);
  return (
    <>
      <button
        type="button"
        className={`mk2-facet${open ? ' is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <I.box size={15} />
        <span className="mk2-facet-txt">
          <span className="mk2-facet-lab">Product</span>
          <span className={`mk2-facet-val${arr.length ? ' has' : ''}`}>{summary}</span>
        </span>
        {arr.length > 0 && <span className="mk2-facet-badge mk2-mono">{arr.length}</span>}
        <I.chev size={14} className={open ? 'mk2-rot180' : undefined} />
      </button>
      {open && (
        <div className="mk2-facet-pop" role="dialog" aria-label="Filter by product">
          <div className="mk2-pop-search">
            <I.search size={14} />
            <input
              value={pq}
              onChange={(e) => setPq(e.target.value)}
              placeholder="Search products…"
              aria-label="Search products"
            />
            {pq && (
              <button
                type="button"
                className="mk2-pop-x"
                onClick={() => setPq('')}
                aria-label="Clear product search"
              >
                <I.x size={13} />
              </button>
            )}
          </div>
          {arr.length > 0 && (
            <div className="mk2-pop-sel">
              <span className="mk2-mono">{arr.length} selected</span>
              <button type="button" onClick={clear}>
                Clear all
              </button>
            </div>
          )}
          <div className="mk2-pop-scroll">
            {filtered.length === 0 && <p className="mk2-pop-none">No products match "{pq}"</p>}
            {filtered.map((g) => {
              const dense = g.items.length > DENSE_CAP && !pq;
              const show = dense && !expanded[g.group] ? g.items.slice(0, DENSE_CAP) : g.items;
              const hidden = g.items.length - show.length;
              return (
                <div key={g.group} className="mk2-pop-group">
                  <div className="mk2-pop-glab">
                    {g.group}
                    {g.items.length > 1 && <em>{g.items.length}</em>}
                  </div>
                  <div className="mk2-pop-chips">
                    {show.map((it) => (
                      <button
                        key={it}
                        type="button"
                        className={`mk2-pchip${products.has(it) ? ' on' : ''}`}
                        onClick={() => toggle(it)}
                        aria-pressed={products.has(it)}
                      >
                        {products.has(it) && <I.check size={12} />}
                        {it}
                      </button>
                    ))}
                    {hidden > 0 && (
                      <button
                        type="button"
                        className="mk2-pchip mk2-pchip-more"
                        onClick={() => setExpanded((x) => ({ ...x, [g.group]: true }))}
                      >
                        +{hidden} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function Hero() {
  const reduced = useReduced();
  const [rot, out] = useRotator(VERTICAL.rotator, reduced);
  const [q, setQ] = useState('');
  const [products, setProducts] = useState(new Set());
  const [facetOpen, setFacetOpen] = useState(false);
  const searchRef = useRef(null);
  const toggleProduct = (it) =>
    setProducts((prev) => {
      const n = new Set(prev);
      if (n.has(it)) n.delete(it);
      else n.add(it);
      return n;
    });
  useEffect(() => {
    if (!facetOpen) return;
    const down = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) setFacetOpen(false);
    };
    const key = (e) => {
      if (e.key === 'Escape') setFacetOpen(false);
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [facetOpen]);

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
          <span className={`mk2-rot${out ? ' is-out' : ''}`}>{rot}</span>
        </p>

        {/* Production: mount the real SearchComposer unified bar (BAL-249) —
            this mirrors its FTS field + Product facet + submit. Placeholder is
            static because the rotator above already animates the problems. */}
        <div className="mk2-search" role="search" ref={searchRef}>
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
            products={products}
            toggle={toggleProduct}
            clear={() => setProducts(new Set())}
            open={facetOpen}
            setOpen={setFacetOpen}
          />
          <button type="button" className="mk2-btn mk2-btn-grad">
            Find an expert
            <I.arrow size={15} />
          </button>
        </div>

        {/* Brief-intake destination TBD — see OPEN QUESTIONS #2 */}
        <div className="mk2-alt">
          <a className="mk2-btn mk2-btn-ghost" href="#top">
            Submit a project brief
          </a>
        </div>

        <p className="mk2-proofline">
          Top <b>1%</b> of applicants · avg first session <b>&lt; 2 hrs</b> · pay for the minutes
          you use
        </p>
      </div>

      {/* Product coverage, one line — V1's bench, compressed */}
      {/* Duplicated half makes the -50% marquee loop seamless; the copy
          is one aria-hidden unit with unfocusable links. */}
      <div className="mk2-ticker" aria-label={`${VERTICAL.name} products covered by Balo experts`}>
        <div className="mk2-ticker-track">
          {[false, true].map((dup) => (
            <div key={dup ? 'b' : 'a'} className="mk2-ticker-half" aria-hidden={dup || undefined}>
              {VERTICAL.ticker.map((p) => (
                <span key={p}>
                  <a className="mk2-tick" href="#experts" tabIndex={dup ? -1 : undefined}>
                    {p}
                  </a>
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

// ─────────────────────────────────────────────────────────────────
// CONTRAST — the Viktor device, rebuilt for consulting procurement
// (Timeline days are illustrative placeholders.)
// ─────────────────────────────────────────────────────────────────
function Contrast() {
  return (
    <Group className="mk2-sec mk2-center mk2-tint-blue" id="difference">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">The difference</span>
        <h2 className="mk2-h2 mk2-reveal" style={{ '--i': 1 }}>
          An agency scopes.
          <br />
          Balo solves.
        </h2>
        <p className="mk2-line mk2-reveal" style={{ '--i': 2 }}>
          Same calibre of expert. None of the ceremony.
        </p>

        <div className="mk2-vs">
          <div className="mk2-vs-card mk2-vs-old mk2-reveal" style={{ '--i': 3 }}>
            <div className="mk2-vs-label">The old way</div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">Day 1</span>Discovery call
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">Day 9</span>Proposal
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">Day 23</span>SOW signed
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">Week 6</span>Kickoff
            </div>
            <div className="mk2-vs-foot mk2-mono">Invoice: TBD</div>
          </div>
          <div className="mk2-vs-card mk2-vs-balo mk2-reveal" style={{ '--i': 4 }}>
            <div className="mk2-vs-label">With Balo</div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">2:14 pm</span>Booked
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">2:30 pm</span>On the call
            </div>
            <div className="mk2-vs-row">
              <span className="mk2-vs-when mk2-mono">2:53 pm</span>Fixed
              <span className="mk2-vs-check">
                <I.check size={15} />
              </span>
            </div>
            <div className="mk2-vs-foot mk2-mono">23 min · A$55.20 · Service fee included</div>
          </div>
        </div>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// WAYS — three engagement types as a typographic ledger
// ─────────────────────────────────────────────────────────────────
function Ways() {
  return (
    <Group className="mk2-sec-tight mk2-center" id="ways">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">Three ways in</span>
        <h2 className="mk2-h2 mk2-reveal" style={{ '--i': 1 }}>
          Small question or six-week build.
        </h2>
        <div className="mk2-ways mk2-reveal" style={{ '--i': 2, textAlign: 'left' }}>
          {WAYS.map((w) => (
            <a key={w.name} className="mk2-way" href={w.href}>
              <span className="mk2-way-name">{w.name}</span>
              <span className="mk2-way-desc">
                {w.desc}
                <br />
                <span className="mk2-mono">{w.tag}</span>
              </span>
              <span className="mk2-way-arrow">
                <I.arrowPlain size={20} />
              </span>
            </a>
          ))}
        </div>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// STEPS — a real sequence, so the numbers mean something
// ─────────────────────────────────────────────────────────────────
function Steps() {
  return (
    <Group className="mk2-sec mk2-center mk2-tint-violet" id="how">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">How it works</span>
        <h2 className="mk2-h2 mk2-reveal" style={{ '--i': 1 }}>
          Stuck to fixed, in three moves.
        </h2>
        <div className="mk2-steps">
          {STEPS.map((s, i) => (
            <div key={s.num} className="mk2-step mk2-reveal" style={{ '--i': i + 2 }}>
              <span className="mk2-step-num">{s.num}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// SPOTLIGHT — real experts in production (BAL-493): featured_experts
// config + fallback, canonical ExpertCard, public serializer.
// These minimal cards are visual stand-ins.
// ─────────────────────────────────────────────────────────────────
function Spotlight() {
  return (
    <Group className="mk2-sec-tight mk2-center" id="experts">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">The bench</span>
        <h2 className="mk2-h2 mk2-reveal" style={{ '--i': 1 }}>
          A few of the top 1%.
        </h2>
        <div className="mk2-experts">
          {EXPERTS.map((e, i) => (
            <div key={e.id} className="mk2-xc mk2-reveal" style={{ '--i': i + 2 }}>
              <div className="mk2-xc-top">
                <span className="mk2-xc-av" style={{ background: avatarGradient(e.id) }}>
                  {initials(e.n)}
                  <span className="mk2-xc-avdot" />
                </span>
                <div>
                  <div className="mk2-xc-name">{e.n}</div>
                  <div className="mk2-xc-spec">{e.s}</div>
                </div>
              </div>
              <div className="mk2-xc-rate mk2-mono">
                A${e.r.toFixed(2)}/min<small>all-in</small>
              </div>
              <div className="mk2-xc-foot">
                <button type="button" className="mk2-xc-book">
                  <I.video size={14} />
                  Book a call
                </button>
                <a className="mk2-xc-profile" href="#top">
                  View profile
                </a>
              </div>
            </div>
          ))}
        </div>
        <a className="mk2-browse mk2-reveal" style={{ '--i': 5 }} href="#top">
          Browse all experts
          <I.arrowPlain size={16} />
        </a>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// PRICING — one sentence and a receipt
// ─────────────────────────────────────────────────────────────────
function Pricing() {
  return (
    <Group className="mk2-sec mk2-center" id="pricing">
      <div className="mk2-wrap">
        <span className="mk2-kicker mk2-reveal">Pricing</span>
        <h2 className="mk2-h2 mk2-reveal" style={{ '--i': 1 }}>
          One all-in rate.
        </h2>
        <p className="mk2-line mk2-reveal" style={{ '--i': 2 }}>
          The price on the card is the price on the receipt.
        </p>

        <div className="mk2-price-wrap mk2-reveal" style={{ '--i': 3 }}>
          <div className="mk2-price-glow" aria-hidden="true" />
          <div className="mk2-receipt" aria-label="Example session receipt">
            <div className="mk2-receipt-head">
              <span className="mk2-receipt-title">Consultation</span>
              <span className="mk2-receipt-tag">#BAL-20418</span>
            </div>
            <div className="mk2-receipt-row">
              <span>Flow debugging</span>
              <span className="mk2-mono">23 min</span>
            </div>
            <div className="mk2-receipt-row">
              <span>Rate</span>
              <span className="mk2-mono">A$2.40/min</span>
            </div>
            <div className="mk2-receipt-total">
              <span>Total</span>
              <span className="mk2-mono">A$55.20</span>
            </div>
            <div className="mk2-receipt-foot">
              <I.check size={12} />
              Service fee included
            </div>
          </div>
        </div>

        <p className="mk2-nos mk2-reveal" style={{ '--i': 4 }}>
          No retainers · No day rates · No minimums · No contracts
        </p>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// QUOTE — one voice, centred (placeholder until MJ sources real ones)
// ─────────────────────────────────────────────────────────────────
function Quote() {
  return (
    <Group className="mk2-sec-tight mk2-center mk2-tint-grad">
      <div className="mk2-wrap mk2-quote">
        <blockquote className="mk2-reveal">{QUOTE.text}</blockquote>
        <div className="mk2-quote-who mk2-reveal" style={{ '--i': 1 }}>
          <span className="mk2-quote-av" style={{ background: avatarGradient(QUOTE.name) }}>
            {initials(QUOTE.name)}
          </span>
          <div>
            <div className="mk2-quote-name">{QUOTE.name}</div>
            <div className="mk2-quote-role">{QUOTE.role}</div>
          </div>
        </div>
      </div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────
// EXPERT BAND — two lines, dark. No fee/margin language (invariant).
// ─────────────────────────────────────────────────────────────────
function Band() {
  return (
    <div className="mk2-band" id="for-experts">
      <div className="mk2-band-glow mk2-band-glow-a" aria-hidden="true" />
      <div className="mk2-band-glow mk2-band-glow-b" aria-hidden="true" />
      <Group className="mk2-sec mk2-center">
        <div className="mk2-wrap">
          <span className="mk2-kicker mk2-reveal">For experts</span>
          <h2 className="mk2-h2 mk2-reveal" style={{ '--i': 1 }}>
            Keep the craft.
            <br />
            Skip the chase.
          </h2>
          <p className="mk2-line mk2-reveal" style={{ '--i': 2 }}>
            Set your rate, share your hours, get paid for every minute.
          </p>
          <div className="mk2-band-ctas mk2-reveal" style={{ '--i': 3 }}>
            <a className="mk2-btn mk2-btn-lg mk2-btn-white" href="#top">
              Apply to join
              <I.arrow size={16} />
            </a>
            <a className="mk2-btn mk2-btn-lg mk2-btn-outline-light" href="#top">
              How experts get paid
            </a>
          </div>
        </div>
      </Group>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// FINAL — closing fragment pair + compact footer
// ─────────────────────────────────────────────────────────────────
function Final() {
  return (
    <Group className="mk2-sec mk2-center">
      <div className="mk2-wrap">
        <div className="mk2-final-card mk2-reveal">
          <h2 className="mk2-h2">
            Small questions welcome.
            <br />
            <em>Big problems too.</em>
          </h2>
          <div className="mk2-final-ctas">
            <a className="mk2-btn mk2-btn-lg mk2-btn-white" href="#experts">
              Find an expert
              <I.arrow size={16} />
            </a>
            <a className="mk2-btn mk2-btn-lg mk2-btn-outline-light" href="#for-experts">
              Apply as an expert
            </a>
          </div>
        </div>
      </div>
    </Group>
  );
}

function Footer() {
  return (
    <footer className="mk2-footer">
      <div className="mk2-wrap mk2-footer-inner">
        <a className="mk2-logo" href="#top" aria-label="Balo home">
          <span className="mk2-logo-mark" />
          Balo
        </a>
        <nav className="mk2-footer-links" aria-label="Footer">
          {FOOTER_LINKS.map(([l, h]) => (
            <a key={l} href={h}>
              {l}
            </a>
          ))}
        </nav>
        <span className="mk2-footer-legal">© 2026 Balo Technologies</span>
      </div>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────
// PAGE
// ─────────────────────────────────────────────────────────────────
export default function MarketingHomeV2() {
  const prefersReduced = usePrefersReduced();
  const [motion, setMotion] = useState('full');
  useEffect(() => {
    if (prefersReduced) setMotion('reduced');
  }, [prefersReduced]);
  const reduced = motion === 'reduced';

  return (
    <MotionCtx.Provider value={reduced}>
      <style>{CSS}</style>
      <ControlStrip motion={motion} setMotion={setMotion} prefersReduced={prefersReduced} />
      <div className={`mk2-page${reduced ? ' reduced' : ''}`}>
        <Nav />
        <main>
          <Hero />
          <Contrast />
          <Ways />
          <Steps />
          <Spotlight />
          <Pricing />
          <Quote />
          <Band />
          <Final />
        </main>
        <Footer />
      </div>
    </MotionCtx.Provider>
  );
}
