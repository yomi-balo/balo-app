/*
  Balo — Navigation Explorer (design reference, not production code)

  STATUS — DECIDED via ADR-1053 (2026-08-29). This is the committed design reference for the
  app-shell navigation; it supersedes expert-dashboard-shell.jsx for shell-level decisions.
  ADR: https://app.notion.com/p/3ca45346cc7881f1b09fc6f677881313
  Build: Linear project "Navigation & App Shell" (BAL-494…BAL-503)

  Decided configuration = the canonical prototype state (the other toggle positions exist only
  to show the rejected alternatives — do not build them):
    Fork 1  context switcher → Workspace switcher        (mode pill: rejected)
    Fork 2  public pages     → B · Marketing chrome      (A · adaptive app shell: rejected)
    Fork 3  primary nav      → By engagement type        (by lifecycle: rejected)
    Mobile                   → Bottom tabs + More sheet  (hamburger drawer: removed)

  Corrections vs this prototype, found in the repo audit (repo wins):
    - Calendar page ships Week + Agenda only; the Availability tab shown here is dropped —
      availability editing already exists in Expert Settings → Schedule (see BAL-498).
    - Expert Settings has more tabs in the repo (expertise, certifications, work history,
      agency domains) than the four shown here; the repo is authoritative for that tab set.
  Covers: marketing (out/in), app shell client + expert, mobile bottom tabs + sheets,
  admin console, auth with return-to, full-screen call + background-call pill.
  Invariants demonstrated: same routes across lenses, capability-gated items, fee concealment
  (client sees rate/credits, expert sees earnings, margin admin-only).

  Motion spec (implementation targets):
    page enter        fade + 8px rise, 240ms, cubic-bezier(.4,0,.2,1)
    tabs              deliberately static — no underline slide, no panel fade, no press
                      scale, uniform font-weight (animated tabs read as jitter here)
    sidebar pill      slides between items, 260ms, same curve; collapse = width 240ms
    menus/popovers    scale .96 to 1 + fade, 140ms, origin at trigger
    mobile sheet      translateY 100% to 0, 300ms, cubic-bezier(.32,.72,0,1); scrim fade 200ms
    bottom tab        icon pop, 280ms overshoot curve
    buttons           gradient/solid hover lift 1px + shadow; press scale .97, 120-160ms
    ambient           live-call ping ring 1.8s; skeleton opacity pulse 1.8s
    accessibility     everything off under prefers-reduced-motion

  Fidelity note: colors/spacing approximate the shadcn new-york + slate system. The shipped
  look comes from repo components (shadcn Sidebar primitive, Geist, OKLCH tokens) — this file
  fixes structure, behaviour and motion, not final pixels.
*/
import { useState, useEffect, useLayoutEffect, useRef, Fragment } from 'react';

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;
import {
  LayoutDashboard,
  Search,
  Video,
  FolderKanban,
  MessageSquare,
  CalendarDays,
  Settings,
  SlidersHorizontal,
  LifeBuoy,
  Bell,
  ChevronsUpDown,
  Check,
  PanelLeft,
  Menu,
  X,
  MoreHorizontal,
  Inbox,
  Briefcase,
  LogOut,
  User,
  ShieldCheck,
  ArrowLeft,
  Mic,
  Camera,
  Monitor,
  PhoneOff,
  ChevronRight,
  Star,
  Sparkles,
  Users,
  Building2,
  Wallet,
  ScrollText,
  Tags,
  BellRing,
  ArrowUpRight,
  Plus,
  Minimize2,
  Clock,
  CircleCheck,
  Circle,
} from 'lucide-react';

/* ───────────────────────────── Balo tokens (shadcn new-york · slate · Geist) ───────────────────────────── */
const T = {
  font: "Geist, Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  primary: '#4f46e5',
  primaryLight: '#eef2ff',
  primaryBorder: '#c7d2fe',
  gradient: 'linear-gradient(90deg,#3b82f6 0%,#8b5cf6 100%)',
  gradientSubtle: 'linear-gradient(90deg,#eff6ff 0%,#f5f3ff 100%)',
  text: '#0f172a',
  text2: '#475569',
  text3: '#94a3b8',
  border: '#e2e8f0',
  muted: '#f8fafc',
  sk: '#eef2f7',
  green: '#059669',
  greenLight: '#ecfdf5',
  greenBorder: '#a7f3d0',
  red: '#ef4444',
  amber: '#b45309',
  amberLight: '#fffbeb',
  amberBorder: '#fde68a',
};

const STYLE = `
@keyframes bnFadeUp { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
@keyframes bnPop { from { opacity: 0; transform: scale(.96) translateY(-2px) } to { opacity: 1; transform: none } }
@keyframes bnSheet { from { transform: translateY(100%) } to { transform: none } }
@keyframes bnScrim { from { opacity: 0 } to { opacity: 1 } }
@keyframes bnSk { 0%,100% { opacity: 1 } 50% { opacity: .55 } }
@keyframes bnPing { 0% { transform: scale(.6); opacity: .9 } 80%,100% { transform: scale(2.1); opacity: 0 } }
@keyframes bnGrow { from { transform: scaleX(0) } to { transform: scaleX(1) } }
@keyframes bnTabPop { 0% { transform: scale(.8) } 55% { transform: scale(1.14) } 100% { transform: scale(1) } }
.bn-page { animation: bnFadeUp .24s cubic-bezier(.4,0,.2,1) both }
.bn-pop { animation: bnPop .14s cubic-bezier(.4,0,.2,1) both }
.bn-sheet { animation: bnSheet .3s cubic-bezier(.32,.72,0,1) both }
.bn-scrim { animation: bnScrim .2s ease both }
.bn-sk { animation: bnSk 1.8s ease-in-out infinite }
.bn-grow { animation: bnGrow .5s cubic-bezier(.4,0,.2,1) .15s both; transform-origin: left }
.bn-tabpop { animation: bnTabPop .28s cubic-bezier(.34,1.56,.64,1) both }
.bn-toast { animation: bnFadeUp .2s ease both }
.bn-rise { animation: bnFadeUp .24s ease both }
.bn-live { position: relative }
.bn-live::after { content: ""; position: absolute; inset: -3px; border-radius: 999px; border: 2px solid rgba(5,150,105,.45); animation: bnPing 1.8s cubic-bezier(0,0,.2,1) infinite }
.bn-dotping::after { content: ""; position: absolute; inset: -3px; border-radius: 999px; border: 2px solid rgba(239,68,68,.5); animation: bnPing 1.4s ease-out 2 }
.bn-press { transition: transform .12s ease }
.bn-press:active { transform: scale(.97) }
.bn-cta { transition: transform .16s ease, box-shadow .16s ease }
.bn-cta:hover { transform: translateY(-1px); box-shadow: 0 8px 20px rgba(99,102,241,.35) }
.bn-cta:active { transform: translateY(0) scale(.98) }
.bn-iconbtn { background: transparent; transition: background .15s ease, color .15s ease }
.bn-iconbtn:hover { background: rgba(15,23,42,.05) }
.bn-item { background: transparent; transition: color .15s ease, transform .12s ease }
.bn-item:not(.is-active):hover { background: rgba(15,23,42,.04) }
.bn-item:active { transform: scale(.985) }
.bn-link { transition: color .15s ease }
.bn-link:hover { color: #0f172a }
.bn-card { transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease }
.bn-card:hover { transform: translateY(-2px); box-shadow: 0 12px 28px rgba(15,23,42,.09); border-color: #cbd5e1 }
.bn-row { transition: background .14s ease }
.bn-row:hover { background: #f8fafc }
.bn-mi { background: transparent; transition: background .14s ease }
.bn-mi:hover { background: #f1f5f9 }
.bn-chip { transition: background .15s ease, color .15s ease, border-color .15s ease }
@media (prefers-reduced-motion: reduce) {
  .bn-page,.bn-pop,.bn-sheet,.bn-scrim,.bn-sk,.bn-grow,.bn-tabpop,.bn-toast,.bn-rise { animation: none !important }
  .bn-live::after,.bn-dotping::after { display: none }
  * { transition: none !important }
}
`;

/* ───────────────────────────── model ───────────────────────────── */
const WS = {
  expert: {
    key: 'expert',
    name: 'Yomi Joseph',
    sub: 'Expert workspace',
    initials: 'YJ',
    mode: 'expert',
  },
  acme: { key: 'acme', name: 'Acme Corp', sub: 'Client · Member', initials: 'AC', mode: 'client' },
  globex: {
    key: 'globex',
    name: 'Globex',
    sub: 'Client · Representing',
    initials: 'GX',
    mode: 'client',
    represented: true,
  },
};

const PAGE_META = {
  home: { title: 'Home', pub: true, marketingOnly: true },
  experts: { title: 'Find experts', pub: true },
  expertProfile: { title: 'Priya Nair', pub: true },
  auth: { title: 'Sign in' },
  dashboard: { title: 'Dashboard' },
  consultations: { title: 'Consultations', tabs: ['Upcoming', 'Past', 'Requests'] },
  projects: { title: 'Projects', tabs: ['Active', 'Proposals', 'Requests'] },
  inbox: { title: 'Inbox', tabs: ['All', 'Requests', 'Proposals', 'Meetings'] },
  work: { title: 'Work', tabs: ['Active', 'Completed'] },
  calendar: { title: 'Calendar', tabs: ['Week', 'Month', 'Availability'] },
  messages: { title: 'Messages' },
  settings: { title: 'Settings', tabs: ['Company', 'Team', 'Credits & billing', 'Notifications'] },
  expertSettings: { title: 'Expert Settings', tabs: ['Profile', 'Rate', 'Schedule', 'Payouts'] },
  account: { title: 'Account', tabs: ['Profile', 'Security', 'Notifications'] },
  caseDetail: { title: 'Case #1042', tabs: ['Overview', 'Meetings', 'Files', 'Messages'] },
  admin: { title: 'Admin console' },
  inCall: { title: 'In call' },
};
const CHIP_LABEL = {
  home: 'Marketing home',
  expertProfile: 'Expert profile',
  caseDetail: 'Case detail',
  admin: 'Admin console',
  auth: 'Sign in',
};

const MOBILE_HIDDEN = ['projects', 'work'];
const ORG_MAP = {
  type: { inbox: 'consultations', work: 'projects' },
  lifecycle: { consultations: 'inbox', projects: 'work' },
};

function buildNav(mode, org) {
  const primary = [{ key: 'dashboard', label: 'Dashboard', short: 'Home', icon: LayoutDashboard }];
  if (mode === 'client')
    primary.push({
      key: 'experts',
      label: 'Find experts',
      short: 'Experts',
      icon: Search,
      leavesShell: true,
    });
  if (org === 'type') {
    primary.push({
      key: 'consultations',
      label: 'Consultations',
      short: 'Consults',
      icon: Video,
      badge: mode === 'expert' ? 1 : 0,
    });
    primary.push({
      key: 'projects',
      label: 'Projects',
      short: 'Projects',
      icon: FolderKanban,
      badge: mode === 'expert' ? 2 : 1,
    });
  } else {
    primary.push({ key: 'inbox', label: 'Inbox', short: 'Inbox', icon: Inbox, badge: 3 });
    primary.push({ key: 'work', label: 'Work', short: 'Work', icon: Briefcase });
  }
  if (mode === 'expert')
    primary.push({ key: 'calendar', label: 'Calendar', short: 'Calendar', icon: CalendarDays });
  primary.push({
    key: 'messages',
    label: 'Messages',
    short: 'Messages',
    icon: MessageSquare,
    badge: 3,
  });
  const secondary =
    mode === 'expert'
      ? [
          {
            key: 'expertSettings',
            label: 'Expert Settings',
            icon: SlidersHorizontal,
            setup: '3/5',
          },
          { key: 'help', label: 'Help', icon: LifeBuoy },
        ]
      : [
          { key: 'settings', label: 'Settings', icon: Settings },
          { key: 'help', label: 'Help', icon: LifeBuoy },
        ];
  return { primary, secondary };
}

