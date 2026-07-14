import React, { useState, useEffect, useRef } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  MonitorUp,
  MessageSquare,
  Users,
  Paperclip,
  MoreHorizontal,
  PhoneOff,
  Settings,
  UserPlus,
  Copy,
  Send,
  Signal,
  Loader2,
  X,
  Check,
  Download,
  FileText,
  Image as ImageIcon,
  Hand,
  Smile,
  Link2,
  Mail,
  Pin,
  ShieldCheck,
  Plus,
  LayoutGrid,
  ChevronDown,
  Maximize2,
  Minimize2,
} from 'lucide-react';

/**
 * Balo — In-meeting UI (design reference for BAL-132)
 * Reference language: Google Meet + Zoom. Goal: nothing to learn.
 *
 * Mobile priority order (constrained space → drop least-important first):
 *   Stage:  in share mode, the shared screen is the whole point → tiles/people
 *           list are dropped on mobile.
 *   Toolbar: Mic · Camera · Chat · Leave stay; Share / Files / People / React /
 *           Settings collapse into "More".
 *
 * Baked-in decisions / drift fixes:
 *   - Trust-by-default (BAL-134): email invitees drop straight in; link joiners
 *     wait in "Waiting to join" with host Admit.
 *   - Elapsed-time only in-call (no live cost meter).
 *   - Chat is Ably-backed (corrects Feb-era Supabase-Realtime line).
 *   - Files persist to R2 (balo-files), attached to the meeting record.
 *   - "Case" generalised to the engagement context.
 *   - Scoped gradient NOT used on controls; blue #2563EB is the only accent.
 */

const C = {
  bg: '#0B0E13',
  stage: '#0F131C',
  tile: '#1A202B',
  tileVideo: '#20293a',
  panel: '#12171F',
  input: '#1B222D',
  sheet: '#171C25',
  line: 'rgba(255,255,255,0.08)',
  line2: 'rgba(255,255,255,0.14)',
  text: '#E8ECF3',
  sub: '#98A2B3',
  faint: '#68717F',
  brand: '#2563EB',
  brandSoft: 'rgba(37,99,235,0.16)',
  danger: '#F0453A',
  dangerSoft: 'rgba(240,69,58,0.16)',
  good: '#2FBF71',
};

const PEOPLE = {
  expert: { name: 'Dr. Amara Okafor', initials: 'AO', hue: '#7C3AED', role: 'Expert' },
  client: { name: 'Jordan Lee', initials: 'JL', hue: '#0EA5E9', role: 'Client' },
  guest: { name: 'Sam Rivera', initials: 'SR', hue: '#F59E0B', role: 'Guest' },
};

/* ---------- primitives ---------- */

