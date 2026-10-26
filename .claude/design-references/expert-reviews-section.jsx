/**
 * Expert detail page: Reviews section (redesign)
 * Design reference → .claude/design-references/expert-reviews-section.jsx
 * Replaces the aggregate-only card ("5.0 / average across 1 engagement" + counting-rule paragraph).
 * Builds on expert-detail-page.jsx (tokens, Card, SectionLabel, StarRow/RatingStar) and RatingBlock
 * (components/balo/reviews/). Repo font is Geist; cards are flat.
 * Tickets: BAL-628 (capture + migration + formatter + ReviewEntry), BAL-629 (profile display),
 * BAL-630 (admin: company industry and the company-level name switch).
 *
 * WHAT CHANGES
 * 1. The section shows the reviews themselves. One entry per engagement, so the list length always
 *    equals the count in the summary.
 * 2. The counting-rule paragraph moves behind a "Verified engagements" popover.
 * 3. The large average and the distribution appear only once the expert has REVIEW_SUMMARY_FLOOR (5)
 *    reviewed engagements. Below that, the average is a small inline line and the entries lead.
 * 4. Projects and consultations are broken out: an inline phrase below the floor, filter chips at or
 *    above it (chips only when both kinds exist). Chips filter the list; the summary stays on "All".
 *
 * DISPLAY RULES
 * - Entry stars = engagementRating(raters). This MUST be the same function the expert aggregate uses
 *   (one shared definition), so an entry can never disagree with the number it contributes.
 * - Distribution buckets each engagement by Math.round(engagementRating).
 * - One rater: stars once, in the entry header. Several raters: header shows the engagement stars plus
 *   "Rated by N people at {Company}" (company only if every rater opted in, otherwise "on the client's
 *   team"), and each rater row carries that person's own stars.
 * - A note shows only when body_visibility = 'public'. A private note and a rating with no note render
 *   identically, with no "No comment" placeholder.
 * - Attribution: "{First} {L}." on the first line. Second line: "{Role} @{Company}" if showCompany,
 *   otherwise "{Role}, {Industry}". Each part drops out when missing ("{Role}", "{Industry}", or the
 *   company alone), and with nothing left the name stands alone. Never infer a value.
 * - Most recent first. INITIAL_VISIBLE entries, then "Show N more reviews". Notes over
 *   NOTE_CLAMP_CHARS clamp to four lines with "Read more".
 * - Existing star convention: five-star rows on entries; a single proportional star wherever a
 *   numeric label sits beside it.
 * - "Consultation" is the public label for a case engagement (copy call for MJ).
 *
 * ATTRIBUTION (D6, rewritten 2026-10-26: the reviewer is named; the company is optional)
 * - One pure formatter, formatReviewAttribution in @balo/shared/reviews, builds every attribution string:
 *   the live line under the form, the Preview, and the public projection. They cannot disagree.
 * - Name: "{First} {L}." derived SERVER-SIDE (the full surname never leaves the server). Missing surname →
 *   first name only. No name at all → "Verified client". Never the email.
 * - Company allowed = the reviewer chose to show it AND companies.is_personal is false AND
 *   companies.review_name_hidden_at IS NULL (the company-level switch CS sets, BAL-630). A personal
 *   workspace name may be the person's own name, so it is never shown. When the company isn't allowed the
 *   checkbox is not offered and show_company is written false server-side.
 *
 * CAPTURE CHANGES (prerequisite, see the "Capture" tab)
 * - Applies to RatingBlock (end_of_call, recap, project_workspace, case_surface) and the /review/{token}
 *   landing form (review-form.tsx). The live line appears as soon as a star is chosen, before Save.
 * - Note: written for a public reader. "Send the note to Balo privately instead" → reviews.body_visibility.
 * - Role: optional, free text, max 60. Prefilled from users.job_title; snapshotted to reviews.reviewer_role
 *   and saved back to users.job_title (best effort, after the review commits).
 * - Company: checkbox checked on a reviewer's first review, then prefilled from their most recent review,
 *   so an untick is never re-defaulted. The company is the engagement's client company.
 * - Industry is never asked of the reviewer: companies.industry_id → industries, set by CS in admin.
 * - "Preview" text link at the end of the live line opens the real ReviewEntry in a popover. No inline
 *   preview card.
 * - Columns: reviews.body_visibility pgEnum ('public' | 'private') NOT NULL DEFAULT 'private',
 *   reviews.show_company boolean NOT NULL DEFAULT false, reviews.reviewer_role text null (≤ 60),
 *   users.job_title text null, companies.industry_id uuid null → industries.id (restrict),
 *   companies.review_name_hidden_at + review_name_hidden_by_user_id (ADR-1030 pair). The DB defaults fail
 *   closed; the form's defaults (public note, company on) are product choices the write path sends.
 *
 * ANALYTICS
 * - New: review_preview_opened { surface, has_body, show_company, body_visibility }, once per open.
 * - Add has_role, show_company, body_visibility to the existing review_submitted / review_updated.
 * - No names, roles, company names or note text in any event.
 *
 * OUT OF SCOPE: expert replies, sub-ratings, helpfulness votes (Phase 2). The zero-review state is
 * unchanged. All copy is draft for MJ. Fee concealment: no money anywhere in this section.
 */