function resolveShell(page, auth, fork2) {
  if (page === 'inCall') return 'call';
  if (page === 'auth') return 'auth';
  if (page === 'admin') return 'admin';
  const m = PAGE_META[page];
  if (m && m.pub) {
    if (auth === 'out' || m.marketingOnly) return 'marketing';
    return fork2 === 'adaptive' ? 'app' : 'marketing';
  }
  return auth === 'in' ? 'app' : 'auth';
}

function availablePages(auth, mode, org, isAdmin) {
  if (auth === 'out') return ['home', 'experts', 'expertProfile', 'auth'];
  const l = ['dashboard', 'experts', 'expertProfile'];
  if (org === 'type') l.push('consultations', 'projects');
  else l.push('inbox', 'work');
  l.push('caseDetail');
  if (mode === 'expert') l.push('calendar');
  l.push(
    'messages',
    mode === 'expert' ? 'expertSettings' : 'settings',
    'account',
    'home',
    'inCall'
  );
  if (isAdmin) l.push('admin');
  return l;
}

function noteFor({ shell, page, auth, fork1, fork2, viewport, mode, ws }) {
  if (shell === 'call')
    return 'Full-screen call, no app chrome at all. Leave returns to the case; Minimize keeps the call running in the background.';
  if (shell === 'auth')
    return 'Logo-only chrome. Sign-in returns you to where you started (booking CTA → sign in → back on the profile).';
  if (shell === 'admin')
    return 'Separate shell and route group, reached only from the user menu. The one surface where both rates and the margin are visible.';
  if (shell === 'marketing') {
    if (auth === 'out')
      return "Marketing chrome. 'Find experts' is the demand-side anchor, 'For experts' the supply-side one. Get started is the only gradient CTA.";
    if (page === 'home')
      return 'Marketing home keeps marketing chrome even when signed in; only the right side of the header changes.';
    return "Public page in marketing chrome with the signed-in header (Dashboard · bell · avatar). The sidebar's 'Find experts' jumps out to here. Fork 2, option B.";
  }
  if (page === 'experts' || page === 'expertProfile') {
    return viewport === 'mobile'
      ? 'Public page inside the app shell at the same URL (Fork 2, option A). On mobile the booking bar stacks on top of the tab bar. That is the cost of A.'
      : 'Public page rendered inside the app shell at the same URL (Fork 2, option A). Smoother for signed-in users, but the page can no longer be static.';
  }
  if (page === 'caseDetail')
    return 'Tier 3: breadcrumb back to the list, entity tabs (Overview · Meetings · Files · Messages). The billing panel differs by lens: fee concealment.';
  if (page === 'account')
    return 'Account is reached from the user menu, not the sidebar. Nothing in the sidebar lights up, the breadcrumb carries the location.';
  const sw =
    fork1 === 'workspace'
      ? 'workspace switcher in the sidebar header'
      : 'mode pill (it has no way to express company context)';
  return `App shell · ${mode} lens${ws.represented ? ' · representing Globex' : ''} · ${sw}.`;
}