function Avatar({ p, size = 40 }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: size,
        background: p.hue,
        color: '#fff',
        fontSize: size * 0.36,
      }}
    >
      {p.initials}
    </div>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg p-1"
      style={{ background: '#0d1017', border: `1px solid ${C.line}` }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            style={{ background: active ? C.brand : 'transparent', color: active ? '#fff' : C.sub }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* desktop control — icon-only, tooltip on hover */
function Tool({ icon: Icon, label, active, danger, onClick }) {
  const bg = danger ? C.dangerSoft : active ? C.brandSoft : 'rgba(255,255,255,0.06)';
  const fg = danger ? C.danger : active ? '#7AA7FF' : C.text;
  return (
    <button
      onClick={onClick}
      title={label}
      className="flex items-center justify-center transition-colors"
      style={{
        width: 48,
        height: 48,
        borderRadius: 14,
        background: bg,
        border: `1px solid ${active || danger ? 'transparent' : C.line}`,
      }}
    >
      <Icon size={20} color={fg} />
    </button>
  );
}

/* mobile icon-only control */
function CircleBtn({ icon: Icon, active, danger, onClick, size = 46 }) {
  const bg = danger ? C.danger : active ? C.brand : 'rgba(255,255,255,0.08)';
  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center justify-center"
      style={{ width: size, height: size, borderRadius: size, background: bg }}
    >
      <Icon size={20} color="#fff" />
    </button>
  );
}

function LeaveBtn({ lens, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center gap-2 rounded-2xl text-sm font-medium"
      style={{ height: 48, padding: '0 18px', background: C.danger, color: '#fff' }}
    >
      <PhoneOff size={18} /> {lens === 'expert' ? 'End' : 'Leave'}
    </button>
  );
}

/* ---------- stage ---------- */

function Tile({ p, big, camOn = true, muted, speaking, you }) {
  return (
    <div
      className="relative overflow-hidden"
      style={{
        borderRadius: big ? 18 : 12,
        background: camOn ? C.tileVideo : C.tile,
        border: speaking ? `2px solid ${C.brand}` : `1px solid ${C.line}`,
        aspectRatio: big ? undefined : '16 / 10',
        height: big ? '100%' : undefined,
        width: '100%',
        backgroundImage: camOn
          ? `radial-gradient(120% 120% at 30% 20%, ${p.hue}22, transparent 55%), radial-gradient(140% 140% at 80% 100%, #ffffff10, transparent 50%)`
          : 'none',
      }}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        {camOn ? <Avatar p={p} size={big ? 96 : 52} /> : <Avatar p={p} size={big ? 84 : 46} />}
      </div>
      <div
        className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-lg px-2.5 py-1"
        style={{ background: 'rgba(0,0,0,0.55)' }}
      >
        {muted && <MicOff size={13} color={C.danger} />}
        <span className="text-xs font-medium" style={{ color: '#fff' }}>
          {you ? 'You' : p.name}
        </span>
        {p.role === 'Expert' && (
          <span
            className="rounded px-1.5 text-xs"
            style={{ background: C.brandSoft, color: '#7AA7FF' }}
          >
            Host
          </span>
        )}
      </div>
    </div>
  );
}

function WaitingStage({ lens, onInvite }) {
  const other = lens === 'client' ? PEOPLE.expert : PEOPLE.client;
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-5 px-6 text-center">
      <div className="relative">
        <Avatar p={other} size={72} />
        <span
          className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full"
          style={{ width: 26, height: 26, background: C.stage }}
        >
          <Loader2 size={18} color={C.brand} className="animate-spin" />
        </span>
      </div>
      <div>
        <div className="text-lg font-semibold" style={{ color: C.text }}>
          Waiting for {other.name.split(' ').slice(-1)[0]} to join
        </div>
        <div className="mt-1 text-sm" style={{ color: C.sub, maxWidth: 320 }}>
          {lens === 'expert'
            ? "No waiting room — they'll drop straight in. The timer starts the moment they arrive."
            : "The consultation timer starts once your expert joins. You won't be charged for waiting."}
        </div>
      </div>
      <button
        onClick={onInvite}
        className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium"
        style={{
          background: 'rgba(255,255,255,0.06)',
          color: C.text,
          border: `1px solid ${C.line2}`,
        }}
      >
        <UserPlus size={16} /> Invite someone else
      </button>
    </div>
  );
}

function OneOnOne({ lens, micOn, camOn, mobile }) {
  const you = lens === 'client' ? PEOPLE.client : PEOPLE.expert;
  const other = lens === 'client' ? PEOPLE.expert : PEOPLE.client;
  return (
    <div className="relative h-full w-full">
      <Tile p={other} big speaking />
      <div
        className="absolute"
        style={{ right: mobile ? 12 : 16, bottom: mobile ? 12 : 16, width: mobile ? 112 : 190 }}
      >
        <Tile p={you} camOn={camOn} muted={!micOn} you />
      </div>
    </div>
  );
}

function Gallery({ lens, micOn, camOn }) {
  const you = lens === 'client' ? PEOPLE.client : PEOPLE.expert;
  const tiles = [
    { p: lens === 'client' ? PEOPLE.expert : PEOPLE.client, speaking: true },
    { p: PEOPLE.guest },
    { p: you, you: true, camOn, muted: !micOn },
  ];
  return (
    <div className="grid h-full w-full gap-3" style={{ gridTemplateColumns: '1fr 1fr' }}>
      {tiles.map((t, i) => (
        <Tile key={i} {...t} />
      ))}
      <div
        className="flex items-center justify-center rounded-xl"
        style={{ background: C.tile, border: `1px dashed ${C.line2}`, color: C.sub }}
      >
        <div className="flex flex-col items-center gap-1 text-sm">
          <Plus size={20} /> Invite
        </div>
      </div>
    </div>
  );
}

function ScreenShare({ lens, camOn, micOn, mobile, onFullscreen, expanded }) {
  const you = lens === 'client' ? PEOPLE.client : PEOPLE.expert;
  const presenter = lens === 'client' ? PEOPLE.expert : PEOPLE.client;

  const Screen = (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-2xl"
      style={{ background: '#0a0d14', border: `1px solid ${C.line}` }}
    >
      <div className="flex flex-col items-center gap-2" style={{ color: C.faint }}>
        <MonitorUp size={30} />
        <span className="text-sm">{presenter.name} is presenting</span>
      </div>
      <div
        className="absolute top-3 left-3 rounded-lg px-2.5 py-1 text-xs font-medium"
        style={{ background: C.brandSoft, color: '#7AA7FF' }}
      >
        Screen share
      </div>
    </div>
  );

  // mobile: shared screen is the whole point — no tile column
  if (mobile) return <div className="h-full w-full">{Screen}</div>;

  return (
    <div className="flex h-full w-full gap-3">
      <div className="flex-1">{Screen}</div>
      <div className="flex flex-col gap-3" style={{ width: 168 }}>
        <Tile p={presenter} />
        <Tile p={you} you camOn={camOn} muted={!micOn} />
      </div>
    </div>
  );
}

