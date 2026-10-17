import React, { useState, useEffect, useRef } from 'react';

// ─────────────────────────────────────────────────────────────────────
// Balo — Help centre: the list page (/help) and the guide page (/help/[slug])
// Design reference for: Help Center project, build ticket for /help
//
// WHAT THIS IS
//   The public list of how-to guides on the marketing site, and the page
//   each guide opens into. Guides are markdown files in docs/help/, so the
//   list builds itself from their frontmatter. Nothing on it is hand-kept.
//
// THE ONE IDEA: the audience split. Balo is two-sided, and clients and
//   experts almost never need each other's guides. The page opens with that
//   choice, in the marketing home's own encoding: the client side on --mist,
//   the expert side on --night. The chosen side widens, and the list below
//   shows only its guides. Everything else on the page stays quiet.
//
// GUIDE FORMAT: numbered sections, each a title, a description and one
//   screenshot. Every screenshot rings the control its section is about and
//   badges the ring with the section number, so image and text can't drift.
//
// Tokens mirror apps/web/src/app/globals.css (hex approximations of the
// oklch values, light and dark, including the dark-mode --night inversion).
// Font: Geist. Sample content comes from docs/help/*.md.
// ─────────────────────────────────────────────────────────────────────

const FONT = "'Geist', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const EASE = 'cubic-bezier(0.22, 0.61, 0.36, 1)';

const THEMES = {
  light: {
    name: 'light',
    page: '#FFFFFF',
    card: '#FFFFFF',
    mist: '#F6F7FA',
    night: '#0B1121',
    nightInk: '#FFFFFF',
    nightSub: 'rgba(255,255,255,0.74)',
    ink: '#0F172A',
    body: '#334155',
    sub: '#64748B',
    faint: '#94A0B0',
    line: '#E2E7EE',
    lineSoft: '#EEF1F5',
    primary: '#2563EB',
    violet: '#7C3AED',
    primarySoft: '#EEF3FE',
    pausedSurface: '#F1F5F9',
    pausedBorder: '#CBD5E1',
    hatch: 'rgba(100,116,139,0.12)',
    ringGlow: 'rgba(37,99,235,0.16)',
    scrim: 'rgba(15,23,42,0.06)',
    shotShadow: '0 1px 2px rgba(15,23,42,0.05), 0 8px 24px rgba(15,23,42,0.06)',
  },
  dark: {
    name: 'dark',
    page: '#0A0E19',
    card: '#111729',
    mist: '#070A13', // recessed: darker than page, per the globals.css invariant
    night: '#232A52', // inverted: the lightest, most chromatic surface in dark mode
    nightInk: '#F8FAFC',
    nightSub: 'rgba(248,250,252,0.76)',
    ink: '#F8FAFC',
    body: '#CBD5E1',
    sub: '#9AA6B8',
    faint: '#748096',
    line: '#283244',
    lineSoft: '#1B2333',
    primary: '#4A85F2',
    violet: '#8B5CF6',
    primarySoft: 'rgba(74,133,242,0.14)',
    pausedSurface: '#1B2333',
    pausedBorder: '#3A4559',
    hatch: 'rgba(154,166,184,0.16)',
    ringGlow: 'rgba(74,133,242,0.24)',
    scrim: 'rgba(0,0,0,0.35)',
    shotShadow: '0 1px 2px rgba(0,0,0,0.4), 0 8px 24px rgba(0,0,0,0.3)',
  },
};

const grad = (t) => `linear-gradient(135deg, ${t.primary}, ${t.violet})`;
const hatch = (t) => ({
  backgroundColor: t.pausedSurface,
  backgroundImage: `repeating-linear-gradient(135deg, ${t.hatch} 0 6px, transparent 6px 12px)`,
});
const srOnly = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0,0,0,0)',
  whiteSpace: 'nowrap',
  border: 0,
};
const reducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const scrollToId = (id) => {
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
};

// Bold spans from **markdown** in sample copy.
const rich = (text, t) =>
  text.split('**').map((part, i) =>
    i % 2 ? (
      <strong key={i} style={{ fontWeight: 600, color: t.ink }}>
        {part}
      </strong>
    ) : (
      <React.Fragment key={i}>{part}</React.Fragment>
    )
  );