/* ───────────────────────────── primitives ───────────────────────────── */
function Sk({ w = '100%', h = 12, r = 6, style }) {
  return (
    <div
      className="bn-sk"
      style={{ width: w, height: h, borderRadius: r, background: T.sk, flexShrink: 0, ...style }}
    />
  );
}
function Badge({ n }) {
  if (!n) return null;
  return (
    <span
      style={{
        minWidth: 18,
        height: 18,
        padding: '0 5px',
        borderRadius: 9,
        background: T.red,
        color: '#fff',
        fontSize: 10,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {n}
    </span>
  );
}
function Avatar({ initials, size = 28, gradient = false, radius, color = '#cbd5e1' }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? Math.round(size * 0.28),
        background: gradient ? T.gradient : color,
        color: gradient ? '#fff' : T.text,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.round(size * 0.36),
        fontWeight: 700,
        flexShrink: 0,
        fontFamily: T.font,
      }}
    >
      {initials}
    </div>
  );
}
function Logo({ mark = false, light = false }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          width: 24,
          height: 24,
          borderRadius: 7,
          backgroundImage: T.gradient,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
          fontWeight: 800,
          fontSize: 14,
          fontFamily: T.font,
        }}
      >
        b
      </div>
      {!mark && (
        <span
          style={{
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: '-.02em',
            color: light ? '#fff' : T.text,
            fontFamily: T.font,
          }}
        >
          Balo
        </span>
      )}
    </div>
  );
}
function Btn({ children, variant = 'outline', size = 'md', onClick, full, style: st }) {
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    fontFamily: T.font,
    fontWeight: 600,
    cursor: 'pointer',
    borderRadius: 8,
    border: '1px solid transparent',
    whiteSpace: 'nowrap',
    width: full ? '100%' : undefined,
    fontSize: size === 'sm' ? 12 : 13,
    padding: size === 'sm' ? '5px 10px' : size === 'lg' ? '11px 18px' : '7px 14px',
    lineHeight: 1.2,
  };
  const v = {
    outline: { background: '#fff', border: `1px solid ${T.border}`, color: T.text },
    ghost: { background: 'transparent', color: T.text2 },
    solid: { background: T.primary, color: '#fff' },
    gradient: {
      backgroundImage: T.gradient,
      color: '#fff',
      boxShadow: '0 1px 2px rgba(59,130,246,.35)',
    },
    danger: { background: T.red, color: '#fff' },
  }[variant];
  const cls = variant === 'gradient' || variant === 'solid' ? 'bn-cta' : 'bn-press';
  return (
    <button
      className={cls}
      onClick={onClick}
      style={{
        ...base,
        ...v,
        transition: 'background .15s ease, color .15s ease, border-color .15s ease',
        ...st,
      }}
    >
      {children}
    </button>
  );
}
function Pill({ children, tone = 'slate' }) {
  const t = {
    slate: { background: '#f1f5f9', color: T.text2, border: T.border },
    green: { background: T.greenLight, color: T.green, border: T.greenBorder },
    indigo: { background: T.primaryLight, color: T.primary, border: T.primaryBorder },
    amber: { background: T.amberLight, color: T.amber, border: T.amberBorder },
  }[tone];
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 10,
        background: t.background,
        color: t.color,
        border: `1px solid ${t.border}`,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
const iconBtn = {
  width: 32,
  height: 32,
  borderRadius: 8,
  border: `1px solid transparent`,
  color: T.text2,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  position: 'relative',
};
function IconBtn({ children, onClick, dot, style: st }) {
  return (
    <button className="bn-iconbtn bn-press" onClick={onClick} style={{ ...iconBtn, ...st }}>
      {children}
      {dot && (
        <span
          className="bn-dotping"
          style={{
            position: 'absolute',
            top: 6,
            right: 7,
            width: 7,
            height: 7,
            borderRadius: 4,
            background: T.red,
            border: '1.5px solid #fff',
          }}
        />
      )}
    </button>
  );
}
function Card({ children, style: st }) {
  return (
    <div
      style={{
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        background: '#fff',
        padding: 16,
        ...st,
      }}
    >
      {children}
    </div>
  );
}
const menuBox = {
  position: 'absolute',
  background: '#fff',
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  boxShadow: '0 12px 32px rgba(15,23,42,.14)',
  padding: 6,
  zIndex: 40,
  fontFamily: T.font,
};
function MenuItem({ icon: Icon, label, onClick, tone }) {
  return (
    <button
      onClick={onClick}
      className="bn-mi bn-press"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        padding: '7px 9px',
        borderRadius: 7,
        border: 0,
        cursor: 'pointer',
        fontSize: 12.5,
        fontWeight: 500,
        color: tone === 'danger' ? T.red : T.text,
        fontFamily: T.font,
        textAlign: 'left',
      }}
    >
      <Icon size={14} color={tone === 'danger' ? T.red : T.text2} /> {label}
    </button>
  );
}
function SectionLabel({ children }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '.06em',
        textTransform: 'uppercase',
        color: T.text3,
        padding: '8px 9px 4px',
      }}
    >
      {children}
    </div>
  );
}
function PageHead({ title, desc, action, onAction, children }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
        marginBottom: 16,
      }}
    >
      <div>
        <h1
          style={{
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: '-.02em',
            margin: 0,
            color: T.text,
          }}
        >
          {title}
        </h1>
        {desc && <p style={{ margin: '4px 0 0', fontSize: 13, color: T.text3 }}>{desc}</p>}
      </div>
      {children}
      {action && (
        <Btn variant="solid" onClick={onAction}>
          {action}
        </Btn>
      )}
    </div>
  );
}
function PageTabs({ tabs, active, onChange, mobile }) {
  if (mobile) {
    return (
      <div
        style={{
          display: 'flex',
          gap: 6,
          overflowX: 'auto',
          padding: '10px 16px',
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        {tabs.map((t, i) => (
          <button
            key={t}
            onClick={() => onChange(i)}
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              padding: '6px 12px',
              borderRadius: 999,
              border: `1px solid ${i === active ? T.primary : T.border}`,
              background: i === active ? T.primary : '#fff',
              color: i === active ? '#fff' : T.text2,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              fontFamily: T.font,
            }}
          >
            {t}
          </button>
        ))}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${T.border}` }}>
      {tabs.map((t, i) => (
        <button
          key={t}
          onClick={() => onChange(i)}
          style={{
            fontSize: 13,
            fontWeight: 500,
            padding: '8px 12px 10px',
            border: 0,
            borderBottom: `2px solid ${i === active ? T.primary : 'transparent'}`,
            marginBottom: -1,
            background: 'transparent',
            color: i === active ? T.text : T.text3,
            cursor: 'pointer',
            fontFamily: T.font,
          }}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function Row({ avatar, gradient, primary, secondary, right, onClick, mobile }) {
  return (
    <div
      role={onClick ? 'button' : undefined}
      onClick={onClick}
      className={onClick ? 'bn-row' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: mobile ? '12px 0' : '12px 4px',
        borderBottom: `1px solid ${T.border}`,
        cursor: onClick ? 'pointer' : 'default',
        textAlign: 'left',
        fontFamily: T.font,
      }}
    >
      {avatar ? (
        <Avatar initials={avatar} gradient={gradient} size={34} />
      ) : (
        <Sk w={34} h={34} r={10} />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        {primary ? (
          <div
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: T.text,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {primary}
          </div>
        ) : (
          <Sk w="55%" h={11} />
        )}
        {secondary ? (
          <div style={{ fontSize: 12, color: T.text3, marginTop: 2 }}>{secondary}</div>
        ) : (
          <Sk w="35%" h={9} style={{ marginTop: 7 }} />
        )}
      </div>
      {right}
    </div>
  );
}

/* ───────────────────────────── app sidebar (desktop) ───────────────────────────── */
function NavItem({ item, active, collapsed, onClick, hint, secondary, innerRef }) {
  const Icon = item.icon;
  return (
    <button
      ref={innerRef}
      onClick={onClick}
      title={item.label}
      className={'bn-item' + (active ? ' is-active' : '')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: collapsed ? 0 : 10,
        width: '100%',
        padding: collapsed ? '9px 0' : '8px 10px',
        justifyContent: collapsed ? 'center' : 'flex-start',
        borderRadius: 8,
        border: 0,
        cursor: 'pointer',
        color: active ? T.primary : secondary ? T.text3 : T.text2,
        fontSize: secondary ? 12.5 : 13,
        fontWeight: active ? 600 : 500,
        fontFamily: T.font,
        position: 'relative',
        textAlign: 'left',
      }}
    >
      <Icon size={secondary ? 15 : 16} strokeWidth={active ? 2.2 : 1.9} style={{ flexShrink: 0 }} />
      <span
        style={{
          maxWidth: collapsed ? 0 : 150,
          opacity: collapsed ? 0 : 1,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          transition: 'max-width .22s cubic-bezier(.4,0,.2,1), opacity .16s ease',
        }}
      >
        {item.label}
      </span>
      {!collapsed && <span style={{ flex: 1 }} />}
      {!collapsed && item.setup && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 7px',
            borderRadius: 10,
            background: T.primaryLight,
            color: T.primary,
            border: `1px solid ${T.primaryBorder}`,
          }}
        >
          {item.setup}
        </span>
      )}
      {!collapsed && item.badge ? <Badge n={item.badge} /> : null}
      {!collapsed && hint && <ArrowUpRight size={12} style={{ opacity: 0.55 }} />}
      {collapsed && item.badge ? (
        <span
          style={{
            position: 'absolute',
            top: 5,
            right: 14,
            width: 7,
            height: 7,
            borderRadius: 4,
            background: T.red,
          }}
        />
      ) : null}
    </button>
  );
}

function NavSection({ items, activeKey, collapsed, go, fork2, secondary }) {
  const wrap = useRef(null);
  const refs = useRef({});
  const [pill, setPill] = useState({ top: 0, height: 0, on: false });
  const measure = () => {
    const el = refs.current[activeKey];
    if (el) setPill({ top: el.offsetTop, height: el.offsetHeight, on: true });
    else setPill((prev) => (prev.on ? { ...prev, on: false } : prev));
  };
  const mRef = useRef(measure);
  mRef.current = measure;
  useIsoLayoutEffect(() => {
    mRef.current();
  }, [activeKey, collapsed, items.map((i) => i.key).join(',')]);
  useEffect(() => {
    if (!wrap.current) return;
    const ro = new ResizeObserver(() => mRef.current());
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div
      ref={wrap}
      style={{ position: 'relative', display: 'flex', flexDirection: 'column', gap: 2 }}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: pill.height,
          transform: `translateY(${pill.top}px)`,
          borderRadius: 8,
          background: T.primaryLight,
          opacity: pill.on ? 1 : 0,
          transition: 'transform .26s cubic-bezier(.4,0,.2,1), height .2s ease, opacity .15s ease',
          pointerEvents: 'none',
          display: 'block',
        }}
      />
      {items.map((it) => (
        <NavItem
          key={it.key}
          innerRef={(el) => {
            refs.current[it.key] = el;
          }}
          item={it}
          active={activeKey === it.key}
          collapsed={collapsed}
          onClick={() => go(it.key)}
          hint={it.leavesShell && fork2 === 'marketing'}
          secondary={secondary}
        />
      ))}
    </div>
  );
}

function ModeHeader({ collapsed, mode, ws, onToggleMode }) {
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}
      >
        <Logo mark={collapsed} />
        {!collapsed && mode === 'expert' && <Pill tone="green">Expert</Pill>}
      </div>
      {!collapsed && (
        <div
          style={{
            marginTop: 10,
            display: 'inline-flex',
            padding: 2,
            borderRadius: 999,
            background: '#e2e8f0',
          }}
        >
          {['client', 'expert'].map((m) => (
            <button
              key={m}
              onClick={() => onToggleMode(m)}
              style={{
                fontSize: 11,
                fontWeight: 600,
                padding: '3px 10px',
                borderRadius: 999,
                border: 0,
                cursor: 'pointer',
                background: mode === m ? '#fff' : 'transparent',
                color: mode === m ? T.text : T.text3,
                boxShadow: mode === m ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
                fontFamily: T.font,
                textTransform: 'capitalize',
              }}
            >
              {m}
            </button>
          ))}
        </div>
      )}
      {!collapsed && ws.represented && (
        <div
          style={{
            marginTop: 8,
            fontSize: 10.5,
            color: T.amber,
            background: T.amberLight,
            border: `1px solid ${T.amberBorder}`,
            borderRadius: 6,
            padding: '4px 7px',
            lineHeight: 1.35,
          }}
        >
          Acting for Globex. The pill can't show this.
        </div>
      )}
    </div>
  );
}

function WsRow({ w, current, onClick }) {
  return (
    <button
      onClick={onClick}
      className="bn-mi bn-press"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        width: '100%',
        padding: '6px 9px',
        borderRadius: 7,
        border: 0,
        background: current ? T.muted : undefined,
        cursor: 'pointer',
        fontFamily: T.font,
        textAlign: 'left',
      }}
    >
      <Avatar initials={w.initials} gradient={w.mode === 'expert'} size={26} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>{w.name}</div>
        <div style={{ fontSize: 10.5, color: T.text3 }}>{w.sub}</div>
      </div>
      {current && <Check size={14} color={T.primary} />}
    </button>
  );
}

function WorkspaceHeader({ collapsed, ws, onSelect }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      {!collapsed && (
        <div style={{ marginBottom: 10 }}>
          <Logo />
        </div>
      )}
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          width: '100%',
          padding: collapsed ? 3 : '6px 8px',
          borderRadius: 8,
          border: `1px solid ${open ? T.primaryBorder : 'transparent'}`,
          background: open ? '#fff' : 'transparent',
          cursor: 'pointer',
          justifyContent: collapsed ? 'center' : 'flex-start',
          fontFamily: T.font,
        }}
      >
        <Avatar initials={ws.initials} gradient={ws.mode === 'expert'} size={28} />
        {!collapsed && (
          <Fragment>
            <div style={{ textAlign: 'left', minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: T.text,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {ws.name}
              </div>
              <div style={{ fontSize: 10.5, color: T.text3 }}>{ws.sub}</div>
            </div>
            <ChevronsUpDown size={14} color={T.text3} />
          </Fragment>
        )}
      </button>
      {open && (
        <div
          className="bn-pop"
          style={{
            ...menuBox,
            top: '100%',
            left: 0,
            marginTop: 6,
            width: 256,
            transformOrigin: 'top left',
          }}
        >
          <SectionLabel>Your expert workspace</SectionLabel>
          <WsRow
            w={WS.expert}
            current={ws.key === 'expert'}
            onClick={() => {
              setOpen(false);
              onSelect('expert');
            }}
          />
          <SectionLabel>Companies</SectionLabel>
          <WsRow
            w={WS.acme}
            current={ws.key === 'acme'}
            onClick={() => {
              setOpen(false);
              onSelect('acme');
            }}
          />
          <WsRow
            w={WS.globex}
            current={ws.key === 'globex'}
            onClick={() => {
              setOpen(false);
              onSelect('globex');
            }}
          />
          <div style={{ borderTop: `1px solid ${T.border}`, margin: '6px 0' }} />
          <MenuItem icon={Plus} label="Create a company" onClick={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function UserPill({ collapsed, mode, isAdmin, onAction }) {
  const [open, setOpen] = useState(false);
  const act = (a) => {
    setOpen(false);
    onAction(a);
  };
  return (
    <div style={{ position: 'relative', marginTop: 6 }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          width: '100%',
          padding: collapsed ? 3 : '7px 9px',
          borderRadius: 8,
          border: 0,
          background: open ? '#fff' : 'transparent',
          cursor: 'pointer',
          justifyContent: collapsed ? 'center' : 'flex-start',
          fontFamily: T.font,
        }}
      >
        <Avatar initials="YJ" gradient size={28} />
        {!collapsed && (
          <Fragment>
            <div style={{ textAlign: 'left', flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: T.text }}>Yomi Joseph</div>
              <div style={{ fontSize: 10.5, color: T.text3 }}>
                {mode === 'expert' ? 'Expert' : 'Client'}
              </div>
            </div>
            <MoreHorizontal size={14} color={T.text3} />
          </Fragment>
        )}
      </button>
      {open && (
        <div
          className="bn-pop"
          style={{
            ...menuBox,
            bottom: '100%',
            left: 0,
            marginBottom: 6,
            width: 200,
            transformOrigin: 'bottom left',
          }}
        >
          <MenuItem icon={User} label="Account" onClick={() => act('account')} />
          {isAdmin && (
            <MenuItem icon={ShieldCheck} label="Admin console" onClick={() => act('admin')} />
          )}
          <div style={{ borderTop: `1px solid ${T.border}`, margin: '6px 0' }} />
          <MenuItem icon={LogOut} label="Log out" tone="danger" onClick={() => act('logout')} />
        </div>
      )}
    </div>
  );
}

function Sidebar({
  collapsed,
  mode,
  ws,
  nav,
  activeKey,
  fork1,
  fork2,
  go,
  switchWs,
  toggleMode,
  isAdmin,
  userAction,
}) {
  return (
    <aside
      style={{
        width: collapsed ? 64 : 248,
        transition: 'width .24s cubic-bezier(.4,0,.2,1)',
        borderRight: `1px solid ${T.border}`,
        background: T.muted,
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        position: 'relative',
        zIndex: 5,
      }}
    >
      <div style={{ padding: '14px 12px 12px', borderBottom: `1px solid ${T.border}` }}>
        {fork1 === 'pill' ? (
          <ModeHeader collapsed={collapsed} mode={mode} ws={ws} onToggleMode={toggleMode} />
        ) : (
          <WorkspaceHeader collapsed={collapsed} ws={ws} onSelect={switchWs} />
        )}
      </div>
      <nav style={{ padding: 8 }}>
        <NavSection
          items={nav.primary}
          activeKey={activeKey}
          collapsed={collapsed}
          go={go}
          fork2={fork2}
        />
      </nav>
      <div style={{ flex: 1 }} />
      <div style={{ padding: 8, borderTop: `1px solid ${T.border}` }}>
        <NavSection
          items={nav.secondary}
          activeKey={activeKey}
          collapsed={collapsed}
          go={go}
          secondary
        />
        <UserPill collapsed={collapsed} mode={mode} isAdmin={isAdmin} onAction={userAction} />
      </div>
    </aside>
  );
}

function TopBar({ crumbs, mode, collapsed, setCollapsed, go }) {
  return (
    <header
      style={{
        height: 56,
        borderBottom: `1px solid ${T.border}`,
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        gap: 12,
        background: '#fff',
        flexShrink: 0,
      }}
    >
      <IconBtn onClick={() => setCollapsed(!collapsed)}>
        <PanelLeft size={16} />
      </IconBtn>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <ChevronRight size={13} color={T.text3} />}
            <span
              style={{
                color: i === crumbs.length - 1 ? T.text : T.text3,
                fontWeight: i === crumbs.length - 1 ? 600 : 500,
              }}
            >
              {c}
            </span>
          </Fragment>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <button
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          height: 32,
          padding: '0 10px 0 10px',
          borderRadius: 8,
          border: `1px solid ${T.border}`,
          background: T.muted,
          color: T.text3,
          fontSize: 12.5,
          cursor: 'pointer',
          fontFamily: T.font,
          width: 220,
        }}
      >
        <Search size={13} /> Search
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 10.5,
            fontFamily: T.mono,
            border: `1px solid ${T.border}`,
            borderRadius: 4,
            padding: '1px 5px',
            background: '#fff',
          }}
        >
          ⌘K
        </span>
      </button>
      {mode === 'client' && (
        <button
          onClick={() => go('settings')}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            height: 32,
            padding: '0 10px',
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: '#fff',
            fontSize: 12.5,
            fontWeight: 600,
            color: T.text,
            cursor: 'pointer',
            fontFamily: T.font,
          }}
        >
          <Wallet size={13} color={T.text2} /> A$420{' '}
          <span style={{ color: T.primary, fontWeight: 600 }}>Top up</span>
        </button>
      )}
      <IconBtn dot>
        <Bell size={16} />
      </IconBtn>
    </header>
  );
}

function CallPill({ onReturn, mobile }) {
  if (mobile) {
    return (
      <button
        onClick={onReturn}
        className="bn-rise"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '7px 16px',
          border: 0,
          borderBottom: `1px solid ${T.greenBorder}`,
          background: T.greenLight,
          color: T.green,
          fontSize: 12.5,
          fontWeight: 600,
          cursor: 'pointer',
          fontFamily: T.font,
        }}
      >
        <span
          className="bn-live"
          style={{ width: 8, height: 8, borderRadius: 4, background: T.green }}
        />{' '}
        In call · Priya Nair · 12:34{' '}
        <span style={{ marginLeft: 'auto', textDecoration: 'underline' }}>Return</span>
      </button>
    );
  }
  return (
    <button
      onClick={onReturn}
      className="bn-rise"
      style={{
        position: 'absolute',
        right: 20,
        bottom: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 12px 9px 12px',
        borderRadius: 12,
        border: `1px solid ${T.greenBorder}`,
        background: '#fff',
        boxShadow: '0 10px 30px rgba(15,23,42,.14)',
        cursor: 'pointer',
        fontFamily: T.font,
        zIndex: 30,
      }}
    >
      <span
        className="bn-live"
        style={{ width: 8, height: 8, borderRadius: 4, background: T.green }}
      />
      <span style={{ fontSize: 12.5, fontWeight: 600, color: T.text }}>In call · Priya Nair</span>
      <span style={{ fontSize: 12, color: T.text3, fontFamily: T.mono }}>12:34</span>
      <span style={{ fontSize: 12, fontWeight: 600, color: T.primary }}>Return</span>
    </button>
  );
}

/* ───────────────────────────── page bodies ───────────────────────────── */
const EXPERTS = [
  ['PN', 'Priya Nair', 'Service Cloud architect', 'A$180/hr', '4.9 · 120 sessions'],
  ['ML', 'Marcus Lee', 'CPQ specialist', 'A$210/hr', '4.8 · 64 sessions'],
  ['AR', 'Aisha Rahman', 'Integration & MuleSoft', 'A$195/hr', '5.0 · 41 sessions'],
  ['TB', 'Tom Becker', 'Sales Cloud admin', 'A$150/hr', '4.7 · 210 sessions'],
  ['LF', 'Lena Fischer', 'Marketing Cloud', 'A$170/hr', '4.9 · 88 sessions'],
  ['DA', 'Diego Alvarez', 'Data & migration', 'A$165/hr', '4.8 · 52 sessions'],
];

function DirectoryBody({ mobile, embedded, go }) {
  const list = mobile ? EXPERTS.slice(0, 3) : EXPERTS;
  return (
    <div style={{ padding: mobile ? 16 : embedded ? 0 : '32px 40px' }}>
      {!embedded && (
        <h1
          style={{
            fontSize: mobile ? 22 : 28,
            fontWeight: 700,
            letterSpacing: '-.02em',
            margin: '0 0 4px',
            color: T.text,
          }}
        >
          Salesforce experts
        </h1>
      )}
      {!embedded && (
        <p style={{ margin: '0 0 16px', fontSize: 13.5, color: T.text3 }}>
          Vetted consultants, available today. Book by the minute.
        </p>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          padding: '0 12px',
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: '#fff',
          color: T.text3,
          fontSize: 13,
          marginBottom: 12,
          maxWidth: 520,
        }}
      >
        <Search size={14} /> Search by skill, product or name
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {['Sales Cloud', 'Service Cloud', 'CPQ', 'Integration', 'Data', 'Marketing Cloud'].map(
          (f, i) => (
            <span
              key={f}
              style={{
                fontSize: 12,
                fontWeight: 500,
                padding: '5px 10px',
                borderRadius: 999,
                border: `1px solid ${i === 1 ? T.primary : T.border}`,
                background: i === 1 ? T.primaryLight : '#fff',
                color: i === 1 ? T.primary : T.text2,
              }}
            >
              {f}
            </span>
          )
        )}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : 'repeat(3, minmax(0,1fr))',
          gap: 12,
        }}
      >
        {list.map(([ini, name, head, rate, meta]) => (
          <button
            key={name}
            onClick={() => go('expertProfile')}
            className="bn-card"
            style={{
              textAlign: 'left',
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              background: '#fff',
              padding: 14,
              cursor: 'pointer',
              fontFamily: T.font,
            }}
          >
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <Avatar initials={ini} size={40} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{name}</div>
                <div style={{ fontSize: 12, color: T.text3 }}>{head}</div>
              </div>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 12,
                fontSize: 12.5,
              }}
            >
              <span
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: T.text2 }}
              >
                <Star size={12} fill="#f59e0b" color="#f59e0b" /> {meta}
              </span>
              <span style={{ fontWeight: 600, color: T.text }}>{rate}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function BookingCard({ book, compact }) {
  return (
    <Card style={{ padding: compact ? 14 : 18 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.02em', color: T.text }}>
          A$180
        </span>
        <span style={{ fontSize: 12.5, color: T.text3 }}>/ hour · 15-min minimum</span>
      </div>
      <div style={{ fontSize: 12, color: T.text3, marginTop: 4 }}>Next available</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {['Today 2:30 pm', 'Today 4:00 pm', 'Tue 9:00 am'].map((s, i) => (
          <span
            key={s}
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              padding: '5px 9px',
              borderRadius: 8,
              border: `1px solid ${i === 0 ? T.primary : T.border}`,
              color: i === 0 ? T.primary : T.text2,
              background: i === 0 ? T.primaryLight : '#fff',
            }}
          >
            {s}
          </span>
        ))}
      </div>
      <Btn variant="gradient" full size="lg" onClick={book} style={{ marginTop: 14 }}>
        Book a consultation
      </Btn>
      <Btn variant="outline" full onClick={() => {}} style={{ marginTop: 8 }}>
        Message Priya
      </Btn>
    </Card>
  );
}

function ProfileBody({ mobile, embedded, book }) {
  return (
    <div
      style={{
        padding: mobile ? 16 : embedded ? 0 : '32px 40px',
        display: 'grid',
        gridTemplateColumns: mobile ? '1fr' : 'minmax(0,1fr) 320px',
        gap: 24,
        alignItems: 'start',
      }}
    >
      <div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <Avatar initials="PN" size={mobile ? 56 : 72} />
          <div>
            <div
              style={{
                fontSize: mobile ? 20 : 26,
                fontWeight: 700,
                letterSpacing: '-.02em',
                color: T.text,
              }}
            >
              Priya Nair
            </div>
            <div style={{ fontSize: 13.5, color: T.text2, marginTop: 2 }}>
              Service Cloud architect · 11 years · Melbourne
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <Pill tone="indigo">Service Cloud</Pill>
              <Pill>Omni-Channel</Pill>
              <Pill>Flow</Pill>
              <Pill>Einstein</Pill>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 24, fontSize: 14, fontWeight: 600, color: T.text }}>About</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          <Sk h={11} />
          <Sk h={11} w="92%" />
          <Sk h={11} w="70%" />
        </div>
        <div style={{ marginTop: 24, fontSize: 14, fontWeight: 600, color: T.text }}>Reviews</div>
        <Row
          avatar="AC"
          primary="Acme Corp"
          secondary="Cleared a 6-week case backlog in one session."
          right={<span style={{ fontSize: 12, color: T.text2 }}>★ 5.0</span>}
        />
        <Row />
        {mobile && <div style={{ height: 8 }} />}
      </div>
      {!mobile && <BookingCard book={book} />}
    </div>
  );
}

function HomeBody({ mobile, go, startAuth, auth }) {
  return (
    <div style={{ padding: mobile ? '32px 20px' : '72px 40px 40px', maxWidth: 760 }}>
      <div
        style={{
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: T.primary,
        }}
      >
        Salesforce · on demand
      </div>
      <h1
        style={{
          fontSize: mobile ? 32 : 46,
          fontWeight: 700,
          letterSpacing: '-.03em',
          lineHeight: 1.05,
          margin: '10px 0 14px',
          color: T.text,
        }}
      >
        Talk to a vetted Salesforce expert in minutes.
      </h1>
      <p style={{ fontSize: mobile ? 15 : 17, color: T.text2, margin: '0 0 22px', maxWidth: 540 }}>
        Book by the minute, bring your whole team, get answers today.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <Btn variant="gradient" size="lg" onClick={() => go('experts')}>
          Find an expert
        </Btn>
        {auth === 'out' && (
          <Btn variant="outline" size="lg" onClick={() => startAuth('signup')}>
            Join as an expert
          </Btn>
        )}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : 'repeat(3,1fr)',
          gap: 12,
          marginTop: 48,
        }}
      >
        {[0, 1, 2].map((i) => (
          <Card key={i} style={{ padding: 14 }}>
            <Sk w={28} h={28} r={8} />
            <Sk w="60%" h={11} style={{ marginTop: 12 }} />
            <Sk w="90%" h={9} style={{ marginTop: 8 }} />
          </Card>
        ))}
      </div>
    </div>
  );
}

function GettingStarted({ go }) {
  const items = [
    ['Profile', true],
    ['Rate', true],
    ['Schedule', true],
    ['Payout details', false],
    ['Calendar sync', false],
  ];
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <div
        style={{
          padding: '14px 16px',
          backgroundImage: T.gradientSubtle,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 9,
            backgroundImage: T.gradient,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
          }}
        >
          <Sparkles size={16} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Getting started</div>
          <div style={{ fontSize: 12, color: T.text3 }}>Complete these steps to go live</div>
        </div>
        <div
          style={{
            fontSize: 22,
            fontWeight: 700,
            backgroundImage: T.gradient,
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}
        >
          3/5
        </div>
      </div>
      <div style={{ height: 4, background: '#e2e8f0' }}>
        <div
          className="bn-grow"
          style={{ width: '60%', height: '100%', backgroundImage: T.gradient }}
        />
      </div>
      <div style={{ padding: '6px 16px 10px' }}>
        {items.map(([l, done]) => (
          <button
            key={l}
            onClick={() => go('expertSettings')}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '8px 0',
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              fontFamily: T.font,
              textAlign: 'left',
              fontSize: 13,
              color: done ? T.text3 : T.text,
              textDecoration: done ? 'line-through' : 'none',
            }}
          >
            {done ? (
              <CircleCheck size={16} color={T.green} />
            ) : (
              <Circle size={16} color="#cbd5e1" />
            )}{' '}
            {l}
            {!done && (
              <span style={{ marginLeft: 'auto', fontSize: 12, color: T.primary, fontWeight: 600 }}>
                Set up
              </span>
            )}
          </button>
        ))}
      </div>
    </Card>
  );
}

function CreditsCard({ go }) {
  return (
    <Card>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: T.text3,
          fontWeight: 600,
        }}
      >
        <Wallet size={13} /> Credits
      </div>
      <div
        style={{
          fontSize: 30,
          fontWeight: 700,
          letterSpacing: '-.03em',
          color: T.text,
          marginTop: 6,
        }}
      >
        A$420.00
      </div>
      <div style={{ fontSize: 12.5, color: T.text3 }}>About 2 h 20 min at typical rates</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Btn variant="solid" onClick={() => go('settings')}>
          Top up
        </Btn>
        <Btn variant="ghost" onClick={() => go('settings')}>
          View ledger
        </Btn>
      </div>
    </Card>
  );
}

function DashboardBody({ mode, mobile, go, joinCall, fork3 }) {
  const listKey = fork3 === 'type' ? 'consultations' : 'inbox';
  const projKey = fork3 === 'type' ? 'projects' : 'work';
  const attention =
    mode === 'expert'
      ? [
          ['AC', 'New consultation request', 'Acme Corp · wants 30 min today', 'Respond', listKey],
          ['GX', 'Proposal draft', 'Globex · CPQ rollout, due Thu', 'Finish', projKey],
        ]
      : [
          [
            'PN',
            'Proposal to review',
            'Priya Nair · Service Cloud audit · A$2,720',
            'Review',
            projKey,
          ],
          ['AC', 'Invite your team', '3 seats unused on Acme Corp', 'Invite', 'settings'],
        ];
  return (
    <div style={{ padding: mobile ? 16 : 0 }}>
      {!mobile && (
        <PageHead
          title="Good morning, Yomi"
          desc={
            mode === 'expert'
              ? 'Two things need you before your 2:30 pm.'
              : 'One proposal is waiting for you.'
          }
        />
      )}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : 'minmax(0,1fr) 320px',
          gap: 16,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {mode === 'expert' ? <GettingStarted go={go} /> : <CreditsCard go={go} />}
          <Card style={{ paddingTop: 12, paddingBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
              Needs your attention
            </div>
            {attention.map(([ini, p, s, a, key]) => (
              <Row
                key={p}
                avatar={ini}
                primary={p}
                secondary={s}
                onClick={() => go(key)}
                right={
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: T.primary }}>{a}</span>
                }
              />
            ))}
          </Card>
        </div>
        <Card style={{ paddingTop: 12 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: T.text, marginBottom: 4 }}>
            Upcoming
          </div>
          <Row
            avatar={mode === 'expert' ? 'AC' : 'PN'}
            gradient={mode !== 'expert'}
            primary="Case #1042 · Today 2:30 pm"
            secondary={mode === 'expert' ? 'Acme Corp · 30 min' : 'Priya Nair · 30 min'}
            onClick={() => go('caseDetail')}
            right={
              <Btn
                size="sm"
                variant="solid"
                onClick={(e) => {
                  e.stopPropagation();
                  joinCall();
                }}
              >
                Join
              </Btn>
            }
          />
          <Row />
          <Row />
        </Card>
      </div>
    </div>
  );
}

const ACTIONS = {
  consultations: { client: 'Book a consultation' },
  projects: { client: 'New project request' },
  work: { client: 'New project request' },
};

function ListRows({ page, mode, mobile, go }) {
  const first =
    page === 'projects' || page === 'work'
      ? {
          avatar: mode === 'expert' ? 'GX' : 'PN',
          primary: 'Salesforce CPQ rollout',
          secondary:
            mode === 'expert'
              ? 'Globex · proposal draft · A$2,720'
              : 'Priya Nair · proposal received · A$2,720',
          pill: <Pill tone="amber">Proposal</Pill>,
          to: 'caseDetail',
        }
      : {
          avatar: mode === 'expert' ? 'AC' : 'PN',
          primary: 'Case #1042 · Service Cloud routing',
          secondary:
            mode === 'expert'
              ? 'Acme Corp · today 2:30 pm · 30 min'
              : 'Priya Nair · today 2:30 pm · 30 min',
          pill: <Pill tone="green">Scheduled</Pill>,
          to: 'caseDetail',
        };
  return (
    <div>
      <Row
        mobile={mobile}
        avatar={first.avatar}
        primary={first.primary}
        secondary={first.secondary}
        right={first.pill}
        onClick={() => go(first.to)}
      />
      {page === 'inbox' && (
        <Row
          mobile={mobile}
          avatar={mode === 'expert' ? 'AC' : 'PN'}
          primary={mode === 'expert' ? 'New consultation request' : 'Proposal to review'}
          secondary={
            mode === 'expert'
              ? 'Acme Corp · wants 30 min today'
              : 'Priya Nair · Service Cloud audit'
          }
          right={<Pill tone="indigo">Action</Pill>}
          onClick={() => go('caseDetail')}
        />
      )}
      <Row mobile={mobile} />
      <Row mobile={mobile} />
      <Row mobile={mobile} />
    </div>
  );
}

function MessagesBody({ mobile }) {
  const threads = [
    ['PN', 'Priya Nair', 'Sent the pre-read for tomorrow', '2m', true],
    ['AC', 'Acme Corp', 'Can we move to 3 pm?', '1h', true],
    ['ML', 'Marcus Lee', 'Thanks, that solved it', 'Tue', false],
  ];
  const list = (
    <div>
      {threads.map(([i, n, m, t, u]) => (
        <Row
          key={n}
          mobile={mobile}
          avatar={i}
          primary={n}
          secondary={m}
          right={
            <span
              style={{ fontSize: 11.5, color: u ? T.primary : T.text3, fontWeight: u ? 700 : 500 }}
            >
              {t}
            </span>
          }
          onClick={() => {}}
        />
      ))}
      <Row mobile={mobile} />
      <Row mobile={mobile} />
    </div>
  );
  if (mobile) return list;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '320px minmax(0,1fr)',
        gap: 0,
        border: `1px solid ${T.border}`,
        borderRadius: 12,
        overflow: 'hidden',
        height: 560,
      }}
    >
      <div style={{ borderRight: `1px solid ${T.border}`, padding: '0 12px' }}>{list}</div>
      <div
        style={{
          padding: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          background: T.muted,
        }}
      >
        <Sk w="40%" h={12} />
        <Sk w="55%" h={34} r={12} />
        <Sk w="45%" h={34} r={12} style={{ alignSelf: 'flex-end', background: T.primaryLight }} />
        <Sk w="60%" h={34} r={12} />
        <div style={{ flex: 1 }} />
        <Sk h={40} r={10} style={{ background: '#fff', border: `1px solid ${T.border}` }} />
      </div>
    </div>
  );
}

function CalendarBody({ mobile, tab }) {
  if (tab === 2) {
    return (
      <Card>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Weekly availability</div>
        <div style={{ fontSize: 12.5, color: T.text3, marginTop: 4 }}>
          Reuses ExpertAvailabilityCalendar (BAL-236). Rules editor lives here, not in settings.
        </div>
        <div
          style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6, marginTop: 14 }}
        >
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d, i) => (
            <div key={d} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: T.text3, marginBottom: 6 }}>{d}</div>
              <div
                style={{
                  height: 80,
                  borderRadius: 8,
                  background: i < 5 ? T.primaryLight : T.sk,
                  border: `1px solid ${i < 5 ? T.primaryBorder : T.border}`,
                }}
              />
            </div>
          ))}
        </div>
      </Card>
    );
  }
  const days = mobile ? ['Mon', 'Tue', 'Wed'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${days.length},1fr)`, gap: 8 }}>
      {days.map((d, i) => (
        <div key={d}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: i === 0 ? T.primary : T.text2,
              marginBottom: 8,
            }}
          >
            {d} {18 + i}
          </div>
          <div
            style={{
              height: mobile ? 300 : 440,
              borderRadius: 10,
              border: `1px solid ${T.border}`,
              position: 'relative',
              background: '#fff',
            }}
          >
            {i === 0 && (
              <div
                style={{
                  position: 'absolute',
                  top: '35%',
                  left: 6,
                  right: 6,
                  padding: '6px 8px',
                  borderRadius: 7,
                  background: T.primaryLight,
                  border: `1px solid ${T.primaryBorder}`,
                  fontSize: 11,
                  fontWeight: 600,
                  color: T.primary,
                }}
              >
                2:30 · Case #1042<div style={{ fontWeight: 500, color: T.text2 }}>Acme Corp</div>
              </div>
            )}
            {i === 2 && (
              <div
                style={{
                  position: 'absolute',
                  top: '15%',
                  left: 6,
                  right: 6,
                  padding: '6px 8px',
                  borderRadius: 7,
                  background: T.sk,
                  fontSize: 11,
                  fontWeight: 600,
                  color: T.text2,
                }}
              >
                10:00 · Globex kickoff
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function FormBody({ label, extra }) {
  return (
    <Card style={{ maxWidth: 560 }}>
      {extra}
      {[0, 1].map((i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <Sk w={120} h={10} style={{ marginBottom: 8 }} />
          <div style={{ height: 36, borderRadius: 8, border: `1px solid ${T.border}` }} />
        </div>
      ))}
      <Btn variant="solid" onClick={() => {}}>
        Save changes
      </Btn>
    </Card>
  );
}

function GenericPage(p) {
  const { page, meta, tab, setTab, mode, mobile, go, say } = p;
  const action = ACTIONS[page] && ACTIONS[page][mode];
  const onAction = () => {
    if (page === 'consultations') {
      go('experts');
      say("Booking starts from an expert's profile");
    } else say('Opens the project request form');
  };
  let body;
  if (page === 'messages') body = <MessagesBody mobile={mobile} />;
  else if (page === 'calendar') body = <CalendarBody mobile={mobile} tab={tab} />;
  else if (page === 'settings' || page === 'expertSettings' || page === 'account') {
    const tabName = meta.tabs[Math.min(tab, meta.tabs.length - 1)];
    const extra =
      tabName === 'Credits & billing' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 16,
            padding: 12,
            borderRadius: 10,
            background: T.muted,
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: T.text3 }}>Balance</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: T.text }}>A$420.00</div>
          </div>
          <Btn variant="solid" onClick={() => {}} style={{ marginLeft: 'auto' }}>
            Top up
          </Btn>
        </div>
      ) : tabName === 'Payouts' ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 16,
            padding: 12,
            borderRadius: 10,
            background: T.muted,
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: T.text3 }}>Earnings this month</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: T.text }}>A$3,150.00</div>
          </div>
          <Pill tone="amber">Payout details missing</Pill>
        </div>
      ) : (
        <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 14 }}>
          {tabName}
        </div>
      );
    body = <FormBody extra={extra} />;
  } else body = <ListRows page={page} mode={mode} mobile={mobile} go={go} />;
  return (
    <div style={{ padding: mobile ? 0 : 0 }}>
      {!mobile && <PageHead title={meta.title} action={action} onAction={onAction} />}
      {meta.tabs && <PageTabs tabs={meta.tabs} active={tab} onChange={setTab} mobile={mobile} />}
      <div style={{ padding: mobile ? '8px 16px 24px' : '16px 0 0' }}>{body}</div>
    </div>
  );
}