import { useState, useRef, useEffect } from "react";
import {
  MessageSquare, Star, Info, BadgeCheck, ChevronDown, ChevronUp, Lock, Eye, Check, X,
} from "lucide-react";

/* ───────────────────────── Tokens ───────────────────────── */

const FONT = "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

const c = {
  text: "#0F172A",
  textSecondary: "#475569",
  textTertiary: "#64748B",
  textFaint: "#94A3B8",
  border: "#E2E8F0",
  borderSubtle: "#EDF1F5",
  surface: "#FFFFFF",
  surfaceMuted: "#F8FAFC",
  canvas: "#F4F6F9",
  accent: "#2563EB",
  accentSoft: "#EFF4FF",
  star: "#F59E0B",
  starEmpty: "#E2E8F0",
  good: "#059669",
};

const KIND = {
  project: { label: "Project", bg: "#EEF0FF", fg: "#4338CA" },
  consultation: { label: "Consultation", bg: "#E8F6FA", fg: "#0E7490" },
};

const REVIEW_SUMMARY_FLOOR = 5; // same floor as topRated; configurable, not hardcoded
const INITIAL_VISIBLE = 3;
const NOTE_CLAMP_CHARS = 260;
const NARROW_BELOW = 520; // container width, not viewport

const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
*, *::before, *::after { box-sizing: border-box; }
button, textarea { font-family: inherit; }
:focus-visible { outline: 2px solid ${c.accent}; outline-offset: 2px; border-radius: 6px; }
textarea:focus-visible { outline-offset: 0; border-radius: 10px; }
`;

/* ───────────────────────── Helpers ───────────────────────── */

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

// Shared definition. The expert aggregate must use this exact function per engagement.
const engagementRating = (raters) => mean(raters.map((r) => r.rating));

const fmt1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtMonth = (ym) => {
  const [y, m] = ym.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const kindPhrase = (entries) => {
  const p = entries.filter((e) => e.kind === "project").length;
  const k = entries.length - p;
  return [p && plural(p, "project", "projects"), k && plural(k, "consultation", "consultations")]
    .filter(Boolean)
    .join(" and ");
};
const displayName = (r) => `${r.first} ${r.lastInitial}.`;
const displayRole = (r) => {
  if (r.showCompany) return r.role ? `${r.role} @${r.company}` : r.company;
  return [r.role, r.industry].filter(Boolean).join(", ") || null;
};
const publicNote = (r) => (r.note && r.bodyVisibility === "public" ? r.note : null);

function useElementWidth(ref) {
  const [w, setW] = useState(9999);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([entry]) => setW(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

/* ───────────────────────── Sample data ───────────────────────── */

const EXPERT = { firstName: "Charles" };

const P = {
  sam: { first: "Sam", lastInitial: "K", role: "RevOps Lead", company: "Northwind Logistics", industry: "Logistics" },
  lena: { first: "Lena", lastInitial: "W", role: "Sales Director", company: "Northwind Logistics", industry: "Logistics" },
  priya: { first: "Priya", lastInitial: "S", role: "Salesforce Admin", company: "Halcyon Health", industry: "Healthcare" },
  daniel: { first: "Daniel", lastInitial: "O", role: "Head of CRM", company: "Brightwater Super", industry: "Superannuation" },
  mei: { first: "Mei", lastInitial: "L", role: "Operations Manager", company: "Corrigan Freight", industry: null },
  tom: { first: "Tom", lastInitial: "R", role: "Sales Ops Analyst", company: "Fernhill Software", industry: "Software" },
  aisha: { first: "Aisha", lastInitial: "B", role: "CRM Lead", company: "Kestrel Energy", industry: "Energy" },
  jordan: { first: "Jordan", lastInitial: "P", role: null, company: "Larkspur Retail", industry: null },
  hannah: { first: "Hannah", lastInitial: "G", role: "Head of Sales Operations", company: "Orbit Media", industry: "Media" },
  ravi: { first: "Ravi", lastInitial: "M", role: "Platform Lead", company: "Tallis Bank", industry: "Banking" },
  kate: { first: "Kate", lastInitial: "D", role: "Salesforce Developer", company: "Tallis Bank", industry: "Banking" },
};

const rater = (person, rating, note = null, opts = {}) => ({
  ...person, rating, note, bodyVisibility: "public", showCompany: false, ...opts,
});

const CPQ_NOTE =
  "Charles untangled a CPQ setup that three different partners had layered on top of each other over four years. Quoting used to take most of a day; now our reps build a quote in a few minutes, and for the first time our ops team can explain how the pricing rules fit together. The handover docs alone were worth it. We have already used them to onboard two new admins without calling anyone.";

const E = {
  cpq: { id: "e1", kind: "project", completedAt: "2026-10", topics: ["CPQ", "Sales Cloud"],
    raters: [rater(P.sam, 5, CPQ_NOTE, { showCompany: true })] },
  flow: { id: "e2", kind: "consultation", completedAt: "2026-09", topics: ["Flow"],
    raters: [rater(P.priya, 5, "Came in with a record-triggered flow that kept hitting governor limits. Forty minutes later it was rebuilt, and I understood why the old one failed.")] },
  portal: { id: "e3", kind: "project", completedAt: "2026-08", topics: ["Service Cloud", "Experience Cloud"],
    raters: [rater(P.daniel, 4, "Solid delivery and clear communication throughout. The portal launch slipped a week because of our own data quality, and Charles raised it early instead of at the deadline.", { showCompany: true })] },
  routing: { id: "e4", kind: "project", completedAt: "2026-07", topics: ["Sales Cloud"],
    raters: [rater(P.mei, 5)] },
  dash: { id: "e5", kind: "consultation", completedAt: "2026-06", topics: ["Reports & Dashboards"],
    raters: [rater(P.tom, 5, "Private feedback for the Balo team.", { bodyVisibility: "private" })] },
  data: { id: "e6", kind: "project", completedAt: "2026-05", topics: ["Data Cloud"],
    raters: [rater(P.aisha, 5, "Clear-eyed advice on what Data Cloud could and couldn't do for us before we committed to licences. We went in with a much smaller, better-scoped first phase.", { showCompany: true })] },
  sharing: { id: "e7", kind: "consultation", completedAt: "2026-04", topics: ["Sharing & Security"],
    raters: [rater(P.jordan, 5, "Quick, precise answer on a sharing-rule problem. Saved me a day in the docs.")] },
  leads: { id: "e8", kind: "project", completedAt: "2026-02", topics: ["Sales Cloud", "Flow"],
    raters: [rater(P.hannah, 5, "Our lead routing finally does what the sales team thinks it does.", { showCompany: true })] },
};

const SCENARIOS = {
  single: {
    tab: "1 engagement",
    caption: "Below the floor of 5 reviewed engagements, the average stays inline and the review itself leads. The counting rule now sits behind “Verified engagements”.",
    entries: [E.cpq],
  },
  established: {
    tab: "8 engagements",
    caption: "At 5 or more, the average, the distribution and the project/consultation filter appear. Three entries show first. Once expanded: the June consultation’s note was sent privately, so only its stars and attribution show; Corrigan Freight has no industry set, so Mei shows role only; Jordan gave no role and Larkspur has no industry, so the name stands alone.",
    entries: [E.cpq, E.flow, E.portal, E.routing, E.dash, E.data, E.sharing, E.leads],
  },
  multi: {
    tab: "Multiple raters",
    caption: "Still one entry per engagement, so the list matches the count. Entry stars use the same per-engagement value as the aggregate; each person’s own stars sit beside their name. The company is named only when every rater chose to show it.",
    entries: [
      { id: "m1", kind: "project", completedAt: "2026-10", topics: ["CPQ", "Sales Cloud"],
        raters: [
          rater(P.sam, 5, "Quoting went from most of a day to a few minutes, and the handover docs mean we can maintain it ourselves.", { showCompany: true }),
          rater(P.lena, 4, "The new approval flow is far easier for my reps. A short training session for the wider sales team at handover would have helped.", { showCompany: true }),
        ] },
      { id: "m2", kind: "consultation", completedAt: "2026-09", topics: ["Flow", "Apex"],
        raters: [
          rater(P.ravi, 5, "Charles reviewed our trigger framework with two of us on the call and gave each of us something different to fix. Very efficient."),
          rater(P.kate, 5),
        ] },
      E.portal,
    ],
  },
  noNote: {
    tab: "No note",
    caption: "A rating with no note, or with a note sent privately to Balo, renders the same: stars, type, date, topics and who rated. No “No comment” placeholder.",
    entries: [{ ...E.flow, id: "n1", completedAt: "2026-10", raters: [rater(P.priya, 5)] }],
  },
  capture: {
    tab: "Capture",
    caption: "Additions to RatingBlock on every surface that writes a review, including the email prefill form. The line under the form updates live, and “Preview” opens the real profile entry. Switch between a first and a returning reviewer to see the role prefill.",
  },
};

/* ───────────────────────── Primitives ───────────────────────── */

function Card({ children, style }) {
  return (
    <section style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: 16, ...style }}>
      {children}
    </section>
  );
}

function SectionLabel({ icon: Icon, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, color: c.textTertiary }}>
      <Icon size={14} strokeWidth={2} />
      <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {children}
      </span>
    </div>
  );
}

function StarGlyph({ size = 14, fill = 1 }) {
  return (
    <span aria-hidden="true" style={{ position: "relative", display: "inline-block", width: size, height: size, flexShrink: 0 }}>
      <Star size={size} strokeWidth={0} fill={c.starEmpty} style={{ position: "absolute", inset: 0, display: "block" }} />
      <span style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: `${Math.max(0, Math.min(1, fill)) * 100}%`, overflow: "hidden" }}>
        <Star size={size} strokeWidth={0} fill={c.star} style={{ display: "block" }} />
      </span>
    </span>
  );
}

function StarRow({ value, size = 14, gap = 2 }) {
  return (
    <span role="img" aria-label={`${fmt1(value)} out of 5 stars`} style={{ display: "inline-flex", gap, alignItems: "center" }}>
      {[0, 1, 2, 3, 4].map((i) => <StarGlyph key={i} size={size} fill={value - i} />)}
    </span>
  );
}

function KindBadge({ kind }) {
  const k = KIND[kind];
  return (
    <span style={{ fontSize: 12, fontWeight: 600, color: k.fg, background: k.bg, padding: "3px 8px", borderRadius: 6, lineHeight: 1.3 }}>
      {k.label}
    </span>
  );
}

function Topics({ topics }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
      {topics.map((t) => (
        <span key={t} style={{ fontSize: 12, color: c.textTertiary, border: `1px solid ${c.border}`, borderRadius: 6, padding: "2px 8px", lineHeight: 1.45, whiteSpace: "nowrap" }}>
          {t}
        </span>
      ))}
    </div>
  );
}

function Avatar({ r }) {
  return (
    <span aria-hidden="true" style={{
      width: 32, height: 32, borderRadius: "50%", background: "#F1F5F9", color: c.textSecondary,
      display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, flexShrink: 0,
    }}>
      {r.first[0]}{r.lastInitial}
    </span>
  );
}

function Attribution({ r, showStars }) {
  const role = displayRole(r);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      <Avatar r={r} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: c.text }}>{displayName(r)}</span>
          {showStars && <StarRow value={r.rating} size={12} gap={1} />}
        </div>
        {role && <div style={{ fontSize: 13, color: c.textTertiary, marginTop: 1 }}>{role}</div>}
      </div>
    </div>
  );
}

function Note({ text }) {
  const long = text.length > NOTE_CLAMP_CHARS;
  const [open, setOpen] = useState(false);
  const clamp = long && !open
    ? { display: "-webkit-box", WebkitLineClamp: 4, WebkitBoxOrient: "vertical", overflow: "hidden" }
    : {};
  return (
    <div>
      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: c.text, maxWidth: "68ch", ...clamp }}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} style={{ marginTop: 4, padding: 0, background: "none", border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 600, color: c.accent }}>
          {open ? "Show less" : "Read more"}
        </button>
      )}
    </div>
  );
}

function VerifiedNote({ firstName, alignLeft }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <span ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 0", background: "none", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500, color: c.textSecondary }}
      >
        <BadgeCheck size={15} color={c.accent} strokeWidth={2} />
        Verified engagements
        <Info size={13} color={c.textFaint} />
      </button>
      {open && (
        <div role="note" style={{
          position: "absolute", top: "calc(100% + 8px)", [alignLeft ? "left" : "right"]: 0, width: 288, zIndex: 20,
          background: c.surface, border: `1px solid ${c.border}`, borderRadius: 12, padding: "12px 14px",
          boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)", fontSize: 13, lineHeight: 1.55, color: c.textSecondary,
        }}>
          Every rating comes from a client who completed work with {firstName} on Balo. Each engagement counts once, however many people on the client’s team rated it.
        </div>
      )}
    </span>
  );
}

/* ───────────────────────── Summary ───────────────────────── */

function CompactSummary({ entries, firstName, narrow }) {
  const avg = mean(entries.map((e) => engagementRating(e.raters)));
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <StarGlyph size={18} fill={avg / 5} />
        <span style={{ fontSize: 17, fontWeight: 600, color: c.text, fontVariantNumeric: "tabular-nums" }}>{fmt1(avg)}</span>
        <span style={{ fontSize: 14, color: c.textTertiary }}>from {kindPhrase(entries)}</span>
      </div>
      <VerifiedNote firstName={firstName} alignLeft={narrow} />
    </div>
  );
}

function Distribution({ ratings }) {
  const total = ratings.length;
  return (
    <div style={{ display: "grid", gap: 6, width: "100%" }}>
      {[5, 4, 3, 2, 1].map((s) => {
        const n = ratings.filter((r) => Math.round(r) === s).length;
        return (
          <div key={s} style={{ display: "grid", gridTemplateColumns: "10px 12px 1fr 18px", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12.5, color: c.textTertiary, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{s}</span>
            <StarGlyph size={11} fill={1} />
            <span style={{ height: 6, borderRadius: 3, background: c.borderSubtle, overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${(n / total) * 100}%`, background: c.star, borderRadius: 3 }} />
            </span>
            <span style={{ fontSize: 12.5, color: n ? c.textSecondary : c.textFaint, fontVariantNumeric: "tabular-nums" }}>{n}</span>
          </div>
        );
      })}
    </div>
  );
}