// ── Lucide-style inline icons ────────────────────────────────────────
const Ic = ({ children, size = 16, color = 'currentColor', sw = 2, style }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={style}
    aria-hidden="true"
  >
    {children}
  </svg>
);
const I = {
  chevronRight: (p) => (
    <Ic {...p}>
      <path d="m9 18 6-6-6-6" />
    </Ic>
  ),
  chevronDown: (p) => (
    <Ic {...p}>
      <path d="m6 9 6 6 6-6" />
    </Ic>
  ),
  mail: (p) => (
    <Ic {...p}>
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </Ic>
  ),
  info: (p) => (
    <Ic {...p}>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </Ic>
  ),
  thumbsUp: (p) => (
    <Ic {...p}>
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </Ic>
  ),
  thumbsDown: (p) => (
    <Ic {...p}>
      <path d="M17 14V2" />
      <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
    </Ic>
  ),
  menu: (p) => (
    <Ic {...p}>
      <line x1="4" x2="20" y1="6" y2="6" />
      <line x1="4" x2="20" y1="12" y2="12" />
      <line x1="4" x2="20" y1="18" y2="18" />
    </Ic>
  ),
  sun: (p) => (
    <Ic {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </Ic>
  ),
  moon: (p) => (
    <Ic {...p}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </Ic>
  ),
  monitor: (p) => (
    <Ic {...p}>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </Ic>
  ),
  phone: (p) => (
    <Ic {...p}>
      <rect width="14" height="20" x="5" y="2" rx="2" ry="2" />
      <path d="M12 18h.01" />
    </Ic>
  ),
};

// ── Sample data (in production: frontmatter of docs/help/*.md) ────────
// Only published guides render. This sample shows the intended full set.
const CATEGORIES = {
  client: [
    {
      id: 'getting-started',
      title: 'Getting started',
      blurb: 'Setting up your company and bringing your team in.',
      articles: [
        {
          slug: 'naming-your-workspace',
          title: 'Naming your workspace',
          summary: 'What your company name is used for and how to change it.',
        },
        {
          slug: 'joining-your-team',
          title: 'Joining your team on Balo',
          summary: 'How signing up with your work email connects you to your company.',
        },
        {
          slug: 'switching-workspaces',
          title: 'Switching workspaces',
          summary: 'Move between your company and any other workspace you belong to.',
        },
      ],
    },
    {
      id: 'calls',
      title: 'Consultations and calls',
      blurb: 'Booking time with an expert and getting the most from the call.',
      articles: [
        {
          slug: 'booking-a-consultation',
          title: 'Booking a consultation',
          summary: 'Pick a time with an expert, choose a length and confirm the call.',
        },
        {
          slug: 'joining-a-call',
          title: 'Joining a call',
          summary: 'Getting into the call, admitting guests and sharing files while you talk.',
        },
        {
          slug: 'adding-to-your-calendar',
          title: 'Adding a consultation to your calendar',
          summary: 'The calendar invite Balo sends, and where changes actually happen.',
        },
        {
          slug: 'inviting-others',
          title: 'Inviting others to a consultation',
          summary: 'Bring in colleagues or outside guests, and what each of them can see.',
        },
        {
          slug: 'meeting-recap',
          title: 'Understanding your meeting recap',
          summary: 'The summary, transcript, action items and files from each call.',
        },
      ],
    },
    {
      id: 'cases-projects',
      title: 'Cases and projects',
      blurb: 'Ongoing work with an expert, from a single case to a scoped project.',
      articles: [
        {
          slug: 'your-cases',
          title: 'Your cases',
          summary: 'How cases are listed, what the coloured bands mean and when a case closes.',
        },
        {
          slug: 'requesting-a-project',
          title: 'Requesting a project',
          summary: 'Describe the work, get proposals from experts and choose one.',
        },
        {
          slug: 'turning-a-case-into-a-project',
          title: 'Turning a case into a project',
          summary: 'Start a project from a case without losing its history.',
        },
        {
          slug: 'sharing-a-proposal',
          title: 'Sharing a proposal with colleagues',
          summary: 'Send a proposal by email or as a PDF so others can review it.',
        },
        {
          slug: 'reviewing-a-finished-project',
          title: 'Reviewing a finished project',
          summary: 'Accept the work or ask for changes before the review window ends.',
        },
      ],
    },
    {
      id: 'credit-billing',
      title: 'Credit and billing',
      blurb: 'How prepaid credit works and how calls are charged.',
      articles: [
        {
          slug: 'buying-credit',
          title: 'Buying credit',
          summary: 'Top up your company’s credit and choose what happens when it runs low.',
        },
        {
          slug: 'redeeming-a-promo-code',
          title: 'Redeeming a promo code',
          summary: 'Add promo credit to your company without paying.',
        },
        {
          slug: 'how-calls-are-billed',
          title: 'How consultation time is billed',
          summary: 'Per-minute charges, the 15-minute minimum and where to find receipts.',
        },
        {
          slug: 'billing-settings',
          title: 'Billing settings',
          summary: 'Your saved card, billing email and low-balance setting.',
        },
      ],
    },
    {
      id: 'your-company',
      title: 'Your company',
      blurb: 'Who is in your company on Balo and how new people join.',
      articles: [
        {
          slug: 'managing-who-can-join',
          title: 'Managing who can join your company',
          summary: 'Your email domains, join modes and handling join requests.',
        },
      ],
    },
  ],
  expert: [
    {
      id: 'getting-started',
      title: 'Getting started',
      blurb: 'From your application to your first booking.',
      articles: [
        {
          slug: 'what-happens-after-you-apply',
          title: 'What happens after you apply',
          summary: 'How we review applications and what happens either way.',
        },
        {
          slug: 'rate-and-payouts',
          title: 'Setting your rate and payout details',
          summary: 'Enter your rate and the bank details we pay you to.',
        },
        {
          slug: 'connecting-your-calendar',
          title: 'Connecting your calendar',
          summary: 'Link Google or Microsoft so clients only see times you’re free.',
        },
        {
          slug: 'weekly-schedule',
          title: 'Setting your weekly hours',
          summary: 'Your working hours, time off and timezone.',
        },
        {
          slug: 'working-through-an-agency',
          title: 'Working through an agency',
          summary: 'Joining or creating an agency, and how it shows to clients.',
        },
      ],
    },
    {
      id: 'getting-booked',
      title: 'Getting booked',
      blurb: 'Being found by clients and choosing when you take on work.',
      articles: [
        {
          slug: 'not-in-search',
          title: 'Why am I not appearing in search?',
          summary: 'The six things that keep you listed, and what to fix.',
        },
        {
          slug: 'pausing-new-work',
          title: 'Pausing new work',
          summary: 'Stop new bookings for a while without losing your setup.',
        },
        {
          slug: 'your-calendar',
          title: 'Your calendar',
          summary: 'Your upcoming meetings and the times clients can still book.',
        },
      ],
    },
    {
      id: 'calls-cases',
      title: 'Calls and cases',
      blurb: 'Running consultations and keeping track of ongoing work.',
      articles: [
        {
          slug: 'joining-a-call',
          title: 'Joining a call',
          summary: 'Getting into the call, admitting guests and sharing files while you talk.',
        },
        {
          slug: 'your-cases',
          title: 'Your cases',
          summary: 'Every case clients have booked with you, and what each card tells you.',
        },
        {
          slug: 'meeting-recap',
          title: 'Understanding your meeting recap',
          summary: 'The summary, transcript, action items and files from each call.',
        },
      ],
    },
    {
      id: 'projects',
      title: 'Projects',
      blurb: 'Responding to requests and delivering scoped work.',
      articles: [
        {
          slug: 'project-requests',
          title: 'Responding to project requests',
          summary: 'Expressing interest, talking it through and sending a proposal.',
        },
        {
          slug: 'delivering-a-project',
          title: 'Delivering a project',
          summary: 'Milestones, delivery notes and asking the client to review.',
        },
      ],
    },
    {
      id: 'getting-paid',
      title: 'Getting paid',
      blurb: 'What you earn and when it reaches you.',
      articles: [
        {
          slug: 'how-pricing-works',
          title: 'How pricing works on Balo',
          summary: 'Your quote is what you’re paid. Balo adds its margin separately.',
        },
        {
          slug: 'your-earnings',
          title: 'Your earnings from consultations',
          summary: 'What you earned from each call, and its payout status.',
        },
      ],
    },
  ],
};

const ALL = {};
Object.values(CATEGORIES).forEach((cats) =>
  cats.forEach((c) =>
    c.articles.forEach((a) => {
      if (!ALL[a.slug]) ALL[a.slug] = a;
    })
  )
);
const findCategory = (audience, id) => CATEGORIES[audience].find((c) => c.id === id);

const ARTICLES = {
  'booking-a-consultation': {
    audience: 'client',
    category: 'calls',
    title: 'Booking a consultation',
    summary:
      'A consultation is a live video call with an expert, billed per minute from your company’s prepaid credit. Here’s how to book one.',
    updated: '14 October 2026',
    steps: [
      {
        title: 'Open the expert’s profile',
        short: 'Open the profile',
        body: 'Find the expert you’d like to talk to and choose **Book a consultation** on their profile. Every consultation belongs to a case, so your calls, messages and files with that expert stay in one place.',
        scene: 'profile',
        alt: 'An expert’s profile with the Book a consultation button highlighted.',
      },
      {
        title: 'Pick a time',
        short: 'Pick a time',
        body: 'Choose one of the expert’s open times. Times show in your device’s timezone.',
        scene: 'slots',
        alt: 'Open times across four days, with Wednesday at 10:30 am selected.',
      },
      {
        title: 'Choose a length and add a note',
        short: 'Choose a length',
        body: 'Pick **15, 30, 45 or 60 minutes**, then tell the expert what you’d like to discuss so they can prepare.',
        scene: 'duration',
        alt: 'Length options with 30 minutes selected, and a note to the expert below.',
      },
      {
        title: 'Choose the case',
        short: 'Choose the case',
        body: 'If you already have an open case with this expert, choose which case the call is for. To keep it separate, choose **Start a new case**.',
        scene: 'case',
        alt: 'Two options: an open case called Salesforce CPQ rollout, selected, and Start a new case.',
      },
      {
        title: 'Confirm the booking',
        short: 'Confirm',
        body: 'Check the details and choose **Confirm & book**.',
        scene: 'confirm',
        alt: 'A booking summary with the Confirm & book button highlighted.',
      },
    ],
    callout: {
      title: 'If an expert isn’t taking on new work',
      body: 'Their profile shows “Not taking on new work right now” instead of open times. You can find a similar expert, get matched for a project, or send them a message. If you already have an open case with them, you can still book follow-up consultations from that case’s page.',
    },
    related: ['joining-a-call', 'how-calls-are-billed', 'your-cases'],
  },
  'pausing-new-work': {
    audience: 'expert',
    category: 'getting-booked',
    title: 'Pausing new work',
    summary:
      'Need a break, or fully booked for a while? You can stop new work coming in without touching anything you’ve already set up.',
    updated: '3 October 2026',
    steps: [
      {
        title: 'Turn off Available for new work',
        short: 'Turn it off',
        body: 'Go to **Settings → Schedule** and turn off **Available for new work**.',
        scene: 'schedule-on',
        alt: 'Expert Settings on the Schedule tab, with the Available for new work switch highlighted.',
      },
      {
        title: 'Check what pausing changes',
        short: 'Check what changes',
        body: 'Before anything happens, we show you what pausing changes, including how many upcoming consultations and active projects you have. Choose **Pause new work** to confirm, or **Keep me available** to leave things as they are.',
        scene: 'pause-dialog',
        alt: 'A confirmation listing your upcoming work, with the Pause new work button highlighted.',
      },
      {
        title: 'What clients see while you’re paused',
        short: 'What clients see',
        body: 'Clients can’t book a new consultation or send you a project request directly, and you won’t be invited to new project requests. Search won’t show you as available. Your profile stays visible, and clients can still message you.',
        scene: 'paused-profile',
        alt: 'Your public profile with a hatched card saying Not taking on new work right now.',
      },
      {
        title: 'What carries on as normal',
        short: 'What carries on',
        body: 'Everything already booked or underway goes ahead as planned, and clients with an open case can still book follow-ups on it. On your **Calendar**, open hours show hatched while booked meetings stay in full colour, and you can still join them.',
        scene: 'calendar',
        alt: 'A week on your calendar with hatched open hours and a booked consultation in full colour.',
      },
      {
        title: 'Come back when you’re ready',
        short: 'Come back',
        body: 'Turn **Available for new work** back on. It takes effect straight away, and your weekly hours, booking rules and time off are exactly as you left them.',
        scene: 'schedule-off',
        alt: 'The Schedule tab while paused, with the Available for new work switch highlighted.',
      },
    ],
    callout: {
      title: 'Your calendar stays connected',
      body: 'Your calendar connection keeps syncing while you’re paused, so existing bookings and conflict checks stay correct.',
    },
    related: ['your-calendar', 'not-in-search', 'weekly-schedule'],
  },
};

// ── Page CSS (hover/focus states can't live in inline styles) ─────────
const buildCss = (t) => `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@300..800&display=swap');
.hb-root, .hb-root *, .hb-root *::before, .hb-root *::after { box-sizing: border-box; }
.hb-root a { color: inherit; text-decoration: none; }
.hb-root button:focus-visible, .hb-root a:focus-visible, .hb-root textarea:focus-visible {
  outline: 2px solid ${t.primary}; outline-offset: 2px;
}
.hb-row { display: flex; align-items: center; gap: 16px; padding: 14px 12px; margin: 0 -12px;
  border-radius: 10px; transition: background-color .15s ease; }
.hb-row:hover { background: ${t.mist}; }
.hb-row:hover .hb-row-title { color: ${t.primary} !important; }
.hb-row .hb-chev { display: flex; color: ${t.faint}; transition: transform .15s ease, color .15s ease; }
.hb-row:hover .hb-chev { color: ${t.primary}; transform: translateX(2px); }
.hb-topic:hover { color: ${t.ink} !important; background: ${t.mist}; }
.hb-crumb:hover { color: ${t.ink} !important; text-decoration: underline; text-underline-offset: 3px; }
.hb-btn:hover { background: ${t.mist} !important; }
.hb-rail-btn:hover .hb-rail-label { color: ${t.ink} !important; }
.hb-tab { transition: flex-grow .42s ${EASE}; }
.hb-tab-title { transition: font-size .42s ${EASE}; }
.hb-tab[aria-selected="false"]:hover .hb-tab-title { text-decoration: underline; text-underline-offset: 4px; }
@keyframes hbFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.hb-fade { animation: hbFade .32s ${EASE} both; }
@keyframes hbToast { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
@media (prefers-reduced-motion: reduce) {
  .hb-root *, .hb-root *::before, .hb-root *::after { animation: none !important; transition: none !important; }
}
`;

const btnStyle = (t) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 14px',
  borderRadius: 10,
  border: `1px solid ${t.line}`,
  background: t.card,
  color: t.ink,
  fontSize: 14,
  fontWeight: 600,
  fontFamily: 'inherit',
  cursor: 'pointer',
  textDecoration: 'none',
});