function CaseBody({ mode, mobile, tab, setTab, go, joinCall, fork3 }) {
  const parent = fork3 === 'type' ? 'consultations' : 'work';
  return (
    <div>
      {!mobile && (
        <div>
          <button
            onClick={() => go(parent)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              fontSize: 12.5,
              color: T.text3,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              padding: 0,
              marginBottom: 10,
              fontFamily: T.font,
            }}
          >
            <ArrowLeft size={13} /> {PAGE_META[parent].title}
          </button>
          <PageHead title="Case #1042 · Service Cloud routing">
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginLeft: -8,
                marginRight: 'auto',
              }}
            >
              <Pill tone="green">Scheduled · Today 2:30 pm</Pill>
            </div>
            <Btn variant="solid" onClick={joinCall}>
              <Video size={14} /> Join meeting
            </Btn>
          </PageHead>
        </div>
      )}
      <PageTabs tabs={PAGE_META.caseDetail.tabs} active={tab} onChange={setTab} mobile={mobile} />
      <div
        style={{
          padding: mobile ? 16 : '16px 0 0',
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : 'minmax(0,1fr) 300px',
          gap: 16,
        }}
      >
        <div>
          {mobile && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Pill tone="green">Scheduled · Today 2:30 pm</Pill>
              <Btn size="sm" variant="solid" onClick={joinCall} style={{ marginLeft: 'auto' }}>
                <Video size={13} /> Join
              </Btn>
            </div>
          )}
          <Card>
            <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 10 }}>
              {PAGE_META.caseDetail.tabs[Math.min(tab, 3)]}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Sk h={11} />
              <Sk h={11} w="88%" />
              <Sk h={11} w="64%" />
            </div>
          </Card>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card style={{ padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.text3, marginBottom: 8 }}>
              Participants
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 13,
                color: T.text,
                marginBottom: 6,
              }}
            >
              <Avatar initials="PN" size={24} /> Priya Nair{' '}
              <span style={{ color: T.text3, fontSize: 12 }}>· Expert</span>
            </div>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: T.text }}
            >
              <Avatar initials="AC" size={24} /> Acme Corp{' '}
              <span style={{ color: T.text3, fontSize: 12 }}>· Client · 2 seats</span>
            </div>
          </Card>
          <Card style={{ padding: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: T.text3, marginBottom: 8 }}>
              {mode === 'expert' ? 'Your earnings' : 'Billing'}
            </div>
            {mode === 'expert' ? (
              <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>
                Your rate <b>A$150/hr</b>
                <br />
                15-min floor · paid via Airwallex
              </div>
            ) : (
              <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>
                Rate <b>A$180/hr</b>
                <br />
                15-min minimum · paid from credits
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function PageBody(p) {
  const { page } = p;
  if (page === 'dashboard') return <DashboardBody {...p} />;
  if (page === 'experts')
    return (
      <div style={{ padding: p.mobile ? 0 : 0 }}>
        {!p.mobile && (
          <PageHead title="Find experts" desc="Salesforce experts, vetted. Book by the minute." />
        )}
        <DirectoryBody mobile={p.mobile} embedded go={p.go} />
      </div>
    );
  if (page === 'expertProfile') return <ProfileBody mobile={p.mobile} embedded book={p.book} />;
  if (page === 'caseDetail') return <CaseBody {...p} />;
  return <GenericPage {...p} />;
}

/* ───────────────────────────── shells: app ───────────────────────────── */
function AppDesktop(p) {
  const { callBg, joinCall } = p;
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        background: '#fff',
        fontFamily: T.font,
        color: T.text,
        position: 'relative',
      }}
    >
      <Sidebar {...p} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <TopBar {...p} />
        <main style={{ flex: 1, overflow: 'auto', padding: '24px 32px 32px' }}>
          <div key={p.page} className="bn-page">
            <PageBody {...p} />
          </div>
        </main>
      </div>
      {callBg && <CallPill onReturn={joinCall} />}
    </div>
  );
}