/* ---------- panels ---------- */

function PanelShell({ title, count, onClose, children, footer }) {
  return (
    <div className="flex h-full w-full flex-col" style={{ background: C.panel }}>
      <div
        className="flex shrink-0 items-center justify-between px-4 py-3.5"
        style={{ borderBottom: `1px solid ${C.line}` }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold" style={{ color: C.text }}>
            {title}
          </span>
          {count != null && (
            <span
              className="rounded px-1.5 py-0.5 text-xs"
              style={{ background: 'rgba(255,255,255,0.08)', color: C.sub }}
            >
              {count}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded-lg"
          style={{ width: 30, height: 30, color: C.sub }}
        >
          <X size={18} />
        </button>
      </div>
      <div className="flex-1 overflow-auto">{children}</div>
      {footer && (
        <div className="shrink-0 p-3" style={{ borderTop: `1px solid ${C.line}` }}>
          {footer}
        </div>
      )}
    </div>
  );
}

function ChatPanel({ onClose, messages, onSend }) {
  const [draft, setDraft] = useState('');
  const endRef = useRef(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);
  const send = () => {
    if (draft.trim()) {
      onSend(draft.trim());
      setDraft('');
    }
  };
  return (
    <PanelShell
      title="Chat"
      onClose={onClose}
      footer={
        <div
          className="flex items-end gap-2 rounded-xl px-2 py-1.5"
          style={{ background: C.input, border: `1px solid ${C.line}` }}
        >
          <button className="shrink-0 rounded-lg p-1.5" style={{ color: C.sub }}>
            <Paperclip size={17} />
          </button>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && send()}
            placeholder="Message everyone"
            className="flex-1 bg-transparent py-1 text-sm outline-none"
            style={{ color: C.text }}
          />
          <button
            onClick={send}
            className="flex shrink-0 items-center justify-center rounded-lg"
            style={{
              width: 32,
              height: 32,
              background: draft.trim() ? C.brand : 'rgba(255,255,255,0.06)',
            }}
          >
            <Send size={16} color={draft.trim() ? '#fff' : C.faint} />
          </button>
        </div>
      }
    >
      {messages.length === 0 ? (
        <Empty
          icon={MessageSquare}
          title="No messages yet"
          body="Say hello or drop a link — everyone in the call will see it."
        />
      ) : (
        <div className="flex flex-col gap-3.5 p-4">
          {messages.map((m, i) => (
            <div key={i} className="flex gap-2.5">
              <Avatar p={m.p} size={30} />
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium" style={{ color: C.text }}>
                    {m.you ? 'You' : m.p.name.split(' ')[0]}
                  </span>
                  <span className="text-xs" style={{ color: C.faint }}>
                    {m.time}
                  </span>
                </div>
                <div className="mt-0.5 text-sm leading-snug" style={{ color: '#C6CDD8' }}>
                  {m.text}
                </div>
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </PanelShell>
  );
}

function FilesPanel({ onClose, files }) {
  return (
    <PanelShell
      title="Files"
      count={files.length}
      onClose={onClose}
      footer={
        <button
          className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium"
          style={{ background: C.brand, color: '#fff' }}
        >
          <Plus size={16} /> Share a file
        </button>
      }
    >
      <div className="p-3">
        <div
          className="mb-3 flex flex-col items-center justify-center gap-1.5 rounded-xl py-6"
          style={{ border: `1px dashed ${C.line2}`, color: C.sub }}
        >
          <Paperclip size={18} />
          <span className="text-sm">Drop a file to share it with the call</span>
          <span className="text-xs" style={{ color: C.faint }}>
            Kept with this consultation afterwards
          </span>
        </div>
        {files.map((f, i) => (
          <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-2.5">
            <span
              className="flex shrink-0 items-center justify-center rounded-lg"
              style={{ width: 38, height: 38, background: 'rgba(255,255,255,0.06)' }}
            >
              <f.icon size={18} color={C.sub} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium" style={{ color: C.text }}>
                {f.name}
              </div>
              <div className="text-xs" style={{ color: C.faint }}>
                {f.by} · {f.size}
              </div>
            </div>
            <button className="shrink-0 rounded-lg p-2" style={{ color: C.sub }}>
              <Download size={16} />
            </button>
          </div>
        ))}
      </div>
    </PanelShell>
  );
}

function PeoplePanel({ onClose, lens }) {
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState('');
  const [copied, setCopied] = useState(false);
  const self = lens === 'client' ? PEOPLE.client : PEOPLE.expert;
  const other = lens === 'client' ? PEOPLE.expert : PEOPLE.client;
  const copy = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const Row = ({ p, tag, you, host, muted }) => (
    <div className="flex items-center gap-3 rounded-lg px-2 py-2">
      <Avatar p={p} size={34} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" style={{ color: C.text }}>
          {you ? 'You' : p.name}
          {host && (
            <span className="ml-2 text-xs" style={{ color: '#7AA7FF' }}>
              Host
            </span>
          )}
        </div>
        {tag && (
          <div className="text-xs" style={{ color: C.faint }}>
            {tag}
          </div>
        )}
      </div>
      {muted != null &&
        (muted ? <MicOff size={16} color={C.danger} /> : <Mic size={16} color={C.sub} />)}
    </div>
  );

  return (
    <PanelShell
      title="People"
      count={2}
      onClose={onClose}
      footer={
        <div className="flex flex-col gap-2">
          {!adding ? (
            <button
              onClick={() => setAdding(true)}
              className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium"
              style={{ background: C.brand, color: '#fff' }}
            >
              <UserPlus size={16} /> Add people
            </button>
          ) : (
            <div
              className="flex flex-col gap-2 rounded-xl p-2.5"
              style={{ background: C.input, border: `1px solid ${C.line}` }}
            >
              <div className="flex items-center gap-2">
                <Mail size={15} color={C.sub} />
                <input
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter an email address"
                  className="flex-1 bg-transparent text-sm outline-none"
                  style={{ color: C.text }}
                />
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setAdding(false);
                    setEmail('');
                  }}
                  className="flex-1 rounded-lg py-2 text-sm"
                  style={{ color: C.sub, background: 'rgba(255,255,255,0.05)' }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setAdding(false);
                    setEmail('');
                  }}
                  className="flex-1 rounded-lg py-2 text-sm font-medium"
                  style={{ background: C.brand, color: '#fff' }}
                >
                  Send invite
                </button>
              </div>
            </div>
          )}
          <button
            onClick={copy}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium"
            style={{
              background: 'rgba(255,255,255,0.06)',
              color: C.text,
              border: `1px solid ${C.line2}`,
            }}
          >
            {copied ? (
              <>
                <Check size={16} color={C.good} /> Link copied
              </>
            ) : (
              <>
                <Link2 size={16} /> Copy join link
              </>
            )}
          </button>
        </div>
      }
    >
      <div className="p-3">
        <Section label="In the call · 2" />
        <Row p={self} you muted={false} />
        <Row p={other} host={other.role === 'Expert'} muted={false} />
        <Section label="Invited · 1" />
        <Row p={PEOPLE.guest} tag="Invite sent — hasn't joined yet" />
        {lens === 'expert' && (
          <>
            <Section label="Waiting to join · 1" />
            <div
              className="flex items-center gap-3 rounded-lg px-2 py-2"
              style={{ background: C.brandSoft }}
            >
              <Avatar p={{ initials: 'TW', hue: '#64748b' }} size={34} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium" style={{ color: C.text }}>
                  Taylor Wu
                </div>
                <div className="text-xs" style={{ color: C.faint }}>
                  Joined with the link
                </div>
              </div>
              <button
                className="rounded-lg px-2.5 py-1.5 text-xs"
                style={{ color: C.sub, background: 'rgba(255,255,255,0.06)' }}
              >
                Deny
              </button>
              <button
                className="rounded-lg px-2.5 py-1.5 text-xs font-medium"
                style={{ background: C.brand, color: '#fff' }}
              >
                Admit
              </button>
            </div>
          </>
        )}
        <div
          className="mt-4 flex items-start gap-2 px-2 text-xs leading-relaxed"
          style={{ color: C.faint }}
        >
          <ShieldCheck size={14} className="mt-0.5 shrink-0" />
          <span>
            People you invite by email join straight away. Anyone using the link asks to be let in.
          </span>
        </div>
      </div>
    </PanelShell>
  );
}

function Section({ label }) {
  return (
    <div
      className="px-2 pt-3 pb-1 text-xs font-medium tracking-wide uppercase"
      style={{ color: C.faint }}
    >
      {label}
    </div>
  );
}

function Empty({ icon: Icon, title, body }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <span
        className="flex items-center justify-center rounded-2xl"
        style={{ width: 52, height: 52, background: 'rgba(255,255,255,0.05)' }}
      >
        <Icon size={22} color={C.sub} />
      </span>
      <div className="mt-1 text-sm font-medium" style={{ color: C.text }}>
        {title}
      </div>
      <div className="text-sm" style={{ color: C.faint }}>
        {body}
      </div>
    </div>
  );
}

/* ---------- more sheet (overflow controls) ---------- */

function MoreSheet({ items, mobile, onClose }) {
  return (
    <>
      <div
        onClick={onClose}
        className="absolute inset-0"
        style={{ background: 'rgba(0,0,0,0.45)', zIndex: 30 }}
      />
      <div
        className="absolute overflow-hidden"
        style={
          mobile
            ? {
                left: 12,
                right: 12,
                bottom: 96,
                borderRadius: 20,
                background: C.sheet,
                border: `1px solid ${C.line2}`,
                zIndex: 40,
              }
            : {
                right: 20,
                bottom: 104,
                width: 220,
                borderRadius: 16,
                background: C.sheet,
                border: `1px solid ${C.line2}`,
                zIndex: 40,
              }
        }
      >
        <div className="p-1.5">
          {items.map((it, i) => (
            <button
              key={i}
              onClick={() => {
                it.on();
                onClose();
              }}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3"
              style={{ color: C.text }}
            >
              <it.icon size={19} color={C.sub} />
              <span className="text-sm font-medium">{it.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/* ---------- chrome ---------- */

function TopBar({ stage, elapsed, onInfo }) {
  const live = ['oneOnOne', 'gallery', 'screenshare'].includes(stage);
  return (
    <div
      className="flex shrink-0 items-center justify-between px-4"
      style={{ height: 52, borderBottom: `1px solid ${C.line}` }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="truncate text-sm font-semibold" style={{ color: C.text }}>
          Salesforce CPQ consultation
        </span>
        <span
          className="hidden shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs sm:flex"
          style={{ background: 'rgba(255,255,255,0.06)', color: C.sub }}
        >
          {live ? (
            <>
              <span className="rounded-full" style={{ width: 6, height: 6, background: C.good }} />{' '}
              {fmt(elapsed)}
            </>
          ) : (
            <>Not started</>
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span
          className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
          style={{ color: C.sub }}
        >
          <Signal size={15} color={C.good} /> <span className="hidden sm:inline">Strong</span>
        </span>
        <button
          onClick={onInfo}
          className="flex items-center justify-center rounded-lg"
          style={{ width: 34, height: 34, color: C.sub }}
        >
          <Users size={18} />
        </button>
      </div>
    </div>
  );
}

function fmt(s) {
  const m = Math.floor(s / 60),
    ss = s % 60;
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/* ---------- prejoin ---------- */

function PreJoin({ lens, onJoin, onInvite }) {
  const you = lens === 'client' ? PEOPLE.client : PEOPLE.expert;
  const [cam, setCam] = useState(true);
  const [mic, setMic] = useState(true);
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="flex w-full flex-col items-center gap-5" style={{ maxWidth: 460 }}>
        <div
          className="relative w-full overflow-hidden rounded-2xl"
          style={{
            aspectRatio: '16 / 10',
            background: cam ? C.tileVideo : C.tile,
            border: `1px solid ${C.line}`,
            backgroundImage: cam
              ? `radial-gradient(120% 120% at 30% 20%, ${you.hue}22, transparent 55%)`
              : 'none',
          }}
        >
          <div className="absolute inset-0 flex items-center justify-center">
            {cam ? (
              <Avatar p={you} size={84} />
            ) : (
              <div className="flex flex-col items-center gap-2" style={{ color: C.sub }}>
                <VideoOff size={26} />
                <span className="text-sm">Camera off</span>
              </div>
            )}
          </div>
          <div className="absolute inset-x-0 bottom-3 flex items-center justify-center gap-2.5">
            <RoundToggle on={mic} onI={Mic} offI={MicOff} onClick={() => setMic(!mic)} />
            <RoundToggle on={cam} onI={Video} offI={VideoOff} onClick={() => setCam(!cam)} />
            <button
              className="flex items-center justify-center rounded-full"
              style={{ width: 44, height: 44, background: 'rgba(0,0,0,0.5)', color: '#fff' }}
            >
              <Settings size={19} />
            </button>
          </div>
        </div>
        <div className="text-center">
          <div className="text-lg font-semibold" style={{ color: C.text }}>
            Ready to join?
          </div>
          <div className="mt-1 text-sm" style={{ color: C.sub }}>
            Joining as {you.name} · no waiting room
          </div>
        </div>
        <div className="flex w-full flex-col gap-2">
          <button
            onClick={onJoin}
            className="w-full rounded-xl py-3 text-sm font-semibold"
            style={{ background: C.brand, color: '#fff' }}
          >
            Join now
          </button>
          <button
            onClick={onInvite}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-medium"
            style={{
              background: 'rgba(255,255,255,0.06)',
              color: C.text,
              border: `1px solid ${C.line2}`,
            }}
          >
            <UserPlus size={16} /> Invite others first
          </button>
        </div>
      </div>
    </div>
  );
}

function RoundToggle({ on, onI: On, offI: Off, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center rounded-full"
      style={{
        width: 44,
        height: 44,
        background: on ? 'rgba(255,255,255,0.14)' : C.danger,
        color: '#fff',
      }}
    >
      {on ? <On size={19} /> : <Off size={19} />}
    </button>
  );
}

/* ---------- root ---------- */

export default function App() {
  const [lens, setLens] = useState('client');
  const [stage, setStage] = useState('oneOnOne');
  const [device, setDevice] = useState('desktop');
  const [panel, setPanel] = useState('chat');
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [elapsed, setElapsed] = useState(742);
  const [more, setMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showReactions, setShowReactions] = useState(false);
  const [floaters, setFloaters] = useState([]);
  const REACTIONS = ['👍', '👏', '❤️', '🎉', '😂', '😮'];
  const fireReaction = (e) => {
    const id = Date.now() + Math.random();
    const dx = Math.round((Math.random() - 0.5) * 90);
    setFloaters((f) => [...f, { id, e, dx }]);
    setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), 2200);
    setShowReactions(false);
  };
  const frameRef = useRef(null);

  const [messages, setMessages] = useState([
    {
      p: PEOPLE.expert,
      text: "Welcome! Share your current CPQ config screenshot whenever you're ready.",
      time: '12:31',
    },
    {
      p: PEOPLE.client,
      you: true,
      text: 'Perfect — dropping it in the Files tab now.',
      time: '12:32',
    },
  ]);
  const files = [
    { name: 'current-cpq-rules.pdf', by: 'Jordan', size: '1.4 MB', icon: FileText },
    { name: 'quote-template-v3.png', by: 'Amara', size: '612 KB', icon: ImageIcon },
  ];

  const live = ['oneOnOne', 'gallery', 'screenshare'].includes(stage);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [live]);

  const toggleFs = () => {
    const el = frameRef.current;
    const next = !expanded;
    setExpanded(next);
    try {
      if (next) el?.requestFullscreen?.();
      else if (document.fullscreenElement) document.exitFullscreen?.();
    } catch (e) {}
  };
  useEffect(() => {
    const onFs = () => {
      if (!document.fullscreenElement) setExpanded(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('fullscreenchange', onFs);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  const mobile = device === 'mobile';
  const inPrejoin = stage === 'prejoin';
  const isVideoLayout = stage === 'oneOnOne' || stage === 'gallery';
  const openPanel = (p) => setPanel((cur) => (cur === p ? null : p));

  const StageEl = () => {
    if (stage === 'prejoin')
      return (
        <PreJoin
          lens={lens}
          onJoin={() => setStage('oneOnOne')}
          onInvite={() => {
            setStage('oneOnOne');
            setPanel('people');
          }}
        />
      );
    if (stage === 'waiting')
      return <WaitingStage lens={lens} onInvite={() => setPanel('people')} />;
    if (stage === 'oneOnOne')
      return <OneOnOne lens={lens} micOn={micOn} camOn={camOn} mobile={mobile} />;
    if (stage === 'gallery') return <Gallery lens={lens} micOn={micOn} camOn={camOn} />;
    if (stage === 'screenshare')
      return (
        <ScreenShare
          lens={lens}
          micOn={micOn}
          camOn={camOn}
          mobile={mobile}
          onFullscreen={toggleFs}
          expanded={expanded}
        />
      );
    if (stage === 'reconnecting')
      return (
        <div className="relative h-full w-full">
          <OneOnOne lens={lens} micOn={micOn} camOn={camOn} mobile={mobile} />
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3"
            style={{ background: 'rgba(8,10,14,0.72)' }}
          >
            <Loader2 size={30} color="#fff" className="animate-spin" />
            <div className="text-sm font-medium" style={{ color: '#fff' }}>
              Reconnecting…
            </div>
            <div className="text-xs" style={{ color: C.sub }}>
              Your connection dropped. We're getting you back in.
            </div>
          </div>
        </div>
      );
    return null;
  };

  const panelEl =
    panel === 'chat' ? (
      <ChatPanel
        onClose={() => setPanel(null)}
        messages={messages}
        onSend={(t) =>
          setMessages((m) => [
            ...m,
            {
              p: lens === 'client' ? PEOPLE.client : PEOPLE.expert,
              you: true,
              text: t,
              time: fmt(elapsed),
            },
          ])
        }
      />
    ) : panel === 'files' ? (
      <FilesPanel onClose={() => setPanel(null)} files={files} />
    ) : panel === 'people' ? (
      <PeoplePanel onClose={() => setPanel(null)} lens={lens} />
    ) : null;

  const moreItems = mobile
    ? [
        ...(isVideoLayout
          ? [
              {
                icon: LayoutGrid,
                label: stage === 'gallery' ? 'Speaker view' : 'Gallery view',
                on: () => setStage(stage === 'gallery' ? 'oneOnOne' : 'gallery'),
              },
            ]
          : []),
        { icon: MonitorUp, label: 'Share screen', on: () => setStage('screenshare') },
        { icon: Paperclip, label: 'Files', on: () => setPanel('files') },
        { icon: Users, label: 'People', on: () => setPanel('people') },
        { icon: Smile, label: 'Reactions', on: () => setShowReactions(true) },
        { icon: Settings, label: 'Settings', on: () => {} },
      ]
    : [
        { icon: Hand, label: 'Raise hand', on: () => {} },
        { icon: Settings, label: 'Settings', on: () => {} },
      ];

  return (
    <div
      className="flex w-full flex-col items-center gap-4 p-4"
      style={{
        background: '#EEF0F4',
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <style>{`@keyframes baloFloat {0%{opacity:0;transform:translateY(0) scale(.7)}15%{opacity:1}100%{opacity:0;transform:translateY(-170px) scale(1.15)}}`}</style>
      {/* prototype controls */}
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-3 py-2.5"
        style={{ background: '#0B0E13' }}
      >
        <Ctl label="Lens">
          <Seg
            value={lens}
            onChange={setLens}
            options={[
              { value: 'client', label: 'Client' },
              { value: 'expert', label: 'Expert' },
            ]}
          />
        </Ctl>
        <Ctl label="State">
          <Seg
            value={stage}
            onChange={setStage}
            options={[
              { value: 'prejoin', label: 'Pre-join' },
              { value: 'waiting', label: 'Waiting' },
              { value: 'oneOnOne', label: '1:1' },
              { value: 'gallery', label: 'Gallery' },
              { value: 'screenshare', label: 'Share' },
              { value: 'reconnecting', label: 'Reconnect' },
            ]}
          />
        </Ctl>
        <Ctl label="Device">
          <Seg
            value={device}
            onChange={setDevice}
            options={[
              { value: 'desktop', label: 'Desktop' },
              { value: 'mobile', label: 'Mobile' },
            ]}
          />
        </Ctl>
      </div>

      {/* meeting frame */}
      <div
        ref={frameRef}
        className="relative flex flex-col overflow-hidden shadow-2xl"
        style={
          expanded
            ? {
                position: 'fixed',
                inset: 0,
                width: '100vw',
                height: '100vh',
                borderRadius: 0,
                zIndex: 60,
                background: C.bg,
              }
            : {
                width: mobile ? 380 : '100%',
                maxWidth: mobile ? 380 : 1120,
                height: mobile ? 760 : 660,
                background: C.bg,
                borderRadius: mobile ? 34 : 20,
                border: `1px solid ${C.line}`,
              }
        }
      >
        {!inPrejoin && (
          <TopBar stage={stage} elapsed={elapsed} onInfo={() => openPanel('people')} />
        )}

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 p-3">
            <div
              className="relative h-full w-full overflow-hidden rounded-2xl"
              style={{ background: C.stage }}
            >
              <StageEl />
              {!mobile && !inPrejoin && (
                <div
                  className="absolute flex items-center gap-2"
                  style={{ right: 12, top: 12, zIndex: 15 }}
                >
                  {isVideoLayout && (
                    <button
                      onClick={() => setStage(stage === 'gallery' ? 'oneOnOne' : 'gallery')}
                      title={stage === 'gallery' ? 'Speaker view' : 'Gallery view'}
                      className="flex items-center justify-center rounded-lg transition-colors"
                      style={{
                        width: 34,
                        height: 34,
                        background: stage === 'gallery' ? C.brand : 'rgba(0,0,0,0.5)',
                        color: '#fff',
                      }}
                    >
                      <LayoutGrid size={17} />
                    </button>
                  )}
                  <button
                    onClick={toggleFs}
                    title={expanded ? 'Exit fullscreen' : 'Fullscreen'}
                    className="flex items-center justify-center rounded-lg transition-colors"
                    style={{ width: 34, height: 34, background: 'rgba(0,0,0,0.5)', color: '#fff' }}
                  >
                    {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                  </button>
                </div>
              )}
            </div>
          </div>
          {!mobile && !inPrejoin && panel && (
            <div style={{ width: 340, borderLeft: `1px solid ${C.line}` }}>{panelEl}</div>
          )}
        </div>

        {/* toolbar */}
        {!inPrejoin && (
          <div
            className="flex shrink-0 items-center px-4"
            style={{
              height: mobile ? 88 : 96,
              borderTop: `1px solid ${C.line}`,
              justifyContent: mobile ? 'space-between' : 'center',
            }}
          >
            {mobile ? (
              <>
                <div className="flex items-center gap-2.5">
                  <CircleBtn
                    icon={micOn ? Mic : MicOff}
                    danger={!micOn}
                    onClick={() => setMicOn(!micOn)}
                  />
                  <CircleBtn
                    icon={camOn ? Video : VideoOff}
                    danger={!camOn}
                    onClick={() => setCamOn(!camOn)}
                  />
                  <CircleBtn
                    icon={MessageSquare}
                    active={panel === 'chat'}
                    onClick={() => openPanel('chat')}
                  />
                  <CircleBtn icon={MoreHorizontal} active={more} onClick={() => setMore(!more)} />
                </div>
                <LeaveBtn lens={lens} onClick={() => setStage('prejoin')} />
              </>
            ) : (
              <div className="flex items-center gap-2.5">
                <Tool
                  icon={micOn ? Mic : MicOff}
                  label={micOn ? 'Mute' : 'Unmute'}
                  danger={!micOn}
                  onClick={() => setMicOn(!micOn)}
                />
                <Tool
                  icon={camOn ? Video : VideoOff}
                  label={camOn ? 'Stop video' : 'Start video'}
                  danger={!camOn}
                  onClick={() => setCamOn(!camOn)}
                />
                <Tool
                  icon={MonitorUp}
                  label="Share screen"
                  active={stage === 'screenshare'}
                  onClick={() => setStage('screenshare')}
                />
                <Tool
                  icon={Smile}
                  label="React"
                  active={showReactions}
                  onClick={() => setShowReactions((v) => !v)}
                />
                <Tool
                  icon={MessageSquare}
                  label="Chat"
                  active={panel === 'chat'}
                  onClick={() => openPanel('chat')}
                />
                <Tool
                  icon={Paperclip}
                  label="Files"
                  active={panel === 'files'}
                  onClick={() => openPanel('files')}
                />
                <Tool
                  icon={Users}
                  label="People"
                  active={panel === 'people'}
                  onClick={() => openPanel('people')}
                />
                <Tool
                  icon={MoreHorizontal}
                  label="More"
                  active={more}
                  onClick={() => setMore(!more)}
                />
                <div className="mx-1" style={{ width: 1, height: 32, background: C.line }} />
                <LeaveBtn lens={lens} onClick={() => setStage('prejoin')} />
              </div>
            )}
          </div>
        )}

        {/* more sheet */}
        {more && !inPrejoin && (
          <MoreSheet items={moreItems} mobile={mobile} onClose={() => setMore(false)} />
        )}

        {/* reaction picker */}
        {showReactions && !inPrejoin && (
          <>
            <div
              className="absolute inset-0"
              style={{ zIndex: 24 }}
              onClick={() => setShowReactions(false)}
            />
            <div
              className="absolute flex items-center gap-1 rounded-2xl px-2 py-1.5"
              style={{
                left: '50%',
                transform: 'translateX(-50%)',
                bottom: mobile ? 96 : 104,
                background: C.sheet,
                border: `1px solid ${C.line2}`,
                zIndex: 25,
              }}
            >
              {REACTIONS.map((e) => (
                <button
                  key={e}
                  onClick={() => fireReaction(e)}
                  className="flex items-center justify-center rounded-xl transition-transform hover:-translate-y-0.5"
                  style={{ width: 40, height: 40, fontSize: 22 }}
                >
                  {e}
                </button>
              ))}
            </div>
          </>
        )}
        {/* floating reactions */}
        {floaters.map((f) => (
          <div
            key={f.id}
            className="pointer-events-none absolute"
            style={{
              left: `calc(50% + ${f.dx}px)`,
              bottom: mobile ? 92 : 100,
              fontSize: 34,
              zIndex: 26,
              animation: 'baloFloat 2.2s ease-out forwards',
            }}
          >
            {f.e}
          </div>
        ))}

        {/* mobile full-screen panel */}
        {mobile && !inPrejoin && panel && (
          <div className="absolute inset-0 flex" style={{ background: C.bg, zIndex: 20 }}>
            {panelEl}
          </div>
        )}
      </div>

      <p className="text-xs" style={{ color: '#8A94A6' }}>
        Prototype · design reference for BAL-132 — Chat is Ably-backed, Files persist to R2,
        trust-by-default join per BAL-134.
      </p>
    </div>
  );
}

function Ctl({ label, children }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-medium tracking-wide uppercase" style={{ color: '#5B6472' }}>
        {label}
      </span>
      {children}
    </div>
  );
}