// ── Marketing chrome (schematic: the real header/footer exist, BAL-502) ─
function SiteHeader({ t, viewer, isMobile, goHome }) {
  return (
    <header style={{ borderBottom: `1px solid ${t.lineSoft}`, background: t.page }}>
      <div
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: isMobile ? '14px 20px' : '16px 40px',
          display: 'flex',
          alignItems: 'center',
          gap: 32,
        }}
      >
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 19,
            fontWeight: 750,
            letterSpacing: '-0.03em',
            color: t.ink,
          }}
        >
          <span style={{ width: 18, height: 18, borderRadius: 6, background: grad(t) }} />
          balo
        </span>
        {!isMobile && (
          <nav aria-label="Main" style={{ display: 'flex', gap: 24, fontSize: 14, color: t.sub }}>
            <span>How it works</span>
            <span>Pricing</span>
            <span>For experts</span>
            <a
              href="/help"
              aria-current="page"
              onClick={(e) => {
                e.preventDefault();
                goHome();
              }}
              style={{ color: t.ink, fontWeight: 600 }}
            >
              Help
            </a>
          </nav>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          {isMobile ? (
            <span style={{ display: 'flex', color: t.ink }}>
              <I.menu size={22} />
            </span>
          ) : viewer === 'visitor' ? (
            <>
              <span style={{ fontSize: 14, fontWeight: 600, color: t.ink }}>Sign in</span>
              <span
                style={{
                  padding: '8px 16px',
                  borderRadius: 10,
                  background: grad(t),
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                Get started
              </span>
            </>
          ) : (
            <>
              <span style={{ fontSize: 14, fontWeight: 600, color: t.ink }}>Go to dashboard</span>
              <span
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 999,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  color: t.primary,
                  background: t.primarySoft,
                }}
              >
                SK
              </span>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function SiteFooter({ t, isMobile }) {
  return (
    <footer style={{ borderTop: `1px solid ${t.lineSoft}`, marginTop: 24 }}>
      <div
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: isMobile ? '20px' : '22px 40px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 22px',
          fontSize: 13,
          color: t.sub,
        }}
      >
        <span>© 2026 Balo Technologies</span>
        <span style={{ marginLeft: isMobile ? 0 : 'auto' }}>Privacy</span>
        <span>Terms</span>
        <span style={{ color: t.ink, fontWeight: 600 }}>Help</span>
      </div>
    </footer>
  );
}

// ── Shared blocks ────────────────────────────────────────────────────
function SupportBlock({ t, isMobile }) {
  return (
    <section
      aria-labelledby="hb-support"
      style={{
        marginTop: 56,
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        alignItems: isMobile ? 'flex-start' : 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '22px 24px',
        borderRadius: 16,
        background: t.mist,
        border: `1px solid ${t.line}`,
      }}
    >
      <div>
        <h2 id="hb-support" style={{ margin: 0, fontSize: 18, fontWeight: 700, color: t.ink }}>
          Still stuck?
        </h2>
        <p style={{ margin: '4px 0 0', fontSize: 15, lineHeight: 1.5, color: t.body }}>
          Reach us any time at support@getbalo.com.
        </p>
      </div>
      <a
        href="mailto:support@getbalo.com"
        className="hb-btn"
        style={{ ...btnStyle(t), padding: '10px 16px' }}
      >
        <I.mail size={16} />
        Email support
      </a>
    </section>
  );
}

function ArticleRows({ t, items, onOpen }) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, borderTop: `1px solid ${t.lineSoft}` }}>
      {items.map((a) => (
        <li key={a.slug} style={{ borderBottom: `1px solid ${t.lineSoft}` }}>
          <a
            href={`/help/${a.slug}`}
            className="hb-row"
            onClick={(e) => {
              e.preventDefault();
              onOpen(a.slug);
            }}
          >
            <span style={{ flex: 1, minWidth: 0, display: 'block' }}>
              <span
                className="hb-row-title"
                style={{
                  display: 'block',
                  fontSize: 16,
                  fontWeight: 600,
                  lineHeight: 1.35,
                  color: t.ink,
                  transition: 'color .15s ease',
                }}
              >
                {a.title}
              </span>
              <span
                style={{
                  display: 'block',
                  marginTop: 3,
                  fontSize: 14,
                  lineHeight: 1.5,
                  color: t.sub,
                }}
              >
                {a.summary}
              </span>
            </span>
            <span className="hb-chev">
              <I.chevronRight size={18} />
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

// ── LIST PAGE: /help ─────────────────────────────────────────────────
// The split is a real tablist: it filters the panel below, ?for= keeps the
// choice in the URL, arrow keys move between the two sides.
function AudienceSplit({ t, audience, onChange, isMobile }) {
  const refs = useRef({});
  const tabs = [
    {
      key: 'client',
      title: 'I’m hiring experts',
      sub: 'Booking consultations, running projects, credit and billing.',
      bg: t.mist,
      ink: t.ink,
      subInk: t.sub,
      border: t.line,
    },
    {
      key: 'expert',
      title: 'I work as an expert',
      sub: 'Getting approved, getting booked, delivering projects and getting paid.',
      bg: t.night,
      ink: t.nightInk,
      subInk: t.nightSub,
      border: t.night,
    },
  ];
  const onKey = (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = audience === 'client' ? 'expert' : 'client';
    onChange(next);
    if (refs.current[next]) refs.current[next].focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Who the guides are for"
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        gap: isMobile ? 8 : 12,
      }}
    >
      {tabs.map((tab) => {
        const sel = tab.key === audience;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              refs.current[tab.key] = el;
            }}
            type="button"
            role="tab"
            id={`hb-tab-${tab.key}`}
            aria-selected={sel}
            aria-controls="hb-panel"
            tabIndex={sel ? 0 : -1}
            onClick={() => onChange(tab.key)}
            onKeyDown={onKey}
            className="hb-tab"
            style={{
              flexGrow: isMobile ? 0 : sel ? 1.7 : 1,
              flexBasis: 0,
              position: 'relative',
              overflow: 'hidden',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'flex-end',
              minHeight: isMobile ? 0 : 172,
              padding: isMobile ? (sel ? '20px 20px 24px' : '16px 20px') : '28px 28px 32px',
              borderRadius: 18,
              border: `1px solid ${tab.border}`,
              background: tab.bg,
              color: tab.ink,
              textAlign: 'left',
              fontFamily: 'inherit',
              cursor: sel ? 'default' : 'pointer',
            }}
          >
            <span
              className="hb-tab-title"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: sel ? (isMobile ? 22 : 30) : isMobile ? 16 : 20,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.15,
              }}
            >
              {tab.title}
              {!sel && <I.chevronRight size={isMobile ? 16 : 18} />}
            </span>
            {sel && (
              <span
                className="hb-fade"
                style={{
                  marginTop: 10,
                  fontSize: 15,
                  lineHeight: 1.5,
                  color: tab.subInk,
                  maxWidth: 420,
                }}
              >
                {tab.sub}
              </span>
            )}
            {sel && (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  height: 4,
                  background: `linear-gradient(90deg, ${t.primary}, ${t.violet})`,
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function HelpIndex({ t, audience, setAudience, isMobile, openArticle, focusTopic, clearFocus }) {
  const cats = CATEGORIES[audience];

  useEffect(() => {
    if (!focusTopic) return;
    const el = document.getElementById(`topic-${focusTopic}`);
    if (el) el.scrollIntoView({ block: 'start' });
    clearFocus();
  }, [focusTopic, clearFocus]);

  return (
    <main
      style={{
        maxWidth: 1080,
        margin: '0 auto',
        padding: isMobile ? '28px 20px 48px' : '52px 40px 72px',
      }}
    >
      <h1
        style={{
          margin: 0,
          fontSize: isMobile ? 30 : 40,
          fontWeight: 750,
          letterSpacing: '-0.03em',
          lineHeight: 1.1,
          color: t.ink,
        }}
      >
        Balo help
      </h1>
      <p
        style={{
          margin: '10px 0 0',
          fontSize: isMobile ? 16 : 17,
          lineHeight: 1.55,
          color: t.sub,
          maxWidth: 560,
        }}
      >
        Step-by-step guides for using Balo. Pick whether you hire experts or work as one.
      </p>

      <div style={{ marginTop: isMobile ? 24 : 32 }}>
        <AudienceSplit t={t} audience={audience} onChange={setAudience} isMobile={isMobile} />
      </div>

      <div
        key={audience}
        id="hb-panel"
        role="tabpanel"
        aria-labelledby={`hb-tab-${audience}`}
        className="hb-fade"
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 56,
          marginTop: isMobile ? 32 : 52,
        }}
      >
        {!isMobile && (
          <nav
            aria-label="Topics"
            style={{ width: 196, flexShrink: 0, position: 'sticky', top: 24 }}
          >
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
              {cats.map((c) => (
                <li key={c.id}>
                  <a
                    href={`#topic-${c.id}`}
                    className="hb-topic"
                    onClick={(e) => {
                      e.preventDefault();
                      scrollToId(`topic-${c.id}`);
                    }}
                    style={{
                      display: 'block',
                      padding: '7px 10px',
                      margin: '0 -10px',
                      borderRadius: 8,
                      fontSize: 14,
                      fontWeight: 500,
                      color: t.sub,
                    }}
                  >
                    {c.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          {cats.map((c, ci) => (
            <section
              key={c.id}
              id={`topic-${c.id}`}
              aria-labelledby={`topic-${c.id}-title`}
              style={{ scrollMarginTop: 24, paddingTop: ci === 0 ? 0 : 44 }}
            >
              <h2
                id={`topic-${c.id}-title`}
                style={{
                  margin: 0,
                  fontSize: 20,
                  fontWeight: 700,
                  letterSpacing: '-0.015em',
                  color: t.ink,
                }}
              >
                {c.title}
              </h2>
              <p style={{ margin: '4px 0 12px', fontSize: 14, lineHeight: 1.5, color: t.sub }}>
                {c.blurb}
              </p>
              <ArticleRows t={t} items={c.articles} onOpen={(slug) => openArticle(slug)} />
            </section>
          ))}
          <SupportBlock t={t} isMobile={isMobile} />
        </div>
      </div>
    </main>
  );
}

// ── Screenshot frame, ring and schematic scenes ──────────────────────
// In production each scene is a PNG captured by Playwright with the ring
// drawn by the capture script. These schematics only show the spec.
function Shot({ t, alt, isMobile, children }) {
  return (
    <figure style={{ margin: '20px 0 0' }}>
      <div
        role="img"
        aria-label={alt}
        style={{
          border: `1px solid ${t.line}`,
          borderRadius: 14,
          background: t.mist,
          padding: isMobile ? 14 : 22,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            background: t.card,
            border: `1px solid ${t.lineSoft}`,
            borderRadius: 10,
            boxShadow: t.shotShadow,
          }}
        >
          {children}
        </div>
      </div>
    </figure>
  );
}

function Ring({ t, n, block, radius = 10, children }) {
  return (
    <span
      style={{
        position: 'relative',
        display: block ? 'block' : 'inline-block',
        borderRadius: radius,
        boxShadow: `0 0 0 2px ${t.card}, 0 0 0 4px ${t.primary}, 0 0 0 9px ${t.ringGlow}`,
      }}
    >
      {children}
      <span
        style={{
          position: 'absolute',
          top: -11,
          right: -11,
          width: 22,
          height: 22,
          borderRadius: 999,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: grad(t),
          color: '#fff',
          fontSize: 11,
          fontWeight: 700,
          boxShadow: `0 0 0 2px ${t.card}`,
        }}
      >
        {n}
      </span>
    </span>
  );
}

const Bar = ({ t, w, h = 8 }) => (
  <span
    style={{
      display: 'block',
      width: w,
      maxWidth: '100%',
      height: h,
      borderRadius: h / 2,
      background: t.lineSoft,
    }}
  />
);
const SLabel = ({ t, children }) => (
  <div style={{ fontSize: 12.5, fontWeight: 600, color: t.ink }}>{children}</div>
);
const Chip = ({ t, active, big, children }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: big ? '6px 12px' : '4px 9px',
      borderRadius: 999,
      fontSize: big ? 12 : 11,
      fontWeight: 600,
      border: `1px solid ${active ? t.primary : t.line}`,
      background: active ? t.primarySoft : t.card,
      color: active ? t.primary : t.sub,
    }}
  >
    {children}
  </span>
);
const SBtn = ({ t, kind = 'grad', full, children }) => {
  const kinds = {
    grad: { background: grad(t), color: '#fff', border: '1px solid transparent' },
    solid: { background: t.primary, color: '#fff', border: '1px solid transparent' },
    outline: { background: t.card, color: t.ink, border: `1px solid ${t.line}` },
  };
  return (
    <span
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: full ? '100%' : 'auto',
        padding: '8px 12px',
        borderRadius: 9,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        ...kinds[kind],
      }}
    >
      {children}
    </span>
  );
};
const Avatar = ({ t, initials }) => (
  <span
    style={{
      width: 42,
      height: 42,
      borderRadius: 999,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 14,
      fontWeight: 700,
      color: t.primary,
      background: `linear-gradient(135deg, ${t.primary}26, ${t.violet}26)`,
    }}
  >
    {initials}
  </span>
);
const Radio = ({ t, on }) => (
  <span
    style={{
      width: 15,
      height: 15,
      marginTop: 1,
      borderRadius: 999,
      flexShrink: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      border: `1.5px solid ${on ? t.primary : t.line}`,
      background: t.card,
    }}
  >
    {on && <span style={{ width: 7, height: 7, borderRadius: 999, background: t.primary }} />}
  </span>
);
const Toggle = ({ t, on }) => (
  <span
    style={{
      width: 36,
      height: 20,
      padding: 2,
      borderRadius: 999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: on ? 'flex-end' : 'flex-start',
      background: on ? t.primary : t.line,
    }}
  >
    <span
      style={{
        width: 16,
        height: 16,
        borderRadius: 999,
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
      }}
    />
  </span>
);

const ExpertIdentity = ({ t }) => (
  <>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Avatar t={t} initials="PR" />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.ink }}>Priya Raman</div>
        <div style={{ fontSize: 12, color: t.sub, marginTop: 2 }}>
          Salesforce CPQ and Revenue Cloud
        </div>
      </div>
    </div>
    <div style={{ display: 'grid', gap: 7, marginTop: 16 }}>
      <Bar t={t} w="100%" />
      <Bar t={t} w="94%" />
      <Bar t={t} w="58%" />
    </div>
  </>
);

function ProfileScene({ t, n }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, padding: 18 }}>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <ExpertIdentity t={t} />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
          {['CPQ', 'Revenue Cloud', 'Sales Cloud'].map((x) => (
            <Chip key={x} t={t}>
              {x}
            </Chip>
          ))}
        </div>
      </div>
      <div
        style={{
          flex: '1 1 170px',
          maxWidth: 230,
          border: `1px solid ${t.line}`,
          borderRadius: 12,
          padding: 14,
        }}
      >
        <SLabel t={t}>Talk to Priya</SLabel>
        <div style={{ display: 'grid', gap: 6, margin: '10px 0 16px' }}>
          <Bar t={t} w="80%" />
          <Bar t={t} w="52%" />
        </div>
        <Ring t={t} n={n} block>
          <SBtn t={t} full>
            Book a consultation
          </SBtn>
        </Ring>
      </div>
    </div>
  );
}