function MobileTopBar({ title, back, right }) {
  return (
    <header
      style={{
        height: 52,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px 0 12px',
        gap: 6,
        borderBottom: `1px solid ${T.border}`,
        background: '#fff',
        flexShrink: 0,
      }}
    >
      {back ? (
        <IconBtn onClick={back}>
          <ArrowLeft size={18} />
        </IconBtn>
      ) : (
        <div style={{ width: 4 }} />
      )}
      <div
        style={{
          fontSize: 17,
          fontWeight: 600,
          letterSpacing: '-.01em',
          color: T.text,
          flex: 1,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {title}
      </div>
      {right}
    </header>
  );
}

function BottomTabs({ tabs, activeKey, go, onMore, moreActive }) {
  const all = [
    ...tabs.map((t) => ({ ...t, isMore: false })),
    { key: 'more', short: 'More', icon: MoreHorizontal, isMore: true },
  ];
  return (
    <nav
      style={{
        height: 78,
        borderTop: `1px solid ${T.border}`,
        background: '#fff',
        display: 'grid',
        gridTemplateColumns: `repeat(${all.length},1fr)`,
        flexShrink: 0,
        paddingBottom: 16,
        paddingTop: 6,
      }}
    >
      {all.map((t) => {
        const Icon = t.icon;
        const active = t.isMore ? moreActive : activeKey === t.key;
        return (
          <button
            key={t.key}
            onClick={() => (t.isMore ? onMore() : go(t.key))}
            className="bn-press"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 3,
              border: 0,
              background: 'transparent',
              cursor: 'pointer',
              color: active ? T.primary : T.text3,
              fontFamily: T.font,
              position: 'relative',
              transition: 'color .15s ease',
            }}
          >
            <span
              key={active ? 'on' : 'off'}
              className={active ? 'bn-tabpop' : undefined}
              style={{ position: 'relative', display: 'inline-flex' }}
            >
              <Icon size={22} strokeWidth={active ? 2.2 : 1.8} />
              {t.badge ? (
                <span
                  style={{
                    position: 'absolute',
                    top: -5,
                    right: -9,
                    minWidth: 16,
                    height: 16,
                    padding: '0 4px',
                    borderRadius: 8,
                    background: T.red,
                    color: '#fff',
                    fontSize: 9.5,
                    fontWeight: 700,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1.5px solid #fff',
                  }}
                >
                  {t.badge}
                </span>
              ) : null}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: active ? 600 : 500 }}>{t.short}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Sheet({ onClose, children }) {
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 30 }}>
      <div
        onClick={onClose}
        className="bn-scrim"
        style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,.35)' }}
      />
      <div
        className="bn-sheet"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          background: '#fff',
          borderRadius: '18px 18px 0 0',
          padding: '8px 12px 34px',
          boxShadow: '0 -10px 40px rgba(15,23,42,.2)',
          maxHeight: '88%',
          overflow: 'auto',
          fontFamily: T.font,
        }}
      >
        <div
          style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            background: '#cbd5e1',
            margin: '4px auto 10px',
          }}
        />
        {children}
      </div>
    </div>
  );
}

