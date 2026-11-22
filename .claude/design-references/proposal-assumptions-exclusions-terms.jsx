import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * proposal-assumptions-exclusions-terms.jsx — typed Assumptions, Not included and Additional
 * terms on a proposal (design reference for BAL-661).
 * Suggested home: .claude/design-references/proposal-assumptions-exclusions-terms.jsx
 *
 * Companion to project-proposal-v2.jsx (composer), proposal-pdf.jsx and project-delivery.jsx.
 * Only what changes is drawn. Dashed "unchanged" blocks stand in for everything else, and the
 * dashed "Prototype state" bar and "Reference note" lines are reference-only.
 *
 * WHAT CHANGES
 *   Composer            Three optional list sections. Assumptions and Not included sit after
 *                       Milestones (scope, then its boundaries, then the price). Additional terms
 *                       sits after pricing. The Terms chip leaves the property bar.
 *   Client proposal     "Assumptions and exclusions" after Milestones, in the section nav. Terms
 *                       shows Balo's block, then the expert's additional terms as a numbered list.
 *                       Attachments open the file.
 *   Request changes     Two new "What needs work?" options: Assumptions and exclusions, Terms.
 *   Accept              The dialog shows what is being agreed to: Balo's Project T&Cs, the rule for
 *                       the pricing method, and the expert's additional terms in full.
 *   Delivery workspace  "Agreed in the proposal": the three lists, read-only, for client, expert
 *                       and admin alike (no money on it, so one rendering serves all three).
 *   PDF and shared view Same sections, same order, same numbering as the client proposal. Not drawn.
 *
 * FIELD MAP (as scoped in BAL-661; none of it exists yet)
 *   Assumptions / Not included / Additional terms
 *       → proposal_clauses: proposal_id, kind ('assumption' | 'exclusion' | 'additional_term'),
 *         sort_order, body (plain text). Replace-all per proposal version, like proposal_milestones.
 *         Replaces proposals.exclusions (free text) and the 'terms' upload on proposal_documents.
 *   Change-request section
 *       → proposal_change_section gains 'assumptions_exclusions' and 'terms'.
 *   Delivery workspace
 *       → engagement_clauses, copied from the accepted proposal at kickoff alongside
 *         engagement_milestones.
 *   Balo's block
 *       → proposal-standard-terms.ts: two of the existing summary lines, plus one rule per
 *         pricing method. The terms themselves are the "Balo Projects - Master Services Agreement".
 *
 * DECISIONS BAKED IN
 *   1. Items are plain text, one point each: up to 20 per list, 500 characters per item. Blank
 *      rows are never saved.
 *   2. Each list ends in an empty row. Typing there and pressing Enter adds the item and moves to
 *      the next (the hint beside the heading shows while the section has focus). Backspace on an empty item removes it. Pasting several lines makes one item per
 *      line and strips leading bullets and numbers. Drag the handle, or focus it and use the arrow
 *      keys, to reorder. Removing an item with text offers Undo.
 *   3. All three lists are optional and never block sending. With no assumptions and no exclusions
 *      the checklist shows one soft line, as it does for other optional gaps.
 *   4. The rule for the pricing method ("Any increase in cost is only charged if {company} approves
 *      it") is Balo's, not the expert's. It sits in Balo's block, locked, and switches with the
 *      pricing method. Additional terms holds only what the expert typed.
 *   5. There is no terms upload. Reference documents still attach under Attachments.
 *   6. The client answers the whole proposal: accept it, or request changes and point at a section.
 *      There is no per-item agree or disagree.
 *   7. In revise mode the client's note pins above Assumptions for 'assumptions_exclusions' and
 *      above Additional terms for 'terms'.
 *   8. The delivery card shows what was agreed in the proposal. Change orders do not edit it.
 *      It starts collapsed, and does not render when the proposal had none of the three lists.
 *   9. Fee concealment: the composer shows the expert's figures and the client views show the
 *      client's. No view shows both.
 *  10. A list item is free text the client reads as typed. When one contains a rate or price, a
 *      non-blocking warning under it says the client would see that amount without Balo's margin
 *      and points to the pricing section. Type "A$165/hr" into any item to see it.
 *
 * NOT BUILT IN BAL-661
 *   The "Read the Project T&Cs" link. Balo 2.0 has no Project T&Cs page yet, so Balo's block
 *   renders without the link until that follow-up lands.
 *   The sentence "Where one conflicts with Balo's Project T&Cs, Balo's apply". The agreement
 *   contradicts itself on precedence today (clause 2.2 against clause 5.7), so the sentence stays
 *   off until MJ settles it; until then the lines end at "These add to Balo's Project T&Cs."
 *
 * COPY is draft and needs MJ's sign-off. The two pricing-method rules are ported from the Bubble
 * app's locked default term.
 */

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
.pt, .pt *, .pt *::before, .pt *::after { box-sizing: border-box; }
.pt {
  --ink:#0F172A; --ink2:#334155; --muted:#64748B; --faint:#94A3B8;
  --line:#E2E8F0; --line2:#CBD5E1; --soft:#F8FAFC; --soft2:#F1F5F9;
  --blue:#2563EB; --blue-soft:#EFF4FF; --blue-line:#C7D7FE;
  --warn:#B45309; --warn-bg:#FFF7E8; --warn-line:#F8D9A6;
  --ok:#15803D; --ok-bg:#EFFAF2; --ok-line:#BFE3CB;
  --danger:#DC2626;
  --grad:linear-gradient(90deg,#4F7CF0 0%,#9A6BF2 100%);
  font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
  color:var(--ink); background:#fff; min-height:100vh; font-size:15px; line-height:1.55;
  -webkit-font-smoothing:antialiased;
  --proto-h:0px; /* height of the reference-only state bar, measured at runtime */
}
:where(.pt button, .pt input, .pt textarea, .pt select) { font-family:inherit; color:inherit; }
.pt :focus-visible { outline:2px solid var(--blue); outline-offset:2px; }

.proto { position:sticky; top:0; z-index:60; display:flex; align-items:center; gap:6px 8px; flex-wrap:wrap; padding:8px 24px; font-size:12.5px; color:var(--muted); background:var(--soft); border-bottom:1px dashed var(--line2); }
.proto button { border:1px solid var(--line); background:#fff; border-radius:999px; padding:3px 10px; font-size:12.5px; color:var(--ink2); cursor:pointer; }
.proto button.on { border-color:var(--ink); color:var(--ink); font-weight:500; }
.proto .gap { width:1px; height:16px; background:var(--line2); margin:0 6px; }
.anno { margin:10px 0 0; padding:7px 11px; border:1px dashed var(--line2); border-radius:9px; background:var(--soft); font-size:12.5px; color:var(--muted); }
.anno b { font-weight:600; color:var(--ink2); }
.ph { display:flex; align-items:baseline; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:28px; padding:14px 16px; border:1px dashed var(--line2); border-radius:14px; color:var(--faint); font-size:13.5px; }
.ph strong { font-size:15px; font-weight:600; color:var(--muted); }

.top { position:sticky; top:var(--proto-h); z-index:20; height:56px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 24px; background:rgba(255,255,255,.94); backdrop-filter:saturate(1.4) blur(8px); border-bottom:1px solid var(--line); }
.crumbs { display:flex; align-items:center; gap:8px; font-size:14px; color:var(--muted); min-width:0; white-space:nowrap; overflow:hidden; }
.crumbs b { color:var(--ink); font-weight:500; overflow:hidden; text-overflow:ellipsis; }
.crumbs .sep { color:var(--line2); }
.save { display:flex; align-items:center; gap:7px; font-size:13px; color:var(--muted); white-space:nowrap; }
.dot { width:6px; height:6px; border-radius:50%; background:var(--faint); }

.layout { max-width:1160px; margin:0 auto; padding:36px 24px 120px; display:grid; grid-template-columns:minmax(0,1fr) 300px; gap:56px; }
.layout.solo { grid-template-columns:minmax(0,1fr); }
.layout.solo .main { max-width:780px; margin:0 auto; width:100%; }
.main { min-width:0; max-width:720px; }
.rail { position:sticky; top:calc(var(--proto-h) + 80px); align-self:start; }

.for { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--muted); margin-bottom:6px; }
.for strong { color:var(--ink2); font-weight:500; }
.vchip { font-size:12px; font-weight:500; color:var(--blue); background:var(--blue-soft); border-radius:999px; padding:2px 9px; }
.title { font-size:30px; line-height:1.2; font-weight:600; letter-spacing:-0.02em; margin:0 0 16px; }
.props { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.chip { display:inline-flex; align-items:center; gap:7px; height:34px; padding:0 12px; border:1px solid var(--line); border-radius:9px; background:#fff; font-size:14px; color:var(--ink2); }
.chip svg { color:var(--muted); }
.chip.gone { border-style:dashed; color:var(--faint); text-decoration:line-through; }

.cr-summary { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:10px 14px; border-radius:12px; background:var(--blue-soft); color:var(--ink2); font-size:14px; margin-top:20px; }
.cr { display:grid; grid-template-columns:32px minmax(0,1fr); gap:12px; padding:14px 16px; border:1px solid var(--blue-line); background:var(--blue-soft); border-radius:14px; margin-bottom:18px; }
.cr.done { background:#fff; border-color:var(--line); }
.avatar { width:32px; height:32px; border-radius:50%; display:grid; place-items:center; background:#fff; border:1px solid var(--blue-line); font-size:12px; font-weight:600; color:var(--blue); flex-shrink:0; }
.cr-head { font-size:14px; color:var(--ink2); }
.cr-head strong { font-weight:600; color:var(--ink); }
.cr-quote { margin:6px 0 8px; font-size:14.5px; color:var(--ink); }
.cr-ok { display:inline-flex; align-items:center; gap:6px; color:var(--ok); font-size:13.5px; margin:4px 12px 0 0; }
.linkbtn { background:none; border:0; padding:0; color:var(--blue); font-size:13.5px; font-weight:500; cursor:pointer; white-space:nowrap; text-decoration:none; display:inline-flex; align-items:center; gap:5px; }
.linkbtn:hover { text-decoration:underline; }

.section { margin-top:44px; scroll-margin-top:calc(var(--proto-h) + 84px); }
.sh { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.sh h2 { font-size:18px; font-weight:600; letter-spacing:-0.01em; margin:0; display:flex; align-items:baseline; gap:8px; }
.sh h2 small { font-size:13px; font-weight:400; color:var(--faint); }
.help { margin:4px 0 14px; font-size:14px; color:var(--muted); }

/* ── Clause list editor ── */
.ce-wrap { border-radius:14px; }
.ce-list { border:1px solid var(--line); border-radius:14px; overflow:hidden; background:#fff; }
.ce-row { display:grid; grid-template-columns:18px 24px minmax(0,1fr) 30px; align-items:start; gap:6px; padding:6px 10px 6px 8px; border-bottom:1px solid var(--line); background:#fff; }
.ce-row:last-child { border-bottom:0; }
.ce-row.dragging { opacity:.45; }
.ce-grip { height:34px; width:18px; display:grid; place-items:center; border:0; background:none; padding:0; border-radius:6px; color:var(--line2); cursor:grab; }
.ce-row:hover .ce-grip, .ce-grip:focus-visible { color:var(--faint); }
.ce-num { height:34px; display:grid; place-items:center; font-size:13px; color:var(--faint); font-variant-numeric:tabular-nums; }
.ce-num svg { color:var(--faint); }
.ce-ta { display:block; width:100%; resize:none; overflow:hidden; border:0; background:transparent; border-radius:8px; padding:6px 8px; font-size:15px; line-height:1.5; min-height:34px; }
.ce-ta:hover { background:var(--soft); }
.ce-ta:focus { outline:none; background:var(--soft); box-shadow:inset 0 0 0 1px var(--blue-line); }
.ce-ta::placeholder { color:var(--faint); }
.ce-count { display:block; text-align:right; font-size:12px; color:var(--faint); padding:0 8px 2px; font-variant-numeric:tabular-nums; }
.ce-count.max { color:var(--warn); }
.icon-btn { width:30px; height:34px; display:grid; place-items:center; border:0; background:none; border-radius:8px; color:var(--faint); cursor:pointer; }
.icon-btn:hover { background:var(--soft2); color:var(--ink2); }
.icon-btn.del { opacity:0; }
.ce-row:hover .icon-btn.del, .icon-btn.del:focus-visible { opacity:1; }
.icon-btn.del:hover { color:var(--danger); }
.ce-hint { font-size:12.5px; color:var(--faint); visibility:hidden; }
.section:focus-within .ce-hint { visibility:visible; }
.ce-warn { display:flex; gap:6px; align-items:flex-start; margin:0 8px 6px; font-size:12.5px; line-height:1.45; color:var(--warn); }
.ce-warn svg { margin-top:2px; flex-shrink:0; }
.ce-full { padding:10px 14px; font-size:13.5px; color:var(--muted); background:var(--soft); }

/* ── Balo's block ── */
.balo { display:grid; grid-template-columns:30px minmax(0,1fr); gap:12px; padding:12px 14px; border:1px solid var(--line); border-radius:14px; background:var(--soft); }
.balo-ic { width:30px; height:30px; border-radius:9px; display:grid; place-items:center; background:#fff; border:1px solid var(--line); color:var(--muted); }
.balo-top { display:flex; align-items:baseline; justify-content:space-between; gap:8px 12px; flex-wrap:wrap; }
.balo-top b { font-size:14px; font-weight:600; }
.balo p { margin:2px 0 0; font-size:13.5px; color:var(--muted); }
.balo p.rule { color:var(--ink2); margin-top:6px; }
.balo ul { margin:8px 0 0; padding-left:18px; font-size:13px; color:var(--muted); display:grid; gap:4px; }
.gap12 { margin-top:12px; }
.foot-note { margin:10px 4px 0; font-size:13px; color:var(--muted); }

/* ── Rail ── */
.card { border:1px solid var(--line); border-radius:18px; padding:20px; background:#fff; }
.r-label { font-size:13px; color:var(--muted); }
.r-total { font-size:30px; font-weight:600; letter-spacing:-0.02em; font-variant-numeric:tabular-nums; margin:2px 0 4px; line-height:1.15; }
.r-total small { font-size:15px; font-weight:500; color:var(--muted); letter-spacing:0; }
.r-sub { font-size:13px; color:var(--muted); margin:0 0 4px; }
.r-dl { display:grid; gap:9px; padding:16px 0; border-top:1px solid var(--line); margin:14px 0 0; }
.r-dl div { display:flex; justify-content:space-between; gap:12px; font-size:14px; }
.r-dl dt { color:var(--muted); }
.r-dl dd { margin:0; text-align:right; font-weight:500; }
.cl { border-top:1px solid var(--line); padding-top:14px; margin-bottom:16px; }
.cl-head { display:flex; align-items:center; gap:7px; font-size:14px; font-weight:600; margin-bottom:6px; }
.cl-head.ok { color:var(--ok); }
.cl-item { display:flex; align-items:center; justify-content:space-between; gap:8px; text-align:left; background:none; border:0; border-radius:8px; padding:7px 8px; margin:0 -8px; width:calc(100% + 16px); font-size:14px; color:var(--muted); cursor:pointer; }
.cl-item:hover { background:var(--soft2); }
.cl-item svg { color:var(--faint); flex-shrink:0; }
.cta { width:100%; height:48px; border:0; border-radius:12px; background:var(--grad); color:#fff !important; font-size:15px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; gap:8px; transition:filter .15s, transform .1s; }
.cta:hover { filter:brightness(1.06); }
.cta:active { transform:scale(.99); }
.cta:disabled { filter:grayscale(.5) opacity(.55); cursor:not-allowed; }
.cta-sm { width:auto; height:40px; padding:0 18px; font-size:14px; border-radius:10px; }
.btn { display:inline-flex; align-items:center; justify-content:center; gap:7px; height:40px; padding:0 16px; border:1px solid var(--line); border-radius:10px; background:#fff; font-size:14px; font-weight:500; color:var(--ink); cursor:pointer; }
.btn:hover { background:var(--soft); }
.btn.wide { width:100%; height:44px; margin-top:8px; }
.ghost { display:inline-flex; align-items:center; gap:6px; height:40px; padding:0 14px; border:0; background:none; border-radius:10px; color:var(--ink2); font-size:14px; font-weight:500; cursor:pointer; }
.ghost:hover { background:var(--soft2); }

/* ── Client proposal ── */
.nav { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:20px; }
.nav button { height:30px; padding:0 12px; border:1px solid var(--line); border-radius:999px; background:#fff; font-size:13.5px; color:var(--ink2); cursor:pointer; }
.nav button:hover { border-color:var(--line2); }
.doc { border:1px solid var(--line); border-radius:18px; padding:40px 48px; }
.doc-from { display:flex; align-items:center; gap:10px; font-size:14px; color:var(--muted); margin-bottom:14px; }
.doc h1 { font-size:30px; font-weight:600; letter-spacing:-0.02em; margin:0 0 20px; line-height:1.2; }
.doc-facts { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:16px; padding:16px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); margin:0; }
.doc-facts dt { font-size:12.5px; color:var(--muted); }
.doc-facts dd { margin:2px 0 0; font-weight:500; font-variant-numeric:tabular-nums; }
.doc section { margin-top:32px; scroll-margin-top:calc(var(--proto-h) + 84px); }
.doc h2 { font-size:17px; font-weight:600; margin:0 0 10px; }
.doc h3 { font-size:14.5px; font-weight:600; margin:18px 0 2px; }
.doc h3:first-of-type { margin-top:0; }
.lead { margin:0 0 8px; font-size:13.5px; color:var(--muted); }
.nl { list-style:none; margin:0; padding:0; counter-reset:n; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
.nl li { counter-increment:n; display:grid; grid-template-columns:22px minmax(0,1fr); gap:8px; padding:10px 14px; border-bottom:1px solid var(--line); font-size:14.5px; color:var(--ink2); overflow-wrap:anywhere; }
.nl li:last-child { border-bottom:0; }
.nl li::before { content:counter(n); color:var(--faint); font-size:13px; font-variant-numeric:tabular-nums; padding-top:1px; }
.nl.tight li { padding:8px 12px; font-size:13.5px; }
.att { display:grid; gap:8px; }
.att button { display:grid; grid-template-columns:20px minmax(0,1fr) 18px; align-items:center; gap:10px; width:100%; text-align:left; padding:10px 12px; border:1px solid var(--line); border-radius:12px; background:#fff; cursor:pointer; }
.att button:hover { background:var(--soft); border-color:var(--line2); }
.att svg { color:var(--muted); }
.att b { display:block; font-size:14px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.att small { font-size:12.5px; color:var(--faint); }

/* ── Dialogs ── */
.scrim { position:fixed; inset:var(--proto-h) 0 0 0; z-index:50; background:rgba(15,23,42,.45); display:flex; padding:24px 16px; overflow:auto; }
.modal { width:100%; max-width:480px; margin:auto; display:flex; flex-direction:column; max-height:calc(100vh - var(--proto-h) - 48px); background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 24px 60px rgba(15,23,42,.25); }
.modal:focus { outline:none; }
.m-head { flex-shrink:0; display:flex; align-items:center; gap:12px; padding:22px 24px; border-bottom:1px solid var(--line); background:linear-gradient(135deg,rgba(37,99,235,.07),rgba(37,99,235,.02)); }
.m-head.warn { background:linear-gradient(135deg,rgba(180,83,9,.10),rgba(180,83,9,.03)); }
.m-ic { width:40px; height:40px; border-radius:12px; display:grid; place-items:center; background:rgba(37,99,235,.10); color:var(--blue); font-size:14px; font-weight:600; flex-shrink:0; }
.m-head.warn .m-ic { background:rgba(180,83,9,.15); color:var(--warn); }
.m-head h2 { margin:0; font-size:16px; font-weight:600; }
.m-head p { margin:2px 0 0; font-size:12.5px; color:var(--muted); }
.m-body { padding:22px 24px; overflow:auto; }
.m-body > * + * { margin-top:16px; }
.m-foot { flex-shrink:0; display:flex; justify-content:flex-end; gap:8px; padding:16px 24px 22px; border-top:1px solid var(--line); }
.fl { display:block; font-size:13.5px; font-weight:500; margin-bottom:6px; }
.sel, .ta { display:block; width:100%; border:1px solid var(--line); border-radius:10px; background:#fff; font-size:14.5px; }
.sel { height:40px; padding:0 10px; }
.ta { resize:vertical; min-height:96px; padding:10px 12px; line-height:1.6; }
.sel:focus, .ta:focus { outline:none; border-color:var(--blue); box-shadow:0 0 0 3px rgba(37,99,235,.12); }
.ta::placeholder { color:var(--faint); }
.fh { font-size:12.5px; color:var(--muted); margin-top:6px; }
.money { margin:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; }
.money div { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:10px 14px; border-bottom:1px solid var(--line); font-size:14px; }
.money div:last-child { border-bottom:0; }
.money dt { color:var(--muted); }
.money dd { margin:0; font-weight:600; font-variant-numeric:tabular-nums; }
.money dd span { margin-left:6px; font-size:12px; font-weight:400; color:var(--muted); }
.agree h3 { margin:0 0 8px; font-size:13.5px; font-weight:600; }
.agree-part { margin:10px 0 6px; font-size:13.5px; font-weight:500; display:flex; align-items:baseline; justify-content:space-between; gap:8px; }
.agree-also { margin:10px 0 0; font-size:13px; color:var(--muted); }
.ack { display:flex; align-items:flex-start; gap:10px; padding:14px; border-radius:12px; background:var(--soft); font-size:12.5px; line-height:1.6; color:var(--muted); cursor:pointer; }
.ack input { margin:2px 0 0; width:16px; height:16px; accent-color:var(--blue); flex-shrink:0; }
.ack strong { color:var(--ink); font-weight:600; }

/* ── Delivery card ── */
.agreed { border:1px solid var(--line); border-radius:16px; background:#fff; margin-top:16px; }
.agreed-head { display:grid; grid-template-columns:30px minmax(0,1fr) 18px; align-items:center; gap:12px; width:100%; text-align:left; padding:14px 16px; border:0; background:none; border-radius:16px; cursor:pointer; }
.agreed-head:hover { background:var(--soft); }
.agreed-head b { display:block; font-size:15px; font-weight:600; }
.agreed-head span.sum { display:block; font-size:13px; color:var(--muted); }
.agreed-head > svg { color:var(--faint); transition:transform .15s; }
.agreed-head[aria-expanded="true"] > svg { transform:rotate(180deg); }
.agreed-body { padding:4px 16px 18px; border-top:1px solid var(--line); }
.agreed-body h3 { font-size:13.5px; font-weight:600; margin:16px 0 6px; }
.agreed-meta { margin:14px 0 0; font-size:13px; color:var(--muted); }
.note { display:flex; gap:8px; align-items:flex-start; margin-top:14px; padding:10px 12px; border-radius:10px; background:var(--blue-soft); font-size:13px; color:var(--ink2); }
.note svg { color:var(--blue); margin-top:2px; flex-shrink:0; }

.flash { animation:flash 1.4s ease-out; }
@keyframes flash { 0%,35% { box-shadow:0 0 0 3px var(--warn-line) } 100% { box-shadow:0 0 0 0 transparent } }
.toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%); z-index:70; display:flex; align-items:center; gap:14px; max-width:calc(100% - 32px); padding:11px 14px 11px 16px; border-radius:12px; background:var(--ink); color:#fff; font-size:14px; box-shadow:0 12px 32px rgba(15,23,42,.24); }
.toast button { background:none; border:0; color:#A9C1FF; font-weight:600; font-size:14px; cursor:pointer; padding:0; white-space:nowrap; }

@media (max-width:1020px) {
  .layout { grid-template-columns:minmax(0,1fr); gap:28px; }
  .rail { position:static; }
  .main { max-width:none; }
}
@media (max-width:640px) {
  .proto, .top { padding-left:16px; padding-right:16px; }
  .layout { padding:24px 16px 96px; }
  .title, .doc h1 { font-size:24px; }
  .doc { padding:26px 18px; }
  .doc-facts { grid-template-columns:minmax(0,1fr); }
  .ce-row { grid-template-columns:18px minmax(0,1fr) 30px; }
  .ce-num { display:none; }
  .icon-btn.del { opacity:1; }
  .ce-hint { display:none; }
  .m-head, .m-body { padding-left:18px; padding-right:18px; }
  .m-foot { padding:14px 18px 18px; }
  .crumbs .hide-sm { display:none; }
}
@media (prefers-reduced-motion: reduce) {
  .flash { animation:none !important; }
  .agreed-head > svg, .cta { transition:none; }
}
`;

// ── Icons (inline, stroke = currentColor) ─────────────────────────────────

const Svg = ({ size = 16, children, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    {children}
  </svg>
);

const Icon = {
  Lock: (p) => (
    <Svg {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  ),
  Plus: (p) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  Trash: (p) => (
    <Svg {...p}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </Svg>
  ),
  ChevronDown: (p) => (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  ),
  ChevronRight: (p) => (
    <Svg {...p}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  ),
  Check: (p) => (
    <Svg {...p}>
      <path d="m5 12 5 5 9-10" />
    </Svg>
  ),
  CheckCircle: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Svg>
  ),
  External: (p) => (
    <Svg {...p}>
      <path d="M14 5h5v5M19 5l-8 8M11 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-5" />
    </Svg>
  ),
  Download: (p) => (
    <Svg {...p}>
      <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />
    </Svg>
  ),
  File: (p) => (
    <Svg {...p}>
      <path d="M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7z" />
      <path d="M14 3v4h4" />
    </Svg>
  ),
  Rotate: (p) => (
    <Svg {...p}>
      <path d="M4 5v5h5" />
      <path d="M4.5 10A8 8 0 1 1 6 16.5" />
    </Svg>
  ),
  Info: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 7.5v.5" />
    </Svg>
  ),
  Clock: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  ),
  Tag: (p) => (
    <Svg {...p}>
      <path d="M3 12V4h8l10 10-8 8z" />
      <circle cx="7.5" cy="8.5" r="1" />
    </Svg>
  ),
  Scroll: (p) => (
    <Svg {...p}>
      <path d="M7 4h11a1 1 0 0 1 1 1v15H8a2 2 0 0 1-2-2V5a1 1 0 0 0-2 0v2h2" />
      <path d="M10 9h6M10 13h6" />
    </Svg>
  ),
};

const Grip = () => (
  <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
    {[3, 8, 13].map((y) =>
      [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" fill="currentColor" />)
    )}
  </svg>
);

// ── Fixture content (the same request as project-proposal-v2.jsx) ─────────

const REQUEST = { title: 'Salesforce CPQ rollout', company: 'Acme Industrial' };
const CLIENT = { name: 'Frank Lee', first: 'Frank', initials: 'FL' };
const EXPERT = { name: 'Priya Nair', first: 'Priya', initials: 'PN' };
const FEE_BPS = 2500;
const withFee = (cents) => Math.round((cents * (10000 + FEE_BPS)) / 10000);

/** Expert-side figures. Client views run every one of them through withFee. */
const MONEY = {
  fixedPriceCents: 1500000,
  upfrontPct: 30,
  tmEstimateCents: 1584000, // 96 h × A$165
  tmRateCents: 16500,
  tmDepositCents: 300000,
  hours: 96,
};

const aud = (cents) =>
  `A$${Math.round(cents / 100).toLocaleString('en-AU', { maximumFractionDigits: 0 })}`;

const MAX_ITEMS = 20;
const MAX_CHARS = 500;

const KIND = {
  assumption: {
    one: 'assumption',
    many: 'assumptions',
    add: 'Add an assumption',
    example: `For example: ${REQUEST.company} gives us sandbox access by kickoff`,
    removed: 'Assumption removed',
  },
  exclusion: {
    one: 'exclusion',
    many: 'exclusions',
    add: 'Add an exclusion',
    example: 'For example: Migrating historical quotes from your spreadsheets',
    removed: 'Exclusion removed',
  },
  term: {
    one: 'term',
    many: 'terms',
    add: 'Add a term',
    example: 'For example: One round of revisions is included per milestone',
    removed: 'Term removed',
  },
};

let uid = 0;
const nextId = () => {
  uid += 1;
  return `c${uid}`;
};
const seed = (lines) => lines.map((text) => ({ id: nextId(), text }));

const filledLists = () => ({
  assumption: seed([
    `${REQUEST.company} gives us admin access to a full-copy sandbox by kickoff.`,
    'Your product catalogue and price list are final before the build milestone starts.',
    `One person at ${REQUEST.company} can sign off decisions within two working days.`,
  ]),
  exclusion: seed([
    'Migrating historical quotes from your spreadsheets.',
    'Integrating CPQ with your ERP or billing system.',
  ]),
  term: seed([
    'One round of revisions is included per milestone. Further rounds are quoted as a change.',
    'Work is delivered remotely, Monday to Friday, Australian Eastern time.',
  ]),
});
const emptyLists = () => ({ assumption: [], exclusion: [], term: [] });

/**
 * Two of the four summary lines in proposal-standard-terms.ts today. The other two (payment "held
 * and released", disputes "through Balo support") are not supported by the agreement and go.
 */
const STANDARD_TERMS = [
  'Work is delivered against the milestones and scope set out in this proposal.',
  'Confidential information shared during the engagement stays confidential.',
];

/** Balo's rule for the pricing method. Ported from the Bubble app's locked default term. */
const pricingRule = (pricing) =>
  pricing === 'fixed'
    ? `This is a fixed-price project. Any increase in cost is only charged if ${REQUEST.company} approves it.`
    : `This is a time and materials project. ${REQUEST.company} is billed for the hours logged each billing period. If a milestone goes over its estimate, ${REQUEST.company} is told, and raising an estimate needs ${REQUEST.company}'s approval.`;

const CHANGE_SECTIONS = [
  { value: 'general', label: 'General' },
  { value: 'milestones', label: 'Milestones / deliverables' },
  { value: 'assumptions_exclusions', label: 'Assumptions and exclusions', isNew: true },
  { value: 'pricing', label: 'Pricing' },
  { value: 'payment_terms', label: 'Payment terms' },
  { value: 'timeline', label: 'Timeline' },
  { value: 'terms', label: 'Terms', isNew: true },
];

/** "asked for a change to {phrase}" and the checklist noun, for the two new sections. */
const SECTION_COPY = {
  assumptions_exclusions: {
    phrase: 'the assumptions and exclusions',
    noun: 'assumptions and exclusions',
    note: 'Assumption 2: our price list won’t be final until mid-December. Can the build start from the current list?',
  },
  terms: {
    phrase: 'the terms',
    noun: 'terms',
    note: 'Term 1: we’d like two rounds of revisions on the quote templates.',
  },
};

/** A rate or price typed into a list item. The client would see it without Balo's margin. */
const AMOUNT_RE =
  /[$€£]\s?\d|\b\d[\d,.]*\s?(?:aud|usd|nzd|eur|gbp|dollars?)\b|\/\s?h(?:ou)?r\b|\bper (?:hour|day)\b/i;

const LIST_HINT = 'Enter adds the next. Paste a list to add one per line.';

const plural = (n, one, many) => (n === 1 ? one : many);
const countOf = (n, kind) => `${n} ${plural(n, KIND[kind].one, KIND[kind].many)}`;
const clean = (s) => s.replace(/\s*\n+\s*/g, ' ').trim();
const stripBullet = (s) => clean(s.replace(/^\s*(?:[-•*–—]|\d+[.)])\s+/, ''));

function jumpTo(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduced =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  el.classList.remove('flash');
  el.getBoundingClientRect();
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1400);
}

// ── Shared pieces ─────────────────────────────────────────────────────────

function Unchanged({ title, note = 'Unchanged, not drawn.' }) {
  return (
    <div className="ph">
      <strong>{title}</strong>
      <span>{note}</span>
    </div>
  );
}

function Anno({ children }) {
  return (
    <p className="anno">
      <b>Reference note.</b> {children}
    </p>
  );
}

function AutoTextarea({ value, onChange, taRef, ...rest }) {
  const inner = useRef(null);
  useEffect(() => {
    const fit = () => {
      const el = inner.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [value]);
  return (
    <textarea
      ref={(el) => {
        inner.current = el;
        if (taRef) taRef(el);
      }}
      rows={1}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    />
  );
}

/**
 * Balo's block. `where` picks the framing: the composer talks to the expert, the proposal and the
 * accept dialog talk to the client. The summary lines only show on the client proposal, where the
 * existing "Balo standard terms apply" collapsible already shows them.
 */
function BaloTerms({ pricing, where }) {
  const [open, setOpen] = useState(false);
  const sub =
    where === 'composer'
      ? 'They cover every project on Balo and can’t be changed for one project.'
      : 'The same terms for every project on Balo.';
  return (
    <div className="balo">
      <span className="balo-ic">
        <Icon.Lock size={14} />
      </span>
      <div>
        <div className="balo-top">
          <b>{where === 'accept' ? 'Balo Project T&Cs' : 'Balo Project T&Cs apply'}</b>
          <a className="linkbtn" href="#project-terms" onClick={(e) => e.preventDefault()}>
            Read the Project T&Cs <Icon.External size={13} />
          </a>
        </div>
        {where !== 'accept' && <p>{sub}</p>}
        <p className="rule">{pricingRule(pricing)}</p>
        {where === 'proposal' && (
          <>
            <button
              type="button"
              className="linkbtn gap12"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Hide summary' : 'In short'}
            </button>
            {open && (
              <ul>
                {STANDARD_TERMS.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Clause list editor ────────────────────────────────────────────────────

function ClauseEditor({ kind, items, onChange, onToast, priceSection }) {
  const cfg = KIND[kind];
  const [ghost, setGhost] = useState('');
  const [armed, setArmed] = useState(null);
  const [dragId, setDragId] = useState(null);
  const taRefs = useRef({});
  const gripRefs = useRef({});
  const ghostRef = useRef(null);
  const focusNext = useRef(null);
  const full = items.length >= MAX_ITEMS;

  useEffect(() => {
    const want = focusNext.current;
    if (!want) return;
    focusNext.current = null;
    if (want.type === 'grip') {
      gripRefs.current[want.id]?.focus();
      return;
    }
    const el = want.type === 'ghost' ? ghostRef.current : taRefs.current[want.id];
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });

  const setText = (id, text) =>
    onChange(
      items.map((it) =>
        it.id === id ? { ...it, text: text.replace(/\n+/g, ' ').slice(0, MAX_CHARS) } : it
      )
    );

  const commitGhost = (keepFocus) => {
    const text = clean(ghost).slice(0, MAX_CHARS);
    if (!text) return;
    onChange([...items, { id: nextId(), text }]);
    setGhost('');
    if (keepFocus) focusNext.current = { type: 'ghost' };
  };

  const insertAfter = (id) => {
    if (full) return;
    const at = items.findIndex((it) => it.id === id);
    const fresh = { id: nextId(), text: '' };
    onChange([...items.slice(0, at + 1), fresh, ...items.slice(at + 1)]);
    focusNext.current = { type: 'item', id: fresh.id };
  };

  const remove = (id, { refocus = true, undo = true } = {}) => {
    const at = items.findIndex((it) => it.id === id);
    if (at < 0) return;
    const before = items;
    const after = items.filter((it) => it.id !== id);
    onChange(after);
    if (refocus) {
      const prev = after[at - 1] || after[0];
      focusNext.current = prev ? { type: 'item', id: prev.id } : { type: 'ghost' };
    }
    if (undo && items[at].text.trim()) onToast(cfg.removed, () => onChange(before));
  };

  const move = (id, dir) => {
    const at = items.findIndex((it) => it.id === id);
    const to = at + dir;
    if (at < 0 || to < 0 || to >= items.length) return;
    const next = items.slice();
    [next[at], next[to]] = [next[to], next[at]];
    onChange(next);
    focusNext.current = { type: 'grip', id };
  };

  const onPaste = (e, id) => {
    const lines = e.clipboardData.getData('text').split(/\r?\n/).map(stripBullet).filter(Boolean);
    if (lines.length < 2) return;
    e.preventDefault();
    const room = MAX_ITEMS - items.length;
    const added = lines.slice(0, room).map((t) => ({ id: nextId(), text: t.slice(0, MAX_CHARS) }));
    if (id === null) {
      onChange([...items, ...added]);
      setGhost('');
    } else {
      const at = items.findIndex((it) => it.id === id);
      onChange([...items.slice(0, at + 1), ...added, ...items.slice(at + 1)]);
    }
    if (lines.length > room) {
      onToast(`Added ${added.length} of ${lines.length}. A list holds up to ${MAX_ITEMS}.`);
    }
  };

  const onDragOverRow = (e, overId) => {
    if (!dragId) return;
    e.preventDefault();
    if (dragId === overId) return;
    const from = items.findIndex((it) => it.id === dragId);
    const to = items.findIndex((it) => it.id === overId);
    if (from < 0 || to < 0) return;
    const next = items.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    onChange(next);
  };

  return (
    <div className="ce-wrap">
      <div className="ce-list">
        {items.map((it, i) => {
          const near = it.text.length >= MAX_CHARS - 80;
          return (
            <div
              key={it.id}
              className={`ce-row ${dragId === it.id ? 'dragging' : ''}`}
              draggable={armed === it.id}
              onDragStart={(e) => {
                setDragId(it.id);
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', it.id);
              }}
              onDragOver={(e) => onDragOverRow(e, it.id)}
              onDragEnd={() => {
                setDragId(null);
                setArmed(null);
              }}
            >
              <button
                type="button"
                className="ce-grip"
                ref={(el) => {
                  gripRefs.current[it.id] = el;
                }}
                aria-label={`Reorder ${cfg.one} ${i + 1}. Use the up and down arrow keys.`}
                onMouseDown={() => setArmed(it.id)}
                onMouseUp={() => setArmed(null)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    move(it.id, -1);
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    move(it.id, 1);
                  }
                }}
              >
                <Grip />
              </button>
              <span className="ce-num">{i + 1}</span>
              <div>
                <AutoTextarea
                  className="ce-ta"
                  value={it.text}
                  taRef={(el) => {
                    taRefs.current[it.id] = el;
                  }}
                  aria-label={`${cfg.one} ${i + 1}`}
                  maxLength={MAX_CHARS}
                  onChange={(v) => setText(it.id, v)}
                  onPaste={(e) => onPaste(e, it.id)}
                  onBlur={() => {
                    if (!it.text.trim()) remove(it.id, { refocus: false, undo: false });
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (!it.text.trim()) return;
                      if (i === items.length - 1) ghostRef.current?.focus();
                      else insertAfter(it.id);
                    } else if (e.key === 'Backspace' && it.text === '') {
                      e.preventDefault();
                      remove(it.id);
                    }
                  }}
                />
                {near && (
                  <span className={`ce-count ${it.text.length >= MAX_CHARS ? 'max' : ''}`}>
                    {it.text.length} / {MAX_CHARS}
                  </span>
                )}
                {AMOUNT_RE.test(it.text) && (
                  <span className="ce-warn" role="status">
                    <Icon.Info size={13} />
                    <span>
                      {REQUEST.company} would see this amount exactly as typed, without Balo’s
                      margin. Keep prices in {priceSection}.
                    </span>
                  </span>
                )}
              </div>
              <button
                type="button"
                className="icon-btn del"
                aria-label={`Remove ${cfg.one} ${i + 1}`}
                onClick={() => remove(it.id)}
              >
                <Icon.Trash size={15} />
              </button>
            </div>
          );
        })}

        {full ? (
          <div className="ce-full">
            That’s {MAX_ITEMS}, the most a list holds. Combine related points to add another.
          </div>
        ) : (
          <div className="ce-row">
            <span aria-hidden="true" />
            <span className="ce-num">
              <Icon.Plus size={14} />
            </span>
            <AutoTextarea
              className="ce-ta"
              value={ghost}
              taRef={(el) => {
                ghostRef.current = el;
              }}
              aria-label={cfg.add}
              placeholder={items.length === 0 ? cfg.example : cfg.add}
              maxLength={MAX_CHARS}
              onChange={(v) => setGhost(v.replace(/\n+/g, ' '))}
              onPaste={(e) => onPaste(e, null)}
              onBlur={() => commitGhost(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  commitGhost(true);
                } else if (e.key === 'Backspace' && ghost === '' && items.length > 0) {
                  e.preventDefault();
                  taRefs.current[items[items.length - 1].id]?.focus();
                }
              }}
            />
            <span aria-hidden="true" />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Expert: composer ──────────────────────────────────────────────────────

function ChangeNote({ section, addressed, onToggle }) {
  const copy = SECTION_COPY[section];
  return (
    <div id="cr-note" className={`cr ${addressed ? 'done' : ''}`} tabIndex={-1}>
      <span className="avatar">{CLIENT.initials}</span>
      <div>
        <div className="cr-head">
          <strong>
            {CLIENT.name} @{REQUEST.company}
          </strong>{' '}
          asked for a change to {copy.phrase}
        </div>
        {addressed ? (
          <span className="cr-ok">
            <Icon.CheckCircle size={14} /> Marked as addressed
          </span>
        ) : (
          <p className="cr-quote">“{copy.note}”</p>
        )}
        <button type="button" className="linkbtn" onClick={onToggle}>
          {addressed ? 'Show note' : 'Mark as addressed'}
        </button>
      </div>
    </div>
  );
}

function Composer({ lists, setList, pricing, revise, onToast }) {
  const [addressed, setAddressed] = useState(false);
  useEffect(() => setAddressed(false), [revise]);

  const fixed = pricing === 'fixed';
  const priceSection = fixed ? 'Price and payments' : 'Rates and billing';
  const nA = lists.assumption.length;
  const nE = lists.exclusion.length;
  const nT = lists.term.length;

  const soft = [];
  if (revise && !addressed) {
    soft.push({
      id: 'note',
      label: `${CLIENT.first}’s note on ${SECTION_COPY[revise].noun} isn’t marked as addressed`,
      target: 'cr-note',
    });
  }
  if (nA === 0 && nE === 0) {
    soft.push({
      id: 'scope',
      label: 'No assumptions or exclusions yet',
      target: 'sec-assumptions',
    });
  }

  return (
    <>
      <div className="top">
        <div className="crumbs">
          <span className="hide-sm">Projects</span>
          <span className="sep hide-sm">/</span>
          <span className="hide-sm">{REQUEST.title}</span>
          <span className="sep hide-sm">/</span>
          <b>Proposal</b>
        </div>
        <div className="save">
          <span className="dot" />
          {revise ? 'Not saved until you resend' : 'Draft saved'}
        </div>
      </div>

      <div className="layout">
        <main className="main">
          <div className="for">
            Proposal for <strong>{REQUEST.company}</strong>
            {revise && <span className="vchip">Version 2</span>}
          </div>
          <h1 className="title">{REQUEST.title}</h1>

          <div className="props">
            <span className="chip">
              <Icon.Tag size={15} /> {fixed ? 'Fixed price' : 'Time and materials'}
            </span>
            <span className="chip">
              <Icon.Clock size={15} /> 6 weeks
            </span>
            <span className="chip gone">Balo standard terms</span>
          </div>
          <Anno>
            The Terms chip leaves the property bar. With no upload there is nothing to choose there,
            and Balo’s block now sits in Additional terms.
          </Anno>

          {revise && (
            <div className="cr-summary">
              <span>
                {CLIENT.first} asked for a change to {SECTION_COPY[revise].phrase}
              </span>
              <button type="button" className="linkbtn" onClick={() => jumpTo('cr-note')}>
                Go to note
              </button>
            </div>
          )}

          <Unchanged title="Overview" />
          <Unchanged title="Milestones" />

          <section className="section" id="sec-assumptions">
            {revise === 'assumptions_exclusions' && (
              <ChangeNote
                section={revise}
                addressed={addressed}
                onToggle={() => setAddressed((v) => !v)}
              />
            )}
            <div className="sh">
              <h2>
                Assumptions <small>Optional</small>
              </h2>
              <span className="ce-hint">{LIST_HINT}</span>
            </div>
            <p className="help">
              What your price and timeline rely on. If one turns out not to hold, it’s your basis
              for proposing a change.
            </p>
            <ClauseEditor
              kind="assumption"
              items={lists.assumption}
              onChange={(v) => setList('assumption', v)}
              onToast={onToast}
              priceSection={priceSection}
            />
          </section>

          <section className="section" id="sec-exclusions">
            <div className="sh">
              <h2>
                Not included <small>Optional</small>
              </h2>
              <span className="ce-hint">{LIST_HINT}</span>
            </div>
            <p className="help">
              Anything explicitly out of scope, so there are no surprises later.
            </p>
            <ClauseEditor
              kind="exclusion"
              items={lists.exclusion}
              onChange={(v) => setList('exclusion', v)}
              onToast={onToast}
              priceSection={priceSection}
            />
          </section>

          <Unchanged title={priceSection} />

          <section className="section" id="sec-terms">
            {revise === 'terms' && (
              <ChangeNote
                section={revise}
                addressed={addressed}
                onToggle={() => setAddressed((v) => !v)}
              />
            )}
            <div className="sh">
              <h2>
                Additional terms <small>Optional</small>
              </h2>
              <span className="ce-hint">{LIST_HINT}</span>
            </div>
            <p className="help">
              Terms of your own for this project. They add to Balo’s Project T&Cs and can’t replace
              them.
            </p>
            <BaloTerms pricing={pricing} where="composer" />
            <div className="gap12">
              <ClauseEditor
                kind="term"
                items={lists.term}
                onChange={(v) => setList('term', v)}
                onToast={onToast}
                priceSection={priceSection}
              />
            </div>
            {nT > 0 && (
              <p className="foot-note">
                {REQUEST.company} sees these with the proposal and agrees to them when accepting.
                Where one conflicts with Balo’s Project T&Cs, Balo’s apply.
              </p>
            )}
          </section>

          <Unchanged
            title="Attachments"
            note="Reference documents only. The “Attach your terms” upload is gone."
          />
        </main>

        <aside className="rail" aria-label="Proposal summary">
          <div className="card">
            <div className="r-label">You receive</div>
            <div className="r-total">
              {fixed ? (
                aud(MONEY.fixedPriceCents)
              ) : (
                <>
                  {aud(MONEY.tmEstimateCents)} <small>est.</small>
                </>
              )}
            </div>
            <p className="r-sub">
              {fixed
                ? `Paid ${MONEY.upfrontPct} / ${100 - MONEY.upfrontPct}`
                : `${MONEY.hours} hours at ${aud(MONEY.tmRateCents)}/hr`}
            </p>
            <dl className="r-dl">
              <div>
                <dt>Pricing</dt>
                <dd>{fixed ? 'Fixed price' : 'Time and materials'}</dd>
              </div>
              <div>
                <dt>Milestones</dt>
                <dd>3</dd>
              </div>
              <div>
                <dt>Timeframe</dt>
                <dd>6 weeks</dd>
              </div>
              <div>
                <dt>Assumptions</dt>
                <dd>{nA || 'None'}</dd>
              </div>
              <div>
                <dt>Not included</dt>
                <dd>{nE || 'None'}</dd>
              </div>
              <div>
                <dt>Terms</dt>
                <dd>{nT ? `Balo’s and ${nT} of yours` : 'Balo’s only'}</dd>
              </div>
            </dl>
            <div className="cl">
              <div className="cl-head ok">
                <Icon.CheckCircle size={15} /> Ready to send
              </div>
              {soft.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className="cl-item"
                  onClick={() => jumpTo(it.target)}
                >
                  <span>{it.label}</span>
                  <Icon.ChevronRight size={14} />
                </button>
              ))}
            </div>
            <button
              type="button"
              className="cta"
              onClick={() => onToast('Preview and send are unchanged, so they aren’t drawn here.')}
            >
              {revise ? 'Preview and resend' : 'Preview and send'}
            </button>
          </div>
        </aside>
      </div>
    </>
  );
}

// ── Client: proposal ──────────────────────────────────────────────────────

function NumberedList({ items, tight }) {
  return (
    <ol className={`nl ${tight ? 'tight' : ''}`}>
      {items.map((it) => (
        <li key={it.id}>
          <span>{it.text}</span>
        </li>
      ))}
    </ol>
  );
}

function clientMoney(pricing) {
  if (pricing === 'fixed') {
    const total = withFee(MONEY.fixedPriceCents);
    const upfront = Math.round((total * MONEY.upfrontPct) / 100);
    return {
      total: aud(total),
      totalNode: aud(total),
      method: 'Fixed price',
      payments: `${MONEY.upfrontPct}% upfront, ${100 - MONEY.upfrontPct}% on delivery`,
      rows: [
        ['Total', aud(total), 'Fixed price'],
        ['Due now', aud(upfront), `${MONEY.upfrontPct}% upfront`],
        ['Then', aud(total - upfront), 'on delivery'],
      ],
    };
  }
  const total = withFee(MONEY.tmEstimateCents);
  return {
    total: `${aud(total)} est.`,
    totalNode: (
      <>
        {aud(total)} <small>est.</small>
      </>
    ),
    method: 'Time & materials',
    payments: 'Billed monthly',
    rows: [
      ['Total', aud(total), 'Time & materials'],
      ['Due now', aud(withFee(MONEY.tmDepositCents)), 'deposit'],
      ['Then', '—', `billed against time at ${aud(withFee(MONEY.tmRateCents))}/hr`],
    ],
  };
}

function ClientProposal({ lists, pricing, onAccept, onChanges, onToast }) {
  const money = clientMoney(pricing);
  const hasScope = lists.assumption.length > 0 || lists.exclusion.length > 0;
  const go = (id) => document.getElementById(id)?.scrollIntoView({ block: 'start' });

  return (
    <>
      <div className="top">
        <div className="crumbs">
          <span className="hide-sm">Projects</span>
          <span className="sep hide-sm">/</span>
          <span className="hide-sm">{REQUEST.title}</span>
          <span className="sep hide-sm">/</span>
          <b>{EXPERT.name}’s proposal</b>
        </div>
      </div>

      <div className="layout">
        <main className="main">
          <nav className="nav" aria-label="Proposal sections">
            <button type="button">Overview</button>
            <button type="button">Milestones</button>
            {hasScope && (
              <button type="button" onClick={() => go('doc-scope')}>
                Assumptions and exclusions
              </button>
            )}
            <button type="button">Payment terms</button>
            <button type="button" onClick={() => go('doc-terms')}>
              Terms
            </button>
            <button type="button" onClick={() => go('doc-attachments')}>
              Attachments
            </button>
          </nav>

          <div className="doc">
            <div className="doc-from">
              <span className="avatar">{EXPERT.initials}</span>
              {EXPERT.name} · Version 1
            </div>
            <h1>{REQUEST.title}</h1>
            <dl className="doc-facts">
              <div>
                <dt>{pricing === 'fixed' ? 'Price' : 'Estimate'}</dt>
                <dd>{money.total}</dd>
              </div>
              <div>
                <dt>Timeframe</dt>
                <dd>6 weeks</dd>
              </div>
              <div>
                <dt>Payments</dt>
                <dd>{money.payments}</dd>
              </div>
            </dl>

            <Unchanged title="Overview" />
            <Unchanged title="Milestones & deliverables" />

            {hasScope ? (
              <section id="doc-scope">
                <h2>Assumptions and exclusions</h2>
                {lists.assumption.length > 0 && (
                  <>
                    <h3>Assumptions</h3>
                    <p className="lead">{EXPERT.first}’s price and timeline rely on these.</p>
                    <NumberedList items={lists.assumption} />
                  </>
                )}
                {lists.exclusion.length > 0 && (
                  <>
                    <h3>Not included</h3>
                    <p className="lead">Outside this proposal.</p>
                    <NumberedList items={lists.exclusion} />
                  </>
                )}
              </section>
            ) : (
              <Anno>
                With no assumptions and no exclusions, this section and its nav chip don’t render.
              </Anno>
            )}

            <Unchanged title="Payment terms" />

            <section id="doc-terms">
              <h2>Terms</h2>
              <BaloTerms pricing={pricing} where="proposal" />
              {lists.term.length > 0 && (
                <>
                  <h3 style={{ marginTop: 18 }}>{EXPERT.name}’s additional terms</h3>
                  <p className="lead">
                    These add to Balo’s Project T&Cs. Where one conflicts, Balo’s apply.
                  </p>
                  <NumberedList items={lists.term} />
                </>
              )}
            </section>

            <section id="doc-attachments">
              <h2>Attachments</h2>
              <div className="att">
                {[
                  ['CPQ-solution-outline.pdf', '1.2 MB'],
                  ['Sample-quote-template.pdf', '480 KB'],
                ].map(([name, size]) => (
                  <button
                    key={name}
                    type="button"
                    aria-label={`Download ${name}`}
                    onClick={() => onToast(`Downloading ${name}`)}
                  >
                    <Icon.File size={18} />
                    <span>
                      <b>{name}</b>
                      <small>{size}</small>
                    </span>
                    <Icon.Download size={16} />
                  </button>
                ))}
              </div>
              <Anno>
                Each attachment opens the file. Today the client sees a name and size that can’t be
                opened.
              </Anno>
            </section>
          </div>
        </main>

        <aside className="rail" aria-label="Your decision">
          <div className="card">
            <div className="r-label">{pricing === 'fixed' ? 'Total' : 'Estimated total'}</div>
            <div className="r-total">{money.totalNode}</div>
            <p className="r-sub">{money.method} · 6 weeks</p>
            <div style={{ marginTop: 16 }}>
              <button type="button" className="cta" onClick={onAccept}>
                <Icon.Check size={17} /> Accept this proposal
              </button>
              <button type="button" className="btn wide" onClick={onChanges}>
                <Icon.Rotate size={15} /> Request changes
              </button>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

// ── Client: dialogs ───────────────────────────────────────────────────────

function Modal({ labelledBy, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
}

function ChangesDialog({ onClose, onSent }) {
  const [section, setSection] = useState('assumptions_exclusions');
  const [note, setNote] = useState('');
  const numbered = section === 'assumptions_exclusions' || section === 'terms';
  return (
    <Modal labelledBy="changes-title" onClose={onClose}>
      <div className="m-head warn">
        <span className="m-ic">
          <Icon.Rotate size={18} />
        </span>
        <div>
          <h2 id="changes-title">Request changes from {EXPERT.first}</h2>
          <p>
            {EXPERT.first} will revise and resubmit as a new version. Your other proposal isn’t
            affected.
          </p>
        </div>
      </div>
      <div className="m-body">
        <div>
          <label className="fl" htmlFor="changes-section">
            What needs work?
          </label>
          <select
            id="changes-section"
            className="sel"
            value={section}
            onChange={(e) => setSection(e.target.value)}
          >
            {CHANGE_SECTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          {numbered && (
            <div className="fh">
              Say which one by its number, for example “
              {section === 'terms' ? 'Term 1' : 'Assumption 2'}”.
            </div>
          )}
          <Anno>
            Two new options:{' '}
            {CHANGE_SECTIONS.filter((s) => s.isNew)
              .map((s) => s.label)
              .join(' and ')}
            . The other five are unchanged.
          </Anno>
        </div>
        <div>
          <label className="fl" htmlFor="changes-note">
            Your note
          </label>
          <textarea
            id="changes-note"
            className="ta"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={`Tell ${EXPERT.first} what you’d like changed…`}
          />
        </div>
      </div>
      <div className="m-foot">
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="cta cta-sm"
          disabled={!note.trim()}
          onClick={() => onSent(`Sent to ${EXPERT.name}`)}
        >
          <Icon.Rotate size={15} /> Send request
        </button>
      </div>
    </Modal>
  );
}

function AcceptDialog({ lists, pricing, onClose, onDone }) {
  const [ack, setAck] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const money = clientMoney(pricing);
  const terms = lists.term;
  const shown = showAll || terms.length <= 3 ? terms : terms.slice(0, 3);
  const nA = lists.assumption.length;
  const nE = lists.exclusion.length;
  const also = [nA ? countOf(nA, 'assumption') : null, nE ? countOf(nE, 'exclusion') : null]
    .filter(Boolean)
    .join(' and ');

  return (
    <Modal labelledBy="accept-title" onClose={onClose}>
      <div className="m-head">
        <span className="m-ic">{EXPERT.initials}</span>
        <div>
          <h2 id="accept-title">Accept {EXPERT.name}’s proposal?</h2>
          <p>This starts the engagement and is binding.</p>
        </div>
      </div>
      <div className="m-body">
        <dl className="money">
          {money.rows.map(([label, value, sub]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                {value}
                <span>{sub}</span>
              </dd>
            </div>
          ))}
        </dl>

        <div className="agree">
          <h3>What you’re agreeing to</h3>
          <BaloTerms pricing={pricing} where="accept" />
          {terms.length > 0 && (
            <>
              <div className="agree-part">
                <span>
                  {EXPERT.name}’s additional terms ({terms.length})
                </span>
                {terms.length > 3 && (
                  <button type="button" className="linkbtn" onClick={() => setShowAll((v) => !v)}>
                    {showAll ? 'Show fewer' : `Show all ${terms.length}`}
                  </button>
                )}
              </div>
              <NumberedList items={shown} tight />
            </>
          )}
          {also && (
            <p className="agree-also">The proposal’s {also} are part of what you’re accepting.</p>
          )}
        </div>

        <label className="ack">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>
            I agree to <strong>Balo’s Project T&Cs</strong>
            {terms.length > 0 ? ` and ${EXPERT.name}’s additional terms above` : ''}, and understand
            accepting commits {REQUEST.company} to them. Balo will raise the upfront invoice and
            tell the other experts they weren’t selected.
          </span>
        </label>
      </div>
      <div className="m-foot">
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="cta cta-sm"
          disabled={!ack}
          onClick={() => onDone('Proposal accepted')}
        >
          <Icon.Check size={16} /> Confirm acceptance
        </button>
      </div>
    </Modal>
  );
}

// ── Delivery workspace ────────────────────────────────────────────────────

function AgreedTerms({ lists, pricing, changed }) {
  const [open, setOpen] = useState(true);
  const parts = [
    lists.assumption.length ? countOf(lists.assumption.length, 'assumption') : null,
    lists.exclusion.length ? countOf(lists.exclusion.length, 'exclusion') : null,
    lists.term.length
      ? `${lists.term.length} additional ${plural(lists.term.length, 'term', 'terms')}`
      : null,
  ].filter(Boolean);
  const summary = parts.join(' · ');

  return (
    <div className="agreed">
      <button
        type="button"
        className="agreed-head"
        aria-expanded={open}
        aria-controls="agreed-body"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="balo-ic">
          <Icon.Scroll size={15} />
        </span>
        <span>
          <b>Agreed in the proposal</b>
          <span className="sum">{summary}</span>
        </span>
        <Icon.ChevronDown size={16} />
      </button>
      {open && (
        <div className="agreed-body" id="agreed-body">
          <p className="agreed-meta">
            Accepted by {CLIENT.name} @{REQUEST.company} on 24 November 2026.
          </p>
          {changed && (
            <div className="note">
              <Icon.Info size={15} />
              <span>
                This is what was agreed at the start. Changes approved since then are in Change
                history.
              </span>
            </div>
          )}
          {lists.assumption.length > 0 && (
            <>
              <h3>Assumptions</h3>
              <NumberedList items={lists.assumption} tight />
            </>
          )}
          {lists.exclusion.length > 0 && (
            <>
              <h3>Not included</h3>
              <NumberedList items={lists.exclusion} tight />
            </>
          )}
          {lists.term.length > 0 && (
            <>
              <h3>{EXPERT.name}’s additional terms</h3>
              <NumberedList items={lists.term} tight />
            </>
          )}
          <h3>Balo’s terms</h3>
          <BaloTerms pricing={pricing} where="accept" />
        </div>
      )}
    </div>
  );
}

function Delivery({ lists, pricing, changed }) {
  const hasAny = lists.assumption.length + lists.exclusion.length + lists.term.length > 0;
  return (
    <>
      <div className="top">
        <div className="crumbs">
          <span className="hide-sm">Projects</span>
          <span className="sep hide-sm">/</span>
          <b>{REQUEST.title}</b>
        </div>
      </div>
      <div className="layout solo">
        <main className="main">
          <Unchanged title="Project header and banners" />
          <Unchanged title="Milestones" />
          <Unchanged title="Progress" />
          {hasAny ? (
            <>
              <AgreedTerms lists={lists} pricing={pricing} changed={changed} />
              <Anno>
                New card, under Progress and above the change cards. Read-only and the same for the
                client, the expert and Balo admins. Open here to show its contents; it starts
                collapsed.
              </Anno>
            </>
          ) : (
            <Anno>
              With no assumptions, exclusions or additional terms on the proposal, the card doesn’t
              render.
            </Anno>
          )}
          <Unchanged title="Request a change, Change history, Action items" />
        </main>
      </div>
    </>
  );
}

// ── Prototype shell ───────────────────────────────────────────────────────

export default function ProposalAssumptionsExclusionsTerms() {
  const [view, setView] = useState('composer');
  const [dialog, setDialog] = useState(null);
  const [pricing, setPricing] = useState('fixed');
  const [fill, setFill] = useState('filled');
  const [lists, setLists] = useState(filledLists);
  const [revise, setRevise] = useState(null);
  const [changed, setChanged] = useState(false);
  const [toast, setToast] = useState(null);

  const setList = useCallback((kind, items) => setLists((p) => ({ ...p, [kind]: items })), []);
  const showToast = useCallback((text, undo) => setToast({ text, undo, key: Date.now() }), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const rootRef = useRef(null);
  const protoRef = useRef(null);

  // Reference-only: keep sticky headers and dialogs clear of the state bar, whatever its height.
  useEffect(() => {
    const measure = () => {
      if (!rootRef.current || !protoRef.current) return;
      rootRef.current.style.setProperty('--proto-h', `${protoRef.current.offsetHeight}px`);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const show = (nextView, nextDialog = null) => {
    setView(nextView);
    setDialog(nextDialog);
  };
  const refill = (mode) => {
    setFill(mode);
    setLists(mode === 'filled' ? filledLists() : emptyLists());
  };
  const tab = (isOn, onClick, label) => (
    <button type="button" className={isOn ? 'on' : ''} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div className="pt" ref={rootRef}>
      <style>{CSS}</style>

      <div
        className="proto"
        ref={protoRef}
        role="group"
        aria-label="Prototype state (reference only)"
      >
        <span>Prototype state</span>
        {tab(view === 'composer', () => show('composer'), 'Expert: composer')}
        {tab(view === 'client' && !dialog, () => show('client'), 'Client: proposal')}
        {tab(dialog === 'changes', () => show('client', 'changes'), 'Client: request changes')}
        {tab(dialog === 'accept', () => show('client', 'accept'), 'Client: accept')}
        {tab(view === 'delivery', () => show('delivery'), 'Delivery workspace')}
        <span className="gap" />
        {tab(pricing === 'fixed', () => setPricing('fixed'), 'Fixed price')}
        {tab(pricing === 'tm', () => setPricing('tm'), 'Time and materials')}
        <span className="gap" />
        {tab(fill === 'filled', () => refill('filled'), 'Lists filled')}
        {tab(fill === 'empty', () => refill('empty'), 'Lists empty')}
        {view === 'composer' && (
          <>
            <span className="gap" />
            {tab(revise === null, () => setRevise(null), 'Writing')}
            {tab(
              revise === 'assumptions_exclusions',
              () => setRevise('assumptions_exclusions'),
              'Revising: assumptions'
            )}
            {tab(revise === 'terms', () => setRevise('terms'), 'Revising: terms')}
          </>
        )}
        {view === 'delivery' && (
          <>
            <span className="gap" />
            {tab(!changed, () => setChanged(false), 'No changes since')}
            {tab(changed, () => setChanged(true), 'A change approved since')}
          </>
        )}
      </div>

      {view === 'composer' && (
        <Composer
          lists={lists}
          setList={setList}
          pricing={pricing}
          revise={revise}
          onToast={showToast}
        />
      )}
      {view === 'client' && (
        <ClientProposal
          lists={lists}
          pricing={pricing}
          onAccept={() => setDialog('accept')}
          onChanges={() => setDialog('changes')}
          onToast={showToast}
        />
      )}
      {view === 'delivery' && <Delivery lists={lists} pricing={pricing} changed={changed} />}

      {dialog === 'changes' && (
        <ChangesDialog
          onClose={closeDialog}
          onSent={(text) => {
            setDialog(null);
            showToast(text);
          }}
        />
      )}
      {dialog === 'accept' && (
        <AcceptDialog
          lists={lists}
          pricing={pricing}
          onClose={closeDialog}
          onDone={(text) => {
            setDialog(null);
            showToast(text);
          }}
        />
      )}

      {toast && (
        <div className="toast" role="status" aria-live="polite">
          <span>{toast.text}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={() => {
                toast.undo();
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}
    </div>
  );
}