function FullSummary({ entries, firstName, narrow, filter, setFilter }) {
  const ratings = entries.map((e) => engagementRating(e.raters));
  const avg = mean(ratings);
  const projects = entries.filter((e) => e.kind === "project").length;
  const consultations = entries.length - projects;
  const bothKinds = projects > 0 && consultations > 0;
  const chips = [
    { key: "all", label: "All", n: entries.length },
    { key: "project", label: "Projects", n: projects },
    { key: "consultation", label: "Consultations", n: consultations },
  ];
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", flexDirection: narrow ? "column" : "row", alignItems: narrow ? "flex-start" : "center", gap: narrow ? 18 : 40 }}>
        <div style={{ flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1, color: c.text, fontVariantNumeric: "tabular-nums" }}>{fmt1(avg)}</span>
            <StarGlyph size={26} fill={avg / 5} />
          </div>
          <div style={{ fontSize: 13.5, color: c.textTertiary, marginTop: 8 }}>from {plural(entries.length, "engagement", "engagements")}</div>
        </div>
        <div style={{ flex: 1, maxWidth: narrow ? "100%" : 300, width: "100%" }}>
          <Distribution ratings={ratings} />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginTop: 20 }}>
        {bothKinds ? (
          <div role="group" aria-label="Filter reviews by engagement type" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {chips.map((ch) => {
              const active = filter === ch.key;
              return (
                <button
                  key={ch.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setFilter(ch.key)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 999, cursor: "pointer",
                    fontSize: 13, fontWeight: 500,
                    background: active ? c.text : c.surface, color: active ? "#FFFFFF" : c.textSecondary,
                    border: `1px solid ${active ? c.text : c.border}`,
                  }}
                >
                  {ch.label}
                  <span style={{ fontVariantNumeric: "tabular-nums", opacity: active ? 0.7 : 1, color: active ? "#FFFFFF" : c.textFaint }}>{ch.n}</span>
                </button>
              );
            })}
          </div>
        ) : <span />}
        <VerifiedNote firstName={firstName} alignLeft={narrow} />
      </div>
    </div>
  );
}