function SheetItem({ icon: Icon, label, onClick, badge, setup, tone, right }) {
  return (
    <button
      onClick={onClick}
      className="bn-mi bn-press"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '12px 10px',
        borderRadius: 10,
        border: 0,
        cursor: 'pointer',
        fontFamily: T.font,
        textAlign: 'left',
        fontSize: 15,
        fontWeight: 500,
        color: tone === 'danger' ? T.red : T.text,
      }}
    >
      <Icon size={18} color={tone === 'danger' ? T.red : T.text2} /> {label}
      <span style={{ flex: 1 }} />
      {setup && <Pill tone="indigo">{setup}</Pill>}
      {badge ? <Badge n={badge} /> : null}
      {right}
    </button>
  );
}

function MoreSheet({
  items,
  go,
  onClose,
  ws,
  switchWs,
  toggleMode,
  fork1,
  isAdmin,
  userAction,
  mode,
}) {
  return (
    <Sheet onClose={onClose}>
      {items.map((it) => (
        <SheetItem
          key={it.key}
          icon={it.icon}
          label={it.label}
          badge={it.badge}
          setup={it.setup}
          onClick={() => go(it.key)}
        />
      ))}
      <div style={{ borderTop: `1px solid ${T.border}`, margin: '6px 0' }} />
      {fork1 === 'workspace' ? (
        <Fragment>
          <SectionLabel>Workspace</SectionLabel>
          {['expert', 'acme', 'globex'].map((k) => (
            <WsRow key={k} w={WS[k]} current={ws.key === k} onClick={() => switchWs(k)} />
          ))}
        </Fragment>
      ) : (
        <div style={{ padding: '6px 10px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: T.text2, flex: 1 }}>Mode</span>
          <div
            style={{ display: 'inline-flex', padding: 2, borderRadius: 999, background: '#e2e8f0' }}
          >
            {['client', 'expert'].map((m) => (
              <button
                key={m}
                onClick={() => toggleMode(m)}
                style={{
                  fontSize: 12,
                  fontWeight: 600,
                  padding: '5px 12px',
                  borderRadius: 999,
                  border: 0,
                  cursor: 'pointer',
                  background: mode === m ? '#fff' : 'transparent',
                  color: mode === m ? T.text : T.text3,
                  fontFamily: T.font,
                  textTransform: 'capitalize',
                }}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}
      <div style={{ borderTop: `1px solid ${T.border}`, margin: '6px 0' }} />
      <SheetItem icon={User} label="Account" onClick={() => userAction('account')} />
      {isAdmin && (
        <SheetItem icon={ShieldCheck} label="Admin console" onClick={() => userAction('admin')} />
      )}
      <SheetItem icon={LogOut} label="Log out" tone="danger" onClick={() => userAction('logout')} />
    </Sheet>
  );
}

function StickyBookBar({ book }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 16px',
        borderTop: `1px solid ${T.border}`,
        background: '#fff',
        flexShrink: 0,
      }}
    >
      <div>
        <div style={{ fontSize: 16, fontWeight: 700, color: T.text }}>
          A$180<span style={{ fontSize: 12, fontWeight: 500, color: T.text3 }}>/hr</span>
        </div>
        <div style={{ fontSize: 11, color: T.text3 }}>Next: today 2:30 pm</div>
      </div>
      <Btn variant="gradient" size="lg" onClick={book} style={{ marginLeft: 'auto' }}>
        Book a consultation
      </Btn>
    </div>
  );
}

function AppMobile(p) {
  const { page, nav, activeKey, callBg, go, crumbs, joinCall, book } = p;
  const [more, setMore] = useState(false);
  const tabs = nav.primary.filter((i) => !MOBILE_HIDDEN.includes(i.key)).slice(0, 4);
  const moreItems = [...nav.primary.filter((i) => !tabs.includes(i)), ...nav.secondary];
  const moreActive = more || !tabs.some((t) => t.key === activeKey);
  const nav2 = (k) => {
    setMore(false);
    go(k);
  };
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#fff',
        fontFamily: T.font,
        color: T.text,
        position: 'relative',
      }}
    >
      <MobileTopBar
        title={crumbs[crumbs.length - 1]}
        back={crumbs.length > 1 ? () => go(activeKey) : null}
        right={
          <Fragment>
            <IconBtn>
              <Search size={18} />
            </IconBtn>
            <IconBtn dot>
              <Bell size={18} />
            </IconBtn>
          </Fragment>
        }
      />
      {callBg && <CallPill mobile onReturn={joinCall} />}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div key={page} className="bn-page">
          <PageBody {...p} mobile />
        </div>
      </div>
      {page === 'expertProfile' && <StickyBookBar book={book} />}
      <BottomTabs
        tabs={tabs}
        activeKey={activeKey}
        go={go}
        onMore={() => setMore(true)}
        moreActive={moreActive}
      />
      {more && (
        <MoreSheet
          items={moreItems}
          go={nav2}
          onClose={() => setMore(false)}
          ws={p.ws}
          mode={p.mode}
          switchWs={(k) => {
            setMore(false);
            p.switchWs(k);
          }}
          toggleMode={(m) => {
            setMore(false);
            p.toggleMode(m);
          }}
          fork1={p.fork1}
          isAdmin={p.isAdmin}
          userAction={(a) => {
            setMore(false);
            p.userAction(a);
          }}
        />
      )}
    </div>
  );
}

/* ───────────────────────────── shells: marketing ───────────────────────────── */
function MarketingDesktop({ auth, page, go, startAuth, say, children }) {
  const links = [
    ['experts', 'Find experts'],
    ['how', 'How it works'],
    ['forExperts', 'For experts'],
    ['pricing', 'Pricing'],
  ];
  const active = page === 'experts' || page === 'expertProfile';
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#fff',
        fontFamily: T.font,
        color: T.text,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <header
        style={{
          height: 64,
          borderBottom: `1px solid ${T.border}`,
          display: 'flex',
          alignItems: 'center',
          padding: '0 40px',
          gap: 36,
          background: 'rgba(255,255,255,.9)',
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => go('home')}
          style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }}
        >
          <Logo />
        </button>
        <nav style={{ display: 'flex', gap: 26, fontSize: 13.5, fontWeight: 500 }}>
          {links.map(([k, l]) => (
            <button
              key={k}
              onClick={() =>
                k === 'experts' ? go('experts') : say(`${l}: marketing page, not mocked`)
              }
              className="bn-link"
              style={{
                border: 0,
                background: 'transparent',
                cursor: 'pointer',
                padding: 0,
                fontFamily: T.font,
                fontSize: 13.5,
                fontWeight: k === 'experts' && active ? 600 : 500,
                color: k === 'experts' && active ? T.text : T.text2,
              }}
            >
              {l}
            </button>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        {auth === 'in' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <IconBtn dot>
              <Bell size={16} />
            </IconBtn>
            <Btn variant="outline" onClick={() => go('dashboard')}>
              <LayoutDashboard size={14} /> Dashboard
            </Btn>
            <button
              onClick={() => go('dashboard')}
              style={{
                border: 0,
                background: 'transparent',
                padding: 0,
                cursor: 'pointer',
                marginLeft: 4,
              }}
            >
              <Avatar initials="YJ" gradient size={32} radius={16} />
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Btn variant="ghost" onClick={() => startAuth('login')}>
              Log in
            </Btn>
            <Btn variant="gradient" onClick={() => startAuth('signup')}>
              Get started
            </Btn>
          </div>
        )}
      </header>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div key={page} className="bn-page">
          {children}
        </div>
      </div>
    </div>
  );
}