function SlotsScene({ t, n }) {
  const days = [
    { d: 'Mon', date: '20 Oct', slots: ['9:00 am', '11:30 am', '2:00 pm'] },
    { d: 'Tue', date: '21 Oct', slots: ['10:00 am', '1:30 pm'] },
    { d: 'Wed', date: '22 Oct', slots: ['9:30 am', '10:30 am', '3:00 pm'] },
    { d: 'Thu', date: '23 Oct', slots: ['11:00 am', '4:30 pm'] },
  ];
  return (
    <div style={{ padding: 18 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <SLabel t={t}>Pick a time</SLabel>
        <span style={{ fontSize: 11.5, color: t.sub }}>Times in your timezone (AEDT)</span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 8,
          marginTop: 14,
        }}
      >
        {days.map((day) => (
          <div key={day.d} style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
            <div style={{ textAlign: 'center', marginBottom: 2 }}>
              <div style={{ fontSize: 11.5, fontWeight: 600, color: t.ink }}>{day.d}</div>
              <div style={{ fontSize: 10.5, color: t.sub }}>{day.date}</div>
            </div>
            {day.slots.map((s) => {
              const target = day.d === 'Wed' && s === '10:30 am';
              const pill = (
                <span
                  style={{
                    display: 'block',
                    textAlign: 'center',
                    padding: '6px 2px',
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    border: `1px solid ${target ? t.primary : t.line}`,
                    background: target ? t.primary : t.card,
                    color: target ? '#fff' : t.ink,
                  }}
                >
                  {s}
                </span>
              );
              return target ? (
                <Ring key={s} t={t} n={n} block radius={8}>
                  {pill}
                </Ring>
              ) : (
                <React.Fragment key={s}>{pill}</React.Fragment>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function DurationScene({ t, n }) {
  return (
    <div style={{ padding: 18 }}>
      <SLabel t={t}>How long?</SLabel>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 10 }}>
        {['15 min', '30 min', '45 min', '60 min'].map((d) =>
          d === '30 min' ? (
            <Ring key={d} t={t} n={n} radius={999}>
              <Chip t={t} active big>
                {d}
              </Chip>
            </Ring>
          ) : (
            <Chip key={d} t={t} big>
              {d}
            </Chip>
          )
        )}
      </div>
      <div style={{ marginTop: 18 }}>
        <SLabel t={t}>What would you like to discuss?</SLabel>
      </div>
      <div
        style={{
          marginTop: 8,
          minHeight: 64,
          padding: '10px 12px',
          border: `1px solid ${t.line}`,
          borderRadius: 10,
          fontSize: 12,
          lineHeight: 1.55,
          color: t.body,
        }}
      >
        We’re mid-way through a CPQ rollout and want a second opinion on our pricing rules.
      </div>
    </div>
  );
}

function CaseScene({ t, n }) {
  const opts = [
    { title: 'Salesforce CPQ rollout', sub: 'Open case, 2 consultations held', on: true },
    { title: 'Start a new case', sub: 'A separate thread with Priya', on: false },
  ];
  return (
    <div style={{ padding: 18 }}>
      <SLabel t={t}>Which case is this for?</SLabel>
      <div style={{ marginTop: 12 }}>
        <Ring t={t} n={n} block radius={12}>
          <div style={{ border: `1px solid ${t.line}`, borderRadius: 12, overflow: 'hidden' }}>
            {opts.map((o, i) => (
              <div
                key={o.title}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '12px 14px',
                  borderTop: i ? `1px solid ${t.line}` : 'none',
                  background: o.on ? t.primarySoft : t.card,
                }}
              >
                <Radio t={t} on={o.on} />
                <div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: t.ink }}>{o.title}</div>
                  <div style={{ fontSize: 11.5, color: t.sub, marginTop: 2 }}>{o.sub}</div>
                </div>
              </div>
            ))}
          </div>
        </Ring>
      </div>
    </div>
  );
}

function ConfirmScene({ t, n }) {
  const rows = [
    ['Expert', 'Priya Raman'],
    ['When', 'Wed 22 Oct, 10:30 am'],
    ['Length', '30 minutes'],
    ['Case', 'Salesforce CPQ rollout'],
  ];
  return (
    <div style={{ padding: 18, display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: 320 }}>
        <SLabel t={t}>Check your booking</SLabel>
        <div
          style={{
            marginTop: 10,
            padding: '4px 14px',
            border: `1px solid ${t.line}`,
            borderRadius: 12,
          }}
        >
          {rows.map(([k, v], i) => (
            <div
              key={k}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                padding: '9px 0',
                borderTop: i ? `1px solid ${t.lineSoft}` : 'none',
                fontSize: 12,
              }}
            >
              <span style={{ color: t.sub }}>{k}</span>
              <span style={{ color: t.ink, fontWeight: 600, textAlign: 'right' }}>{v}</span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 14 }}>
          <Ring t={t} n={n} block>
            <SBtn t={t} full>
              Confirm & book
            </SBtn>
          </Ring>
        </div>
      </div>
    </div>
  );
}

function ScheduleScene({ t, n, on }) {
  const days = [
    ['Mon', '9:00 am – 5:00 pm'],
    ['Tue', '9:00 am – 5:00 pm'],
    ['Wed', '9:00 am – 1:00 pm'],
  ];
  return (
    <div style={{ padding: '14px 18px 18px' }}>
      <div
        style={{
          display: 'flex',
          gap: 18,
          borderBottom: `1px solid ${t.line}`,
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {['Profile', 'Rate', 'Schedule', 'Payouts'].map((x) => (
          <span
            key={x}
            style={{
              padding: '0 0 9px',
              marginBottom: -1,
              color: x === 'Schedule' ? t.ink : t.sub,
              borderBottom: `2px solid ${x === 'Schedule' ? t.primary : 'transparent'}`,
            }}
          >
            {x}
          </span>
        ))}
      </div>
      <div
        style={{
          marginTop: 14,
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          border: `1px solid ${on ? t.line : t.pausedBorder}`,
          borderRadius: 12,
          ...(on ? {} : hatch(t)),
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: t.ink }}>
            Available for new work
          </div>
          <div style={{ fontSize: 11.5, color: t.sub, marginTop: 2 }}>
            {on
              ? 'Clients can book you and send you new projects.'
              : 'New work is paused. Your settings are kept.'}
          </div>
        </div>
        <Ring t={t} n={n} radius={999}>
          <Toggle t={t} on={on} />
        </Ring>
      </div>
      <div style={{ marginTop: 14, opacity: on ? 1 : 0.55 }}>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: t.sub, marginBottom: 6 }}>
          Weekly hours
        </div>
        {days.map(([d, h]) => (
          <div
            key={d}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '5px 0',
              fontSize: 12,
            }}
          >
            <span style={{ width: 34, fontWeight: 600, color: t.ink }}>{d}</span>
            <span
              style={{
                padding: '4px 10px',
                borderRadius: 8,
                border: `1px solid ${t.line}`,
                color: t.body,
              }}
            >
              {h}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PauseDialogScene({ t, n }) {
  return (
    <div
      style={{
        padding: '26px 18px',
        display: 'flex',
        justifyContent: 'center',
        background: t.scrim,
        borderRadius: 10,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 340,
          padding: 18,
          background: t.card,
          border: `1px solid ${t.line}`,
          borderRadius: 14,
          boxShadow: t.shotShadow,
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, color: t.ink }}>Pause new work?</div>
        <p style={{ margin: '8px 0 0', fontSize: 12, lineHeight: 1.55, color: t.body }}>
          You have 3 upcoming consultations and 1 active project. They go ahead as planned. Clients
          just can’t start anything new with you.
        </p>
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
            gap: 10,
            marginTop: 16,
          }}
        >
          <SBtn t={t} kind="outline">
            Keep me available
          </SBtn>
          <Ring t={t} n={n}>
            <SBtn t={t} kind="solid">
              Pause new work
            </SBtn>
          </Ring>
        </div>
      </div>
    </div>
  );
}

function PausedProfileScene({ t, n }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, padding: 18 }}>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <ExpertIdentity t={t} />
      </div>
      <div style={{ flex: '1 1 170px', maxWidth: 240 }}>
        <Ring t={t} n={n} block radius={12}>
          <div
            style={{
              ...hatch(t),
              padding: 14,
              border: `1px solid ${t.pausedBorder}`,
              borderRadius: 12,
            }}
          >
            <SLabel t={t}>Not taking on new work right now</SLabel>
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              <SBtn t={t} kind="outline" full>
                Find a similar expert
              </SBtn>
              <SBtn t={t} kind="outline" full>
                Send a message
              </SBtn>
            </div>
          </div>
        </Ring>
      </div>
    </div>
  );
}