/* ───────────────────────── Entry ───────────────────────── */

function ReviewEntry({ e, narrow, first }) {
  const multi = e.raters.length > 1;
  const rating = engagementRating(e.raters);
  const allShowCompany = e.raters.every((r) => r.showCompany);
  const single = e.raters[0];
  const singleNote = !multi ? publicNote(single) : null;

  return (
    <article style={{ padding: first ? "4px 0 20px" : "20px 0", borderTop: first ? "none" : `1px solid ${c.borderSubtle}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <StarRow value={rating} size={15} />
        <KindBadge kind={e.kind} />
        <span style={{ marginLeft: "auto", fontSize: 13, color: c.textFaint }}>{fmtMonth(e.completedAt)}</span>
      </div>

      {!multi && (
        <>
          {singleNote && <div style={{ marginTop: 12 }}><Note text={singleNote} /></div>}
          <div style={{
            display: "flex", flexDirection: narrow ? "column" : "row", alignItems: narrow ? "flex-start" : "center",
            justifyContent: "space-between", gap: 12, marginTop: 14,
          }}>
            <Attribution r={single} />
            <Topics topics={e.topics} />
          </div>
        </>
      )}

      {multi && (
        <>
          <div style={{ fontSize: 13, color: c.textTertiary, marginTop: 8 }}>
            Rated by {e.raters.length} people {allShowCompany ? `at ${single.company}` : "on the client’s team"}
          </div>
          <div style={{ marginTop: 14, paddingLeft: 14, borderLeft: `2px solid ${c.borderSubtle}`, display: "grid", gap: 16 }}>
            {e.raters.map((r) => {
              const note = publicNote(r);
              return (
                <div key={r.first}>
                  <Attribution r={r} showStars />
                  {note && <div style={{ marginTop: 8 }}><Note text={note} /></div>}
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 14 }}><Topics topics={e.topics} /></div>
        </>
      )}
    </article>
  );
}

/* ───────────────────────── Section ───────────────────────── */

function ReviewsSection({ firstName, entries }) {
  const ref = useRef(null);
  const narrow = useElementWidth(ref) < NARROW_BELOW;
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState(false);

  const aboveFloor = entries.length >= REVIEW_SUMMARY_FLOOR;
  const sorted = [...entries].sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  const listed = aboveFloor && filter !== "all" ? sorted.filter((e) => e.kind === filter) : sorted;
  const visible = expanded ? listed : listed.slice(0, INITIAL_VISIBLE);
  const remaining = listed.length - visible.length;

  const pickFilter = (f) => { setFilter(f); setExpanded(false); };

  return (
    <div ref={ref}>
      <Card style={{ padding: narrow ? "22px 18px 8px" : "26px 28px 10px" }}>
        <SectionLabel icon={MessageSquare}>Reviews</SectionLabel>

        {aboveFloor
          ? <FullSummary entries={entries} firstName={firstName} narrow={narrow} filter={filter} setFilter={pickFilter} />
          : <CompactSummary entries={entries} firstName={firstName} narrow={narrow} />}

        <div style={{ marginTop: 18, borderTop: `1px solid ${c.borderSubtle}`, paddingTop: 18 }}>
          {visible.map((e, i) => <ReviewEntry key={e.id} e={e} narrow={narrow} first={i === 0} />)}
        </div>

        {(remaining > 0 || (expanded && listed.length > INITIAL_VISIBLE)) && (
          <div style={{ borderTop: `1px solid ${c.borderSubtle}`, padding: "12px 0 14px" }}>
            <button
              type="button"
              onClick={() => setExpanded((x) => !x)}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 0", background: "none", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, color: c.accent }}
            >
              {remaining > 0 ? `Show ${remaining} more ${remaining === 1 ? "review" : "reviews"}` : "Show fewer"}
              {remaining > 0 ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ───────────────────────── Capture (RatingBlock additions) ───────────────────────── */

function CapturePreview({ firstName, returning }) {
  const ref = useRef(null);
  const previewRef = useRef(null);
  const narrow = useElementWidth(ref) < NARROW_BELOW;
  const me = P.sam;
  const [rating, setRating] = useState(5);
  const [hover, setHover] = useState(0);
  const [note, setNote] = useState("Quoting went from most of a day to a few minutes, and the handover docs mean we can maintain it ourselves.");
  const [role, setRole] = useState(returning ? me.role : "");
  // Checked on a first review; a returning reviewer gets their previous choice (sample: they left it on).
  const [showCompany, setShowCompany] = useState(true);
  const [isPrivate, setIsPrivate] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setSaved(false); }, [rating, note, role, showCompany, isPrivate]);

  useEffect(() => {
    if (!previewOpen) return undefined;
    const onDown = (e) => { if (previewRef.current && !previewRef.current.contains(e.target)) setPreviewOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setPreviewOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [previewOpen]);

  const hasNote = Boolean(note.trim());
  const draft = rater({ ...me, role: role.trim() || null }, rating, note.trim() || null, {
    showCompany, bodyVisibility: isPrivate ? "private" : "public",
  });
  const second = displayRole(draft);
  const asShown = second ? `${displayName(draft)}, ${second}` : displayName(draft);
  const privateNote = isPrivate && hasNote;
  const helperText = privateNote
    ? `Your rating shows on ${firstName}’s profile as ${asShown}. Only the Balo team sees your note.`
    : `Your ${hasNote ? "rating and note show" : "rating shows"} on ${firstName}’s profile as ${asShown}.`;
  const HelperIcon = privateNote ? Lock : Eye;
  const shown = hover || rating;

  const linkBtn = { padding: 0, background: "none", border: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 500, color: c.accent, textAlign: "left" };
  const label = { display: "block", fontSize: 14, fontWeight: 600, color: c.text };
  const field = { display: "block", width: "100%", marginTop: 8, padding: "10px 12px", border: `1px solid ${c.border}`, borderRadius: 10, fontSize: 14.5, lineHeight: 1.55, color: c.text, background: c.surface };

  return (
    <div ref={ref}>
      <Card style={{ padding: narrow ? "22px 18px" : "26px 28px" }}>
        <h3 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: c.text, letterSpacing: "-0.01em" }}>How was your project with {firstName}?</h3>

        <div role="radiogroup" aria-label="Your rating" style={{ display: "flex", gap: 4, marginTop: 14 }} onMouseLeave={() => setHover(0)}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={`${n} out of 5`}
              onMouseEnter={() => setHover(n)}
              onClick={() => setRating(n)}
              style={{ padding: 2, background: "none", border: "none", cursor: "pointer", lineHeight: 0 }}
            >
              <Star size={28} strokeWidth={0} fill={n <= shown ? c.star : c.starEmpty} />
            </button>
          ))}
        </div>

        {/* Note */}
        <label htmlFor="review-note" style={{ ...label, marginTop: 20 }}>
          Add a note <span style={{ fontWeight: 400, color: c.textFaint }}>(optional)</span>
        </label>
        <textarea
          id="review-note"
          rows={4}
          value={note}
          onChange={(ev) => setNote(ev.target.value)}
          placeholder={`What would you tell another team thinking of working with ${firstName}?`}
          style={{ ...field, resize: "vertical" }}
        />
        {hasNote && (
          <button type="button" onClick={() => setIsPrivate((v) => !v)} style={{ ...linkBtn, marginTop: 8 }}>
            {isPrivate ? `Show the note on ${firstName}’s profile instead` : "Send the note to Balo privately instead"}
          </button>
        )}

        {/* How you're named */}
        <label htmlFor="reviewer-role" style={{ ...label, marginTop: 20 }}>
          Your role <span style={{ fontWeight: 400, color: c.textFaint }}>(optional)</span>
        </label>
        <input
          id="reviewer-role"
          type="text"
          maxLength={60}
          value={role}
          onChange={(ev) => setRole(ev.target.value)}
          placeholder="e.g. Head of Sales Operations"
          style={{ ...field, maxWidth: 360 }}
        />
        <div style={{ fontSize: 12.5, color: c.textFaint, marginTop: 6 }}>
          {returning ? "From your last review. Update it if it’s changed." : "We’ll remember it for your next review."}
        </div>

        <button
          type="button"
          role="checkbox"
          aria-checked={showCompany}
          onClick={() => setShowCompany((v) => !v)}
          style={{ display: "inline-flex", alignItems: "center", gap: 10, marginTop: 16, padding: 0, background: "none", border: "none", cursor: "pointer", fontSize: 14, color: c.text, textAlign: "left" }}
        >
          <span aria-hidden="true" style={{
            width: 18, height: 18, borderRadius: 5, flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center",
            border: `1.5px solid ${showCompany ? c.accent : "#CBD5E1"}`, background: showCompany ? c.accent : c.surface,
          }}>
            {showCompany && <Check size={13} color="#FFFFFF" strokeWidth={3} />}
          </span>
          Show {me.company} on the review
        </button>

        {/* Live line + Preview popover */}
        <div ref={previewRef} style={{ position: "relative", marginTop: 18, paddingTop: 14, borderTop: `1px solid ${c.borderSubtle}` }}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5, color: c.textTertiary }}>
            <HelperIcon size={14} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>
              {helperText}{" "}
              <button
                type="button"
                aria-expanded={previewOpen}
                onClick={() => setPreviewOpen((v) => !v)}
                style={{ ...linkBtn, fontSize: 13, fontWeight: 600, display: "inline" }}
              >
                Preview
              </button>
            </span>
          </div>
          {previewOpen && (
            <div role="dialog" aria-label={`How it appears on ${firstName}’s profile`} style={{
              position: "absolute", top: "calc(100% + 8px)", left: 0, right: 0, zIndex: 30,
              background: c.surface, border: `1px solid ${c.border}`, borderRadius: 14,
              boxShadow: "0 12px 32px rgba(15, 23, 42, 0.10)", padding: narrow ? "14px 16px 0" : "16px 20px 0",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: c.textSecondary }}>How it appears on {firstName}’s profile</span>
                <button type="button" aria-label="Close preview" onClick={() => setPreviewOpen(false)} style={{ padding: 4, background: "none", border: "none", cursor: "pointer", color: c.textFaint, lineHeight: 0 }}>
                  <X size={16} />
                </button>
              </div>
              <ReviewEntry
                e={{ id: "draft", kind: "project", completedAt: "2026-10", topics: ["CPQ", "Sales Cloud"], raters: [draft] }}
                narrow={narrow}
                first
              />
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
          <button
            type="button"
            onClick={() => { setPreviewOpen(false); setSaved(true); }}
            style={{ padding: "10px 18px", borderRadius: 10, border: "none", cursor: "pointer", background: c.accent, color: "#FFFFFF", fontSize: 14, fontWeight: 600 }}
          >
            Save rating
          </button>
          {saved && (
            <span role="status" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13.5, color: c.good, fontWeight: 500 }}>
              <Check size={15} /> Saved
            </span>
          )}
        </div>
      </Card>
    </div>
  );
}

/* ───────────────────────── Prototype frame ───────────────────────── */

function Segmented({ options, value, onChange, label }) {
  return (
    <div role="group" aria-label={label} style={{ display: "inline-flex", flexWrap: "wrap", gap: 2, padding: 3, background: c.surfaceMuted, border: `1px solid ${c.border}`, borderRadius: 10 }}>
      {options.map((o) => {
        const active = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.key)}
            style={{
              padding: "6px 11px", borderRadius: 7, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500,
              background: active ? c.surface : "transparent", color: active ? c.text : c.textTertiary,
              boxShadow: active ? `0 0 0 1px ${c.border}` : "none",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function ExpertReviewsSectionReference() {
  const [scenario, setScenario] = useState("single");
  const [device, setDevice] = useState("desktop");
  const [reviewer, setReviewer] = useState("first");
  const s = SCENARIOS[scenario];

  return (
    <div style={{ minHeight: "100vh", background: c.canvas, fontFamily: FONT, color: c.text, WebkitFontSmoothing: "antialiased" }}>
      <style>{GLOBAL_CSS}</style>

      <header style={{ background: c.surface, borderBottom: `1px solid ${c.border}`, padding: "14px 20px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Reviews section design reference</div>
          <div style={{ fontSize: 12.5, color: c.textTertiary, marginTop: 2 }}>expert-reviews-section.jsx</div>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <Segmented
            label="Scenario"
            value={scenario}
            onChange={setScenario}
            options={Object.entries(SCENARIOS).map(([key, v]) => ({ key, label: v.tab }))}
          />
          {scenario === "capture" && (
            <Segmented
              label="Reviewer"
              value={reviewer}
              onChange={setReviewer}
              options={[{ key: "first", label: "First review" }, { key: "returning", label: "Returning reviewer" }]}
            />
          )}
          <Segmented
            label="Width"
            value={device}
            onChange={setDevice}
            options={[{ key: "desktop", label: "Desktop" }, { key: "mobile", label: "Mobile" }]}
          />
        </div>
      </header>

      <main style={{ padding: "24px 16px 72px", display: "flex", justifyContent: "center" }}>
        <div style={{ width: "100%", maxWidth: device === "mobile" ? 375 : 680 }}>
          <p style={{ margin: "0 0 16px", fontSize: 13.5, lineHeight: 1.55, color: c.textSecondary, maxWidth: "72ch" }}>{s.caption}</p>
          {scenario === "capture"
            ? <CapturePreview key={`${device}-${reviewer}`} firstName={EXPERT.firstName} returning={reviewer === "returning"} />
            : <ReviewsSection key={`${scenario}-${device}`} firstName={EXPERT.firstName} entries={s.entries} />}
        </div>
      </main>
    </div>
  );
}