function MarketingMobile({ auth, page, go, startAuth, say, book, children }) {
  const [open, setOpen] = useState(false);
  const links = [
    ['experts', 'Find experts'],
    ['how', 'How it works'],
    ['forExperts', 'For experts'],
    ['pricing', 'Pricing'],
  ];
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#fff',
        fontFamily: T.font,
        color: T.text,
        position: 'relative',
      }}
    >
      <header
        style={{
          height: 56,
          display: 'flex',
          alignItems: 'center',
          padding: '0 8px 0 16px',
          gap: 4,
          borderBottom: `1px solid ${T.border}`,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => go('home')}
          style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }}
        >
          <Logo />
        </button>
        <div style={{ flex: 1 }} />
        {auth === 'in' ? (
          <Fragment>
            <IconBtn dot>
              <Bell size={18} />
            </IconBtn>
            <button
              onClick={() => go('dashboard')}
              style={{ border: 0, background: 'transparent', padding: 4, cursor: 'pointer' }}
            >
              <Avatar initials="YJ" gradient size={30} radius={15} />
            </button>
          </Fragment>
        ) : (
          <Btn variant="ghost" size="sm" onClick={() => startAuth('login')}>
            Log in
          </Btn>
        )}
        <IconBtn onClick={() => setOpen(true)}>
          <Menu size={20} />
        </IconBtn>
      </header>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <div key={page} className="bn-page">
          {children}
        </div>
      </div>
      {page === 'expertProfile' && <StickyBookBar book={book} />}
      {open && (
        <Sheet onClose={() => setOpen(false)}>
          {links.map(([k, l]) => (
            <SheetItem
              key={k}
              icon={
                k === 'experts'
                  ? Search
                  : k === 'forExperts'
                    ? Sparkles
                    : k === 'pricing'
                      ? Wallet
                      : LifeBuoy
              }
              label={l}
              onClick={() => {
                setOpen(false);
                if (k === 'experts') go('experts');
                else say(`${l}: marketing page, not mocked`);
              }}
            />
          ))}
          <div style={{ borderTop: `1px solid ${T.border}`, margin: '6px 0 12px' }} />
          {auth === 'in' ? (
            <Fragment>
              <SheetItem
                icon={LayoutDashboard}
                label="Dashboard"
                onClick={() => {
                  setOpen(false);
                  go('dashboard');
                }}
              />
              <SheetItem
                icon={MessageSquare}
                label="Messages"
                badge={3}
                onClick={() => {
                  setOpen(false);
                  go('messages');
                }}
              />
            </Fragment>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 4px' }}>
              <Btn
                variant="gradient"
                size="lg"
                full
                onClick={() => {
                  setOpen(false);
                  startAuth('signup');
                }}
              >
                Get started
              </Btn>
              <Btn
                variant="outline"
                size="lg"
                full
                onClick={() => {
                  setOpen(false);
                  startAuth('login');
                }}
              >
                Log in
              </Btn>
            </div>
          )}
        </Sheet>
      )}
    </div>
  );
}

function PublicBody(p) {
  const { page, mobile } = p;
  if (page === 'home')
    return <HomeBody mobile={mobile} go={p.go} startAuth={p.startAuth} auth={p.auth} />;
  if (page === 'experts') return <DirectoryBody mobile={mobile} go={p.go} />;
  return <ProfileBody mobile={mobile} book={p.book} />;
}

/* ───────────────────────────── shells: auth · call · admin ───────────────────────────── */
function AuthScreen({ mobile, signIn, returnTo, go }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: T.muted,
        fontFamily: T.font,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ height: 64, display: 'flex', alignItems: 'center', padding: '0 24px' }}>
        <button
          onClick={() => go('home')}
          style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0 }}
        >
          <Logo />
        </button>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: mobile ? 'flex-start' : 'center',
          justifyContent: 'center',
          padding: mobile ? '16px 20px' : 24,
        }}
      >
        <Card style={{ width: 380, maxWidth: '100%', padding: 24 }}>
          <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-.02em', color: T.text }}>
            Welcome back
          </div>
          <div style={{ fontSize: 13, color: T.text3, marginTop: 4 }}>
            {returnTo ? 'Sign in to book with Priya Nair.' : 'Sign in to your Balo account.'}
          </div>
          <div style={{ marginTop: 18, fontSize: 12, fontWeight: 600, color: T.text2 }}>
            Work email
          </div>
          <div
            style={{
              height: 38,
              borderRadius: 8,
              border: `1px solid ${T.border}`,
              background: '#fff',
              marginTop: 6,
              display: 'flex',
              alignItems: 'center',
              padding: '0 10px',
              fontSize: 13,
              color: T.text3,
            }}
          >
            yomi@acme.com
          </div>
          <Btn variant="solid" full size="lg" onClick={signIn} style={{ marginTop: 12 }}>
            Continue with email
          </Btn>
          <Btn variant="outline" full size="lg" onClick={signIn} style={{ marginTop: 8 }}>
            Continue with Google
          </Btn>
          {returnTo && (
            <div style={{ marginTop: 14, fontSize: 11.5, color: T.text3, textAlign: 'center' }}>
              After sign-in you land back on the profile with the booking open.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function CallScreen({ mobile, leaveCall, minimizeCall }) {
  const controls = [
    ['mic', Mic],
    ['cam', Camera],
    ['share', Monitor],
    ['chat', MessageSquare],
    ['leave', PhoneOff, true],
  ];
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: '#0b1220',
        color: '#fff',
        fontFamily: T.font,
        display: 'flex',
        flexDirection: 'column',
        padding: mobile ? 14 : 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span
          className="bn-live"
          style={{ width: 8, height: 8, borderRadius: 4, background: T.green }}
        />
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>Case #1042 · Acme Corp × Priya Nair</span>
        <span style={{ fontSize: 12.5, fontFamily: T.mono, color: '#94a3b8' }}>12:34</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={minimizeCall}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            fontWeight: 600,
            color: '#e2e8f0',
            background: 'rgba(255,255,255,.08)',
            border: '1px solid rgba(255,255,255,.12)',
            borderRadius: 8,
            padding: '6px 10px',
            cursor: 'pointer',
            fontFamily: T.font,
          }}
        >
          <Minimize2 size={13} /> Minimize
        </button>
      </div>
      <div
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : '1fr 1fr',
          gap: 12,
        }}
      >
        {[
          ['PN', 'Priya Nair', 'linear-gradient(135deg,#1e293b,#312e81)'],
          ['YJ', 'Yomi Joseph (you)', 'linear-gradient(135deg,#0f172a,#1e3a8a)'],
        ].map(([i, n, bg]) => (
          <div
            key={n}
            style={{
              borderRadius: 16,
              background: bg,
              position: 'relative',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: mobile ? 220 : 0,
            }}
          >
            <Avatar initials={i} size={64} gradient radius={32} />
            <span
              style={{
                position: 'absolute',
                left: 12,
                bottom: 10,
                fontSize: 12,
                fontWeight: 600,
                background: 'rgba(0,0,0,.4)',
                padding: '3px 8px',
                borderRadius: 6,
              }}
            >
              {n}
            </span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 12, marginTop: 16 }}>
        {controls.map(([k, Icon, danger]) => (
          <button
            key={k}
            onClick={danger ? leaveCall : undefined}
            title={danger ? 'Leave' : k}
            style={{
              width: 48,
              height: 48,
              borderRadius: 24,
              border: 0,
              background: danger ? T.red : 'rgba(255,255,255,.12)',
              color: '#fff',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <Icon size={20} />
          </button>
        ))}
      </div>
      <div style={{ textAlign: 'center', fontSize: 11.5, color: '#64748b', marginTop: 10 }}>
        Balo Video · Daily call object · no app chrome
      </div>
    </div>
  );
}

const ADMIN_NAV = [
  ['Overview', LayoutDashboard],
  ['Users', Users],
  ['Experts', Sparkles, 4],
  ['Companies', Building2],
  ['Engagements', Briefcase],
  ['Meetings', Video],
  ['Credits ledger', Wallet],
  ['Payouts', Wallet],
  ['Notifications', BellRing],
  ['Taxonomies', Tags],
  ['Audit log', ScrollText],
];

function AdminDesktop({ go }) {
  return (
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        background: '#fff',
        fontFamily: T.font,
        color: T.text,
      }}
    >
      <aside
        style={{
          width: 232,
          background: '#0f172a',
          color: '#e2e8f0',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            padding: '16px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            borderBottom: '1px solid rgba(255,255,255,.08)',
          }}
        >
          <Logo light />
          <Pill tone="amber">Admin</Pill>
        </div>
        <nav style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {ADMIN_NAV.map(([l, Icon, b], i) => (
            <div
              key={l}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '7px 10px',
                borderRadius: 7,
                fontSize: 12.5,
                fontWeight: i === 4 ? 600 : 500,
                background: i === 4 ? 'rgba(255,255,255,.1)' : 'transparent',
                color: i === 4 ? '#fff' : '#cbd5e1',
              }}
            >
              <Icon size={15} /> {l}
              {b ? (
                <span style={{ marginLeft: 'auto' }}>
                  <Badge n={b} />
                </span>
              ) : null}
            </div>
          ))}
        </nav>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => go('dashboard')}
          style={{
            margin: 12,
            padding: '8px 10px',
            borderRadius: 7,
            border: '1px solid rgba(255,255,255,.14)',
            background: 'transparent',
            color: '#e2e8f0',
            fontSize: 12.5,
            fontWeight: 600,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontFamily: T.font,
          }}
        >
          <ArrowLeft size={14} /> Back to the app
        </button>
      </aside>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header
          style={{
            height: 56,
            borderBottom: `1px solid ${T.border}`,
            display: 'flex',
            alignItems: 'center',
            padding: '0 20px',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 13, fontWeight: 600 }}>Engagements</span>
          <ChevronRight size={13} color={T.text3} />
          <span style={{ fontSize: 13, color: T.text3 }}>Case #1042</span>
          <span style={{ flex: 1 }} />
          <IconBtn>
            <Search size={16} />
          </IconBtn>
        </header>
        <main style={{ padding: '24px 28px', flex: 1, overflow: 'auto' }}>
          <PageHead
            title="Case #1042 · Service Cloud routing"
            desc="Acme Corp × Priya Nair · scheduled today 2:30 pm"
          />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3,1fr)',
              gap: 12,
              maxWidth: 720,
            }}
          >
            {[
              ['Client pays', 'A$180/hr'],
              ['Expert earns', 'A$150/hr'],
              ['Balo margin', 'A$30/hr · 16.7%'],
            ].map(([l, v], i) => (
              <Card
                key={l}
                style={{
                  padding: 14,
                  background: i === 2 ? T.amberLight : '#fff',
                  borderColor: i === 2 ? T.amberBorder : T.border,
                }}
              >
                <div style={{ fontSize: 11.5, color: T.text3, fontWeight: 600 }}>{l}</div>
                <div
                  style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-.02em', marginTop: 4 }}
                >
                  {v}
                </div>
              </Card>
            ))}
          </div>
          <div style={{ fontSize: 12, color: T.amber, marginTop: 10, fontWeight: 500 }}>
            Margin is visible here and nowhere else. Serializer boundary enforces it.
          </div>
          <Card style={{ marginTop: 20, padding: 0, overflow: 'hidden' }}>
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.5fr 1fr 1fr 1fr',
                  gap: 12,
                  padding: '12px 14px',
                  borderBottom: `1px solid ${T.border}`,
                }}
              >
                <Sk h={11} />
                <Sk h={11} w="70%" />
                <Sk h={11} w="50%" />
                <Sk h={11} w="60%" />
              </div>
            ))}
          </Card>
        </main>
      </div>
    </div>
  );
}

function AdminMobile({ go }) {
  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        textAlign: 'center',
        fontFamily: T.font,
        background: '#0f172a',
        color: '#e2e8f0',
      }}
    >
      <ShieldCheck size={32} color="#94a3b8" />
      <div style={{ fontSize: 16, fontWeight: 600, marginTop: 12 }}>
        Admin console is desktop-only in V1
      </div>
      <div style={{ fontSize: 12.5, color: '#94a3b8', marginTop: 6 }}>
        Approval queues and ledgers need the width. Alerts still reach you by email and in-app.
      </div>
      <Btn variant="outline" onClick={() => go('dashboard')} style={{ marginTop: 18 }}>
        Back to the app
      </Btn>
    </div>
  );
}