function CalendarScene({ t, n }) {
  const days = ['Mon 20', 'Tue 21', 'Wed 22', 'Thu 23', 'Fri 24'];
  const hours = ['9 am', '10 am', '11 am', '12 pm'];
  const open = [
    [1, 1, 1, 0, 1],
    [1, 0, 1, 1, 1],
    [1, 1, 0, 1, 1],
    [0, 1, 1, 1, 0],
  ];
  const cell = { display: 'block', height: 38, borderRadius: 7 };
  return (
    <div style={{ padding: 14 }}>
      <div
        style={{ display: 'grid', gridTemplateColumns: '36px repeat(5, minmax(0, 1fr))', gap: 4 }}
      >
        <span />
        {days.map((d) => (
          <span
            key={d}
            style={{
              paddingBottom: 4,
              fontSize: 10.5,
              fontWeight: 600,
              color: t.sub,
              textAlign: 'center',
            }}
          >
            {d}
          </span>
        ))}
        {hours.map((h, r) => (
          <React.Fragment key={h}>
            <span style={{ paddingTop: 3, fontSize: 10, color: t.sub }}>{h}</span>
            {days.map((d, c) =>
              r === 1 && c === 1 ? (
                <Ring key={d} t={t} n={n} block radius={7}>
                  <span
                    style={{
                      ...cell,
                      padding: '4px 6px',
                      overflow: 'hidden',
                      background: t.primarySoft,
                      borderLeft: `3px solid ${t.primary}`,
                      fontSize: 10,
                      fontWeight: 600,
                      lineHeight: 1.25,
                      color: t.ink,
                    }}
                  >
                    Northwind consultation
                  </span>
                </Ring>
              ) : (
                <span
                  key={d}
                  style={{
                    ...cell,
                    border: `1px solid ${t.lineSoft}`,
                    ...(open[r][c] ? hatch(t) : {}),
                  }}
                />
              )
            )}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function renderScene(name, t, n) {
  switch (name) {
    case 'profile':
      return <ProfileScene t={t} n={n} />;
    case 'slots':
      return <SlotsScene t={t} n={n} />;
    case 'duration':
      return <DurationScene t={t} n={n} />;
    case 'case':
      return <CaseScene t={t} n={n} />;
    case 'confirm':
      return <ConfirmScene t={t} n={n} />;
    case 'schedule-on':
      return <ScheduleScene t={t} n={n} on />;
    case 'schedule-off':
      return <ScheduleScene t={t} n={n} on={false} />;
    case 'pause-dialog':
      return <PauseDialogScene t={t} n={n} />;
    case 'paused-profile':
      return <PausedProfileScene t={t} n={n} />;
    case 'calendar':
      return <CalendarScene t={t} n={n} />;
    default:
      return null;
  }
}

// ── GUIDE PAGE: /help/[slug] ─────────────────────────────────────────
function Breadcrumbs({ t, items }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          fontSize: 13.5,
        }}
      >
        {items.map((it, i) => (
          <li key={it.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <I.chevronRight size={14} style={{ color: t.faint }} />}
            <a
              href={it.href}
              className="hb-crumb"
              onClick={(e) => {
                e.preventDefault();
                it.onClick();
              }}
              style={{ color: t.sub }}
            >
              {it.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// Same encoding as the split: mist for clients, night for experts.
const AudienceChip = ({ t, audience }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '4px 10px',
      borderRadius: 999,
      fontSize: 12.5,
      fontWeight: 600,
      background: audience === 'expert' ? t.night : t.mist,
      color: audience === 'expert' ? t.nightInk : t.ink,
      border: `1px solid ${audience === 'expert' ? t.night : t.line}`,
    }}
  >
    {audience === 'expert' ? 'For experts' : 'For clients'}
  </span>
);

// The rail's connector fills to the section you're reading.
function SectionRail({ t, steps, active, onJump }) {
  const ITEM = 44;
  return (
    <nav
      aria-label="Sections in this guide"
      style={{ width: 216, flexShrink: 0, position: 'sticky', top: 24, paddingTop: 4 }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: t.sub, marginBottom: 14 }}>
        In this guide
      </div>
      <div style={{ position: 'relative' }}>
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 11,
            top: 12,
            width: 2,
            height: (steps.length - 1) * ITEM,
            borderRadius: 2,
            background: t.line,
          }}
        />
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 11,
            top: 12,
            width: 2,
            height: active * ITEM,
            borderRadius: 2,
            background: `linear-gradient(180deg, ${t.primary}, ${t.violet})`,
            transition: `height .3s ${EASE}`,
          }}
        />
        <ol style={{ position: 'relative', listStyle: 'none', margin: 0, padding: 0 }}>
          {steps.map((s, i) => {
            const on = i === active;
            const done = i < active;
            return (
              <li key={s.title} style={{ height: ITEM }}>
                <button
                  type="button"
                  className="hb-rail-btn"
                  aria-current={on ? 'location' : undefined}
                  onClick={() => onJump(i)}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 12,
                    width: '100%',
                    padding: 0,
                    background: 'none',
                    border: 'none',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      width: 24,
                      height: 24,
                      flexShrink: 0,
                      borderRadius: 999,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 11.5,
                      fontWeight: 700,
                      fontVariantNumeric: 'tabular-nums',
                      background: on ? grad(t) : t.page,
                      color: on ? '#fff' : done ? t.primary : t.sub,
                      border: on ? 'none' : `1.5px solid ${done ? t.primary : t.line}`,
                      transition: 'background .2s ease, color .2s ease',
                    }}
                  >
                    {i + 1}
                  </span>
                  <span
                    className="hb-rail-label"
                    style={{
                      fontSize: 13.5,
                      lineHeight: '24px',
                      fontWeight: on ? 600 : 500,
                      color: on ? t.ink : t.sub,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {s.short}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}

function MobileJump({ t, steps, onJump }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 24, border: `1px solid ${t.line}`, borderRadius: 12 }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="hb-jump"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 14px',
          background: 'none',
          border: 'none',
          fontFamily: 'inherit',
          fontSize: 14,
          fontWeight: 600,
          color: t.ink,
          cursor: 'pointer',
        }}
      >
        In this guide
        <span
          style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 500, color: t.sub }}
        >
          {steps.length} sections
          <I.chevronDown
            size={16}
            style={{
              transform: open ? 'rotate(180deg)' : 'none',
              transition: 'transform .2s ease',
            }}
          />
        </span>
      </button>
      {open && (
        <ol id="hb-jump" style={{ listStyle: 'none', margin: 0, padding: '0 6px 8px' }}>
          {steps.map((s, i) => (
            <li key={s.title}>
              <button
                type="button"
                className="hb-btn"
                onClick={() => {
                  setOpen(false);
                  onJump(i);
                }}
                style={{
                  display: 'flex',
                  gap: 10,
                  width: '100%',
                  padding: '9px 8px',
                  borderRadius: 8,
                  border: 'none',
                  background: 'none',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  color: t.body,
                  cursor: 'pointer',
                }}
              >
                <span style={{ minWidth: 16, fontWeight: 700, color: t.primary }}>{i + 1}</span>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function SectionBlock({ t, step, i, isMobile }) {
  const n = i + 1;
  return (
    <section
      id={`step-${n}`}
      data-idx={i}
      aria-labelledby={`step-${n}-title`}
      style={{ scrollMarginTop: 24, paddingTop: i === 0 ? 0 : 52 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span
          aria-hidden="true"
          style={{
            width: 30,
            height: 30,
            flexShrink: 0,
            borderRadius: 999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13.5,
            fontWeight: 700,
            background: t.primarySoft,
            color: t.primary,
          }}
        >
          {n}
        </span>
        <h2
          id={`step-${n}-title`}
          style={{
            margin: 0,
            fontSize: isMobile ? 20 : 22,
            fontWeight: 700,
            letterSpacing: '-0.015em',
            lineHeight: 1.25,
            color: t.ink,
          }}
        >
          <span style={srOnly}>{`Section ${n}: `}</span>
          {step.title}
        </h2>
      </div>
      <p
        style={{
          margin: '12px 0 0',
          maxWidth: '64ch',
          fontSize: 16.5,
          lineHeight: 1.65,
          color: t.body,
        }}
      >
        {rich(step.body, t)}
      </p>
      {step.scene && (
        <Shot t={t} alt={step.alt} isMobile={isMobile}>
          {renderScene(step.scene, t, n)}
        </Shot>
      )}
    </section>
  );
}

function Callout({ t, title, body }) {
  return (
    <aside
      style={{
        marginTop: 52,
        display: 'flex',
        gap: 12,
        padding: '16px 18px',
        background: t.mist,
        border: `1px solid ${t.line}`,
        borderRadius: 14,
      }}
    >
      <span style={{ display: 'flex', marginTop: 2, color: t.primary }}>
        <I.info size={18} />
      </span>
      <div>
        <div style={{ fontSize: 15, fontWeight: 650, color: t.ink }}>{title}</div>
        <p style={{ margin: '6px 0 0', fontSize: 15, lineHeight: 1.6, color: t.body }}>
          {rich(body, t)}
        </p>
      </div>
    </aside>
  );
}

function Feedback({ t }) {
  const [state, setState] = useState('ask'); // ask | no | thanks | sent
  const [note, setNote] = useState('');
  return (
    <div
      aria-live="polite"
      style={{ marginTop: 56, paddingTop: 28, borderTop: `1px solid ${t.line}` }}
    >
      {state === 'ask' && (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 14 }}>
          <span style={{ fontSize: 15, fontWeight: 600, color: t.ink }}>Did this guide help?</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="hb-btn"
              onClick={() => setState('thanks')}
              style={btnStyle(t)}
            >
              <I.thumbsUp size={15} />
              Yes
            </button>
            <button
              type="button"
              className="hb-btn"
              onClick={() => setState('no')}
              style={btnStyle(t)}
            >
              <I.thumbsDown size={15} />
              No
            </button>
          </div>
        </div>
      )}
      {state === 'no' && (
        <div>
          <label htmlFor="hb-feedback" style={{ fontSize: 15, fontWeight: 600, color: t.ink }}>
            What were you trying to do?
          </label>
          <p style={{ margin: '4px 0 10px', fontSize: 14, color: t.sub }}>
            Optional. It goes to the team that writes these guides.
          </p>
          <textarea
            id="hb-feedback"
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            style={{
              width: '100%',
              padding: '10px 12px',
              resize: 'vertical',
              fontFamily: 'inherit',
              fontSize: 15,
              color: t.ink,
              background: t.card,
              border: `1px solid ${t.line}`,
              borderRadius: 10,
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button
              type="button"
              onClick={() => setState(note.trim() ? 'sent' : 'thanks')}
              style={{
                ...btnStyle(t),
                background: t.primary,
                color: '#fff',
                border: '1px solid transparent',
              }}
            >
              Send
            </button>
            <button
              type="button"
              className="hb-btn"
              onClick={() => setState('thanks')}
              style={btnStyle(t)}
            >
              Skip
            </button>
          </div>
        </div>
      )}
      {state === 'thanks' && (
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: t.ink }}>
          Thanks for letting us know.
        </p>
      )}
      {state === 'sent' && (
        <p style={{ margin: 0, fontSize: 15, fontWeight: 600, color: t.ink }}>
          Thanks. Your note will help us fix this guide.
        </p>
      )}
    </div>
  );
}

function HelpArticle({ t, slug, isMobile, goIndex, openArticle }) {
  const art = ARTICLES[slug];
  const [active, setActive] = useState(0);

  useEffect(() => {
    setActive(0);
  }, [slug]);

  // Scroll-spy for the rail (desktop only; mobile has the jump list).
  useEffect(() => {
    if (isMobile || typeof IntersectionObserver === 'undefined') return undefined;
    const els = art.steps.map((_, i) => document.getElementById(`step-${i + 1}`)).filter(Boolean);
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) setActive(Number(en.target.getAttribute('data-idx')));
        });
      },
      { rootMargin: '-20% 0px -70% 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [art, isMobile]);

  const jump = (i) => {
    scrollToId(`step-${i + 1}`);
    setActive(i);
  };
  const cat = findCategory(art.audience, art.category);
  const sideLabel = art.audience === 'expert' ? 'For experts' : 'For clients';

  return (
    <main
      style={{
        maxWidth: 1080,
        margin: '0 auto',
        padding: isMobile ? '24px 20px 48px' : '44px 40px 72px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 56 }}>
        {!isMobile && <SectionRail t={t} steps={art.steps} active={active} onJump={jump} />}
        <article style={{ flex: 1, minWidth: 0, maxWidth: 680 }}>
          <Breadcrumbs
            t={t}
            items={[
              { label: 'Help', href: '/help', onClick: () => goIndex(art.audience) },
              {
                label: sideLabel,
                href: `/help?for=${art.audience === 'expert' ? 'experts' : 'clients'}`,
                onClick: () => goIndex(art.audience),
              },
              {
                label: cat.title,
                href: `/help?for=${art.audience === 'expert' ? 'experts' : 'clients'}#topic-${cat.id}`,
                onClick: () => goIndex(art.audience, cat.id),
              },
            ]}
          />
          <h1
            style={{
              margin: '18px 0 0',
              fontSize: isMobile ? 30 : 38,
              fontWeight: 750,
              letterSpacing: '-0.03em',
              lineHeight: 1.12,
              color: t.ink,
            }}
          >
            {art.title}
          </h1>
          <p
            style={{
              margin: '12px 0 0',
              maxWidth: '60ch',
              fontSize: 18,
              lineHeight: 1.55,
              color: t.sub,
            }}
          >
            {art.summary}
          </p>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 12,
              marginTop: 18,
            }}
          >
            <AudienceChip t={t} audience={art.audience} />
            <span style={{ fontSize: 13.5, color: t.sub }}>Updated {art.updated}</span>
          </div>

          {isMobile && <MobileJump key={slug} t={t} steps={art.steps} onJump={jump} />}

          <div style={{ marginTop: isMobile ? 36 : 48 }}>
            {art.steps.map((s, i) => (
              <SectionBlock key={s.title} t={t} step={s} i={i} isMobile={isMobile} />
            ))}
          </div>

          {art.callout && <Callout t={t} title={art.callout.title} body={art.callout.body} />}

          <Feedback key={slug} t={t} />

          <section aria-labelledby="hb-related" style={{ marginTop: 48 }}>
            <h2
              id="hb-related"
              style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700, color: t.ink }}
            >
              Related guides
            </h2>
            <ArticleRows
              t={t}
              items={art.related.map((s) => ALL[s]).filter(Boolean)}
              onOpen={openArticle}
            />
          </section>

          <SupportBlock t={t} isMobile={isMobile} />
        </article>
      </div>
    </main>
  );
}

// ── Prototype shell (not part of the design) ─────────────────────────
const S = {
  bg: '#F4F5F8',
  surface: '#FFFFFF',
  border: '#E2E7EE',
  ink: '#0F172A',
  sub: '#5B6472',
  faint: '#8B93A1',
  accent: '#2563EB',
};

function Seg({ label, value, options, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: S.sub }}>{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        style={{
          display: 'inline-flex',
          padding: 3,
          borderRadius: 10,
          background: S.surface,
          border: `1px solid ${S.border}`,
        }}
      >
        {options.map((o) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(o.value)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 10px',
                borderRadius: 7,
                border: 'none',
                fontFamily: 'inherit',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                background: on ? S.ink : 'transparent',
                color: on ? '#fff' : S.sub,
              }}
            >
              {o.icon}
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const NOTES = [
  [
    'Routes',
    '/help lists guides for one side; ?for=clients or ?for=experts sets it. Without the param, default to the signed-in user’s active workspace (expert workspace → experts), otherwise clients. /help/[slug] is the guide. Both live in the (marketing) route group so they work signed in or out.',
  ],
  [
    'Source',
    'One markdown file per guide in docs/help/. Frontmatter drives the list (example below). Unpublished files never render and their URLs 404. The slug is the filename and never changes once published, because the product links straight to guides.',
  ],
  [
    'Sections',
    'Each ## heading in the file is a numbered section: its paragraphs, then one image. Numbers come from document order, not the file. A blockquote renders as the callout. Section anchors are #step-N so the product can deep-link to one section.',
  ],
  [
    'Screenshots',
    'Captured by Playwright against seeded data, never by hand. The capture script draws the ring around the control the section is about and badges it with the section number. Capture light and dark, and serve them with <picture> + prefers-color-scheme so a dark page never shows a white screenshot. Path: public/help/<slug>/<nn>.png. Alt text comes from the image line in the markdown.',
  ],
  [
    'Shared guides',
    'A guide with audience [client, expert] appears on both sides. Its breadcrumb follows the side the reader came from (?for= on the link).',
  ],
  [
    'Entry points',
    'Help in the marketing header and footer; a Help item inside the app; contextual links from product surfaces straight to a guide or section (the “How pricing works” popover is the first).',
  ],
  [
    'Analytics',
    'help_index_viewed {audience}; help_audience_switched {from, to}; help_article_viewed {slug, audience, source}; help_section_jumped {slug, section}; help_feedback_submitted {slug, helpful, has_comment}.',
  ],
  [
    'Not here on purpose',
    'Search (about 30 guides browse fine; add it when volume needs it), popular or trending lists, view counts, comments, and admin runbooks, which stay in Notion.',
  ],
  [
    'Copy',
    'MJ signs off every guide before published flips to true. No vendor names in guides; fee concealment applies.',
  ],
];

const FRONTMATTER = `---
title: Booking a consultation
summary: Pick a time with an expert, choose a length and confirm the call.
audience: [client]
category: calls
order: 1
published: true
updated: 2026-10-14
related: [joining-a-call, how-calls-are-billed, your-cases]
---`;

export default function HelpCentrePrototype() {
  const prefersDark =
    typeof window !== 'undefined' &&
    !!window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: dark)').matches;
  const [theme, setTheme] = useState(prefersDark ? 'dark' : 'light');
  const [device, setDevice] = useState('desktop');
  const [viewer, setViewer] = useState('visitor');
  const [view, setView] = useState('index');
  const [audience, setAudience] = useState('client');
  const [slug, setSlug] = useState('booking-a-consultation');
  const [focusTopic, setFocusTopic] = useState(null);
  const [toast, setToast] = useState(null);
  const [wrapW, setWrapW] = useState(1200);
  const wrapRef = useRef(null);
  const frameRef = useRef(null);

  const t = THEMES[theme];
  const isMobile = device === 'mobile' || wrapW < 820;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver((entries) => setWrapW(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  // New page → back to its top (unless we're landing on a topic).
  useEffect(() => {
    const f = frameRef.current;
    if (!f || focusTopic) return;
    if (device === 'mobile') {
      f.scrollTop = 0;
    } else {
      const top = f.getBoundingClientRect().top + window.scrollY;
      if (window.scrollY > top) window.scrollTo({ top });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, slug]);

  const changeViewer = (v) => {
    setViewer(v);
    if (v === 'client') setAudience('client');
    if (v === 'expert') setAudience('expert');
  };
  const openArticle = (s) => {
    if (ARTICLES[s]) {
      setSlug(s);
      setView('article');
    } else {
      setToast('Two guides are built out here: Booking a consultation and Pausing new work.');
    }
  };
  const goIndex = (aud, topic) => {
    if (aud) setAudience(aud);
    setFocusTopic(topic || null);
    setView('index');
  };
  const clearFocus = () => setFocusTopic(null);

  const page = (
    <div
      className="hb-root"
      style={{ fontFamily: FONT, color: t.ink, background: t.page, colorScheme: t.name }}
    >
      <SiteHeader t={t} viewer={viewer} isMobile={isMobile} goHome={() => goIndex()} />
      {view === 'index' ? (
        <HelpIndex
          t={t}
          audience={audience}
          setAudience={setAudience}
          isMobile={isMobile}
          openArticle={openArticle}
          focusTopic={focusTopic}
          clearFocus={clearFocus}
        />
      ) : (
        <HelpArticle
          t={t}
          slug={slug}
          isMobile={isMobile}
          goIndex={goIndex}
          openArticle={openArticle}
        />
      )}
      <SiteFooter t={t} isMobile={isMobile} />
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: S.bg, fontFamily: FONT, color: S.ink }}>
      <style>{buildCss(t)}</style>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '32px 20px 64px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>
          Help centre: list page and guide page
        </h1>
        <p
          style={{ margin: '6px 0 0', maxWidth: 680, fontSize: 14, lineHeight: 1.6, color: S.sub }}
        >
          /help and /help/[slug] on the marketing site. Pick a side on the list page, then open
          Booking a consultation (clients) or Pausing new work (experts) to see the guide template.
        </p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 22px', margin: '20px 0 18px' }}>
          <Seg
            label="Page"
            value={view}
            onChange={(v) => setView(v)}
            options={[
              { value: 'index', label: 'Help home' },
              { value: 'article', label: 'Guide' },
            ]}
          />
          {view === 'article' && (
            <Seg
              label="Guide"
              value={slug}
              onChange={(v) => setSlug(v)}
              options={[
                { value: 'booking-a-consultation', label: 'Booking a consultation' },
                { value: 'pausing-new-work', label: 'Pausing new work' },
              ]}
            />
          )}
          <Seg
            label="Signed in as"
            value={viewer}
            onChange={changeViewer}
            options={[
              { value: 'visitor', label: 'Nobody' },
              { value: 'client', label: 'Client' },
              { value: 'expert', label: 'Expert' },
            ]}
          />
          <Seg
            label="Theme"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light', icon: <I.sun size={13} /> },
              { value: 'dark', label: 'Dark', icon: <I.moon size={13} /> },
            ]}
          />
          <Seg
            label="Device"
            value={device}
            onChange={setDevice}
            options={[
              { value: 'desktop', label: 'Desktop', icon: <I.monitor size={13} /> },
              { value: 'mobile', label: 'Mobile', icon: <I.phone size={13} /> },
            ]}
          />
        </div>

        <div ref={wrapRef}>
          {device === 'mobile' ? (
            <div
              ref={frameRef}
              style={{
                width: 390,
                maxWidth: '100%',
                height: 780,
                margin: '0 auto',
                overflowY: 'auto',
                borderRadius: 28,
                border: `1px solid ${S.border}`,
                boxShadow: '0 12px 40px rgba(15,23,42,0.12)',
                background: t.page,
              }}
            >
              {page}
            </div>
          ) : (
            <div
              ref={frameRef}
              style={{
                borderRadius: 16,
                overflow: 'hidden',
                border: `1px solid ${S.border}`,
                boxShadow: '0 12px 40px rgba(15,23,42,0.08)',
                background: t.page,
              }}
            >
              {page}
            </div>
          )}
        </div>

        <div
          style={{
            marginTop: 32,
            padding: 22,
            background: S.surface,
            border: `1px solid ${S.border}`,
            borderRadius: 14,
          }}
        >
          <h2 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 700 }}>Build notes</h2>
          {NOTES.map(([title, body]) => (
            <div
              key={title}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '4px 16px',
                padding: '10px 0',
                borderBottom: `1px solid ${S.border}`,
              }}
            >
              <div style={{ minWidth: 140, fontSize: 12.5, fontWeight: 700, color: S.accent }}>
                {title}
              </div>
              <div style={{ flex: '1 1 380px', fontSize: 13, lineHeight: 1.6, color: S.sub }}>
                {body}
              </div>
            </div>
          ))}
          <pre
            style={{
              margin: '16px 0 0',
              padding: 14,
              overflowX: 'auto',
              background: S.bg,
              border: `1px solid ${S.border}`,
              borderRadius: 10,
              fontSize: 12,
              lineHeight: 1.6,
              color: S.ink,
            }}
          >
            {FRONTMATTER}
          </pre>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 24,
            zIndex: 50,
            maxWidth: '90vw',
            padding: '10px 16px',
            borderRadius: 10,
            background: S.ink,
            color: '#fff',
            fontFamily: FONT,
            fontSize: 13,
            boxShadow: '0 8px 24px rgba(15,23,42,0.25)',
            transform: 'translateX(-50%)',
            animation: 'hbToast .2s ease-out both',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