/* ───────────────────────────── frames ───────────────────────────── */
function ScaledFrame({ width, height, center, children }) {
  const ref = useRef(null);
  const [scale, setScale] = useState(1);
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth) setScale(Math.min(1, el.clientWidth / width));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <div
        style={{
          height: Math.round(height * scale),
          position: 'relative',
          width: center ? Math.round(width * scale) : '100%',
          margin: center ? '0 auto' : 0,
        }}
      >
        <div
          style={{
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            position: 'absolute',
            top: 0,
            left: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function PhoneFrame({ children }) {
  return (
    <div
      style={{
        width: 410,
        height: 840,
        borderRadius: 46,
        background: '#0f172a',
        padding: 10,
        boxShadow: '0 30px 80px rgba(15,23,42,.35)',
      }}
    >
      <div
        style={{
          width: 390,
          height: 820,
          borderRadius: 38,
          overflow: 'hidden',
          background: '#fff',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            height: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 26px',
            fontSize: 13,
            fontWeight: 600,
            color: T.text,
            fontFamily: T.font,
            flexShrink: 0,
          }}
        >
          <span>9:41</span>
          <span style={{ fontFamily: T.mono, fontSize: 11 }}>●●● ▲ ▮</span>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {children}
        </div>
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 120,
            height: 5,
            borderRadius: 3,
            background: 'rgba(15,23,42,.3)',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}

function Toast({ msg }) {
  return (
    <div
      className="bn-toast"
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 22,
        transform: 'translateX(-50%)',
        background: '#0f172a',
        color: '#fff',
        fontSize: 12.5,
        fontWeight: 500,
        padding: '9px 14px',
        borderRadius: 10,
        boxShadow: '0 10px 30px rgba(15,23,42,.3)',
        zIndex: 50,
        whiteSpace: 'nowrap',
        fontFamily: T.font,
      }}
    >
      {msg}
    </div>
  );
}

/* ───────────────────────────── explorer toolbar ───────────────────────────── */
function Seg({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div
        style={{
          fontSize: 10,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: '#94a3b8',
          fontFamily: T.mono,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'inline-flex',
          background: '#1e293b',
          borderRadius: 7,
          padding: 2,
          gap: 2,
        }}
      >
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="bn-press"
            style={{
              fontSize: 11.5,
              fontWeight: 600,
              padding: '4px 9px',
              borderRadius: 5,
              border: 0,
              cursor: 'pointer',
              background: value === o.value ? '#f8fafc' : 'transparent',
              color: value === o.value ? '#0f172a' : '#cbd5e1',
              fontFamily: T.font,
              whiteSpace: 'nowrap',
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
function Toggle({ label, on, onChange, disabled }) {
  return (
    <button
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="bn-press"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 11.5,
        fontWeight: 600,
        padding: '4px 9px 4px 6px',
        borderRadius: 6,
        border: `1px solid ${on ? '#64748b' : '#334155'}`,
        background: on ? '#334155' : 'transparent',
        color: disabled ? '#475569' : on ? '#f8fafc' : '#cbd5e1',
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: T.font,
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 22,
          height: 12,
          borderRadius: 6,
          background: on ? T.primary : '#1e293b',
          position: 'relative',
          display: 'inline-block',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: on ? 12 : 2,
            width: 8,
            height: 8,
            borderRadius: 4,
            background: '#fff',
            transition: 'left .15s',
          }}
        />
      </span>
      {label}
    </button>
  );
}

/* ───────────────────────────── root ───────────────────────────── */
export default function BaloNavExplorer({ initial = {} }) {
  const [auth, setAuth] = useState(initial.auth || 'in');
  const [viewport, setViewport] = useState(initial.viewport || 'desktop');
  const [wsKey, setWsKey] = useState(initial.workspace || 'expert');
  const [page, setPage] = useState(initial.page || 'dashboard');
  const [fork1, setFork1] = useState(initial.fork1 || 'workspace');
  const [fork2, setFork2] = useState(initial.fork2 || 'marketing');
  const [fork3, setFork3] = useState(initial.fork3 || 'type');
  const [collapsed, setCollapsed] = useState(!!initial.collapsed);
  const [callBg, setCallBg] = useState(!!initial.callBg);
  const [isAdmin, setIsAdmin] = useState(initial.isAdmin ?? true);
  const [returnTo, setReturnTo] = useState(null);
  const [toast, setToast] = useState(null);
  const [tab, setTab] = useState(0);

  const ws = WS[wsKey];
  const mode = ws.mode;
  const nav = buildNav(mode, fork3);
  const pages = availablePages(auth, mode, fork3, isAdmin);
  const pagesKey = pages.join(',');

  useEffect(() => {
    if (!pages.includes(page)) setPage(auth === 'out' ? 'home' : 'dashboard');
  }, [pagesKey, page, auth]);
  useEffect(() => {
    setTab(0);
  }, [page]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  const say = (m) => setToast(m);
  const go = (key) => {
    if (key === 'help') {
      say('Opens the help centre in a new tab');
      return;
    }
    setPage(key);
  };
  const switchWs = (k) => {
    const m = WS[k].mode;
    setWsKey(k);
    setPage((p) =>
      m === 'client' && p === 'expertSettings'
        ? 'settings'
        : m === 'expert' && p === 'settings'
          ? 'expertSettings'
          : m === 'client' && p === 'calendar'
            ? 'dashboard'
            : p
    );
  };
  const toggleMode = (m) => switchWs(m === 'expert' ? 'expert' : 'acme');
  const changeOrg = (v) => {
    setFork3(v);
    setPage((p) => ORG_MAP[v][p] || p);
  };
  const changeAuth = (v) => {
    setAuth(v);
    setCallBg(false);
    setPage(v === 'out' ? 'home' : 'dashboard');
  };
  const signIn = () => {
    setAuth('in');
    setPage(returnTo || 'dashboard');
    if (returnTo) say('Signed in. Back where you started, booking open.');
    setReturnTo(null);
  };
  const signOut = () => {
    setAuth('out');
    setPage('home');
    setCallBg(false);
  };
  const startAuth = (kind, ret) => {
    setReturnTo(ret || null);
    setPage('auth');
    if (kind === 'signup') say('Same screen, sign-up variant');
  };
  const book = () => {
    if (auth === 'out') startAuth('login', 'expertProfile');
    else say('Booking modal opens. Step 1: availability calendar');
  };
  const userAction = (a) => {
    if (a === 'account') setPage('account');
    if (a === 'admin') setPage('admin');
    if (a === 'logout') signOut();
  };
  const joinCall = () => {
    setCallBg(false);
    setPage('inCall');
  };
  const minimizeCall = () => {
    setCallBg(true);
    setPage('dashboard');
  };
  const leaveCall = () => {
    setCallBg(false);
    setPage('caseDetail');
  };

  const shell = resolveShell(page, auth, fork2);
  const meta = PAGE_META[page];
  const parentKey = page === 'caseDetail' ? (fork3 === 'type' ? 'consultations' : 'work') : null;
  const activeKey = page === 'caseDetail' ? parentKey : page === 'expertProfile' ? 'experts' : page;
  const crumbs =
    page === 'caseDetail'
      ? [PAGE_META[parentKey].title, meta.title]
      : page === 'expertProfile'
        ? ['Find experts', 'Priya Nair']
        : [meta.title];
  const note = noteFor({ shell, page, auth, fork1, fork2, viewport, mode, ws });

  const fp = {
    page,
    meta,
    tab,
    setTab,
    mode,
    ws,
    nav,
    activeKey,
    crumbs,
    fork1,
    fork2,
    fork3,
    isAdmin,
    collapsed,
    setCollapsed,
    callBg,
    auth,
    returnTo,
    go,
    switchWs,
    toggleMode,
    signIn,
    signOut,
    startAuth,
    book,
    userAction,
    joinCall,
    minimizeCall,
    leaveCall,
    say,
  };

  const renderShell = (mobile) => {
    if (shell === 'call') return <CallScreen mobile={mobile} {...fp} />;
    if (shell === 'auth') return <AuthScreen mobile={mobile} {...fp} />;
    if (shell === 'admin') return mobile ? <AdminMobile {...fp} /> : <AdminDesktop {...fp} />;
    if (shell === 'marketing')
      return mobile ? (
        <MarketingMobile {...fp}>
          <PublicBody mobile {...fp} />
        </MarketingMobile>
      ) : (
        <MarketingDesktop {...fp}>
          <PublicBody {...fp} />
        </MarketingDesktop>
      );
    return mobile ? <AppMobile {...fp} /> : <AppDesktop {...fp} />;
  };

  const chip = (k) => (
    <button
      key={k}
      onClick={() => setPage(k)}
      className="bn-press bn-chip"
      style={{
        fontSize: 11.5,
        fontWeight: 600,
        padding: '4px 9px',
        borderRadius: 999,
        border: `1px solid ${page === k ? '#f8fafc' : '#334155'}`,
        background: page === k ? '#f8fafc' : 'transparent',
        color: page === k ? '#0f172a' : '#cbd5e1',
        cursor: 'pointer',
        fontFamily: T.font,
        whiteSpace: 'nowrap',
      }}
    >
      {CHIP_LABEL[k] || PAGE_META[k].title}
    </button>
  );

  return (
    <div
      style={{
        fontFamily: T.font,
        background: '#f1f5f9',
        minHeight: '100vh',
        padding: 16,
        color: T.text,
      }}
    >
      <style>{STYLE}</style>
      <div
        style={{
          background: '#0f172a',
          borderRadius: 12,
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-end' }}>
          <Seg
            label="Session"
            value={auth}
            onChange={changeAuth}
            options={[
              { value: 'out', label: 'Signed out' },
              { value: 'in', label: 'Signed in' },
            ]}
          />
          <Seg
            label="Viewport"
            value={viewport}
            onChange={setViewport}
            options={[
              { value: 'desktop', label: 'Desktop' },
              { value: 'mobile', label: 'Mobile' },
            ]}
          />
          {auth === 'in' && (
            <Seg
              label="Workspace"
              value={wsKey}
              onChange={switchWs}
              options={[
                { value: 'expert', label: 'Expert' },
                { value: 'acme', label: 'Acme Corp · client' },
                { value: 'globex', label: 'Globex · represented' },
              ]}
            />
          )}
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Toggle
              label="Collapsed sidebar"
              on={collapsed}
              onChange={setCollapsed}
              disabled={viewport !== 'desktop'}
            />
            <Toggle
              label="Call in background"
              on={callBg}
              onChange={setCallBg}
              disabled={auth !== 'in'}
            />
            <Toggle
              label="Admin capability"
              on={isAdmin}
              onChange={setIsAdmin}
              disabled={auth !== 'in'}
            />
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-end' }}>
          <Seg
            label="Fork 1 · context switcher"
            value={fork1}
            onChange={setFork1}
            options={[
              { value: 'pill', label: 'Mode pill (today)' },
              { value: 'workspace', label: 'Workspace switcher' },
            ]}
          />
          <Seg
            label="Fork 2 · public pages when signed in"
            value={fork2}
            onChange={setFork2}
            options={[
              { value: 'marketing', label: 'B · Marketing chrome' },
              { value: 'adaptive', label: 'A · Adaptive app chrome' },
            ]}
          />
          <Seg
            label="Fork 3 · primary nav"
            value={fork3}
            onChange={changeOrg}
            options={[
              { value: 'type', label: 'By engagement type' },
              { value: 'lifecycle', label: 'By lifecycle' },
            ]}
          />
        </div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            alignItems: 'center',
            borderTop: '1px solid #1e293b',
            paddingTop: 10,
          }}
        >
          <span
            style={{
              fontSize: 10,
              letterSpacing: '.08em',
              textTransform: 'uppercase',
              color: '#94a3b8',
              fontFamily: T.mono,
              marginRight: 6,
            }}
          >
            Page
          </span>
          {pages.map(chip)}
        </div>
      </div>
      <div
        style={{
          fontFamily: T.mono,
          fontSize: 11.5,
          color: '#475569',
          padding: '10px 4px 12px',
          lineHeight: 1.5,
        }}
      >
        ▸ {note}
      </div>
      {viewport === 'desktop' ? (
        <ScaledFrame width={1280} height={820}>
          <div
            style={{
              width: 1280,
              height: 820,
              borderRadius: 12,
              overflow: 'hidden',
              border: `1px solid ${T.border}`,
              boxShadow: '0 20px 60px rgba(15,23,42,.12)',
              position: 'relative',
              background: '#fff',
            }}
          >
            {renderShell(false)}
            {toast && <Toast msg={toast} />}
          </div>
        </ScaledFrame>
      ) : (
        <ScaledFrame width={410} height={840} center>
          <PhoneFrame>
            {renderShell(true)}
            {toast && <Toast msg={toast} />}
          </PhoneFrame>
        </ScaledFrame>
      )}
    </div>
  );
}
