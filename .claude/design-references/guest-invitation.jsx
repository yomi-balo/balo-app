import React, { useState } from 'react';
import {
  X,
  UserPlus,
  Link2,
  Users,
  Building2,
  Video,
  Clock,
  ShieldQuestion,
  Trash2,
  Mail,
} from 'lucide-react';

/**
 * Balo — Guest invitation (design reference, BAL-408 / ADR-1044)
 *
 * ONE invite seam, rendered at three entry points. Do not build per-surface
 * invite paths:
 *   1. Booking confirm      (BAL-400) — invite while booking
 *   2. Case surface         (BAL-421) — any time pre-meeting
 *   3. In-call People tab   (BAL-132) — during the call, plus the admit queue
 *
 * ── THE HARD PART IS THE DISCLOSURE, NOT THE INPUT ────────────────────────────
 * Access scope (v1): CASE-LEVEL where the guest's email domain matches the client
 * company; MEETING-LEVEL otherwise. Case-level is RETROSPECTIVE (decided
 * 2026-07-30) — a same-domain guest invited to consultation 4 can read the recaps
 * and transcripts of 1–3, including calls held before they existed as a guest.
 *
 * That is a materially bigger grant than it was when the rule was written, when a
 * "case" was effectively one consultation. The sharp case: a case opened about a
 * problem involving a colleague, who is later invited and reads the earlier candid
 * discussion. Forward-only scoping was considered and rejected — colleagues
 * collaborating on one issue should see the whole issue — so the mitigation is
 * INFORMED CONSENT AT INVITE TIME. Hence the per-recipient scope badge and the
 * plain-language line beneath it. This is the MJ copy checkpoint.
 *
 * FREEMAIL EXCLUSION is load-bearing, not a detail: a client company operating on
 * gmail.com would otherwise grant case-level access to every Gmail guest. Reuse
 * ADR-1039's freemail list — the same rule as domain auto-join.
 *
 * ── ATTENDANCE AND VISIBILITY ARE TWO DIFFERENT THINGS ────────────────────────
 * The guest row keys to `meetings.id` (BAL-418) — a guest attends ONE call, not
 * every call in the case. `access_scope` carries what they can see afterwards.
 * Corrected from the original ticket, which keyed the guest to the engagement and
 * would have put a guest on every future consultation.
 *
 * ── ADMIT/DENY IS CAPABILITY-GATED, NOT LENS-GATED ────────────────────────────
 * The existing in-meeting reference gates the admit queue on `lens === 'expert'`,
 * which is exactly the comparison ADR-1029 forbids and ADR-1046 replaced. It is
 * `hasEngagementCapability(actor, 'host_meetings', hostContext)`:
 *   ✓ delivering expert          ✓ their agency owner/admin
 *   ✗ agency colleague (role `expert`) — expert-side, attending, NOT the host
 *   ✗ client, delegates, guests
 * Toggle "You are" to Agency colleague to see the queue render read-only. Take the
 * layout from `balo-in-meeting-ui.jsx`; do not take its gate.
 *
 * Other rules held here: counterparty names cross the party boundary but email
 * addresses never (ADR-1044); billing is per-minute of expert time, never
 * per-seat; Daily caps at 10 participants; removing a guest sends METHOD:CANCEL
 * to that person only.
 */

const C = {
  bg: '#EEF0F3',
  card: '#FFFFFF',
  line: '#E6E8EC',
  line2: '#F0F1F4',
  text: '#171A1F',
  sub: '#5B6472',
  faint: '#9AA1AD',
  brand: '#2563EB',
  brandSoft: '#F6F8FE',
  brandLine: '#E3EBFB',
  good: '#12996B',
  goodSoft: '#E7F6EF',
  warn: '#B25E09',
  warnSoft: '#FDF3E7',
  warnLine: '#F6E3CB',
  ink: '#0B0E13',
};

const CLIENT_DOMAIN = 'northwind.com';
const FREEMAIL = [
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'yahoo.com',
  'icloud.com',
  'proton.me',
];
const MAX_PARTICIPANTS = 10;

const EXPERT = { name: 'Amara', full: 'Dr. Amara Okafor', agency: 'CloudPeak' };
const CLIENT = { name: 'Jordan', full: 'Jordan Lee', company: 'Northwind Industrial' };

const SEED = [
  { email: 'priya@northwind.com', name: 'Priya', party: 'client' },
  { email: 'tom@brightline.io', name: 'Tom', party: 'client' },
];

const IN_CALL = [
  { name: 'Jordan Lee', party: 'client', role: 'Booked this call' },
  { name: 'Dr. Amara Okafor', party: 'expert', role: 'Your expert' },
];

const WAITING = [{ name: 'Sam Whitfield', via: 'Opened the shared link' }];

const scopeFor = (email) => {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const domain = email.slice(at + 1).toLowerCase();
  if (FREEMAIL.includes(domain)) return 'meeting';
  return domain === CLIENT_DOMAIN ? 'case' : 'meeting';
};

function Seg({ options, value, onChange }) {
  return (
    <div
      className="flex items-center gap-1 rounded-lg p-1"
      style={{ background: '#0d1017', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      {options.map((o) => {
        const a = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className="rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
            style={{ background: a ? C.brand : 'transparent', color: a ? '#fff' : '#9AA2B0' }}
          >
            {o.label}
          </button>
        );
      })}
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

function Avatar({ name, party, size = 30 }) {
  const e = party === 'expert';
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size / 2.5,
        background: e ? '#E9EDFB' : '#F1EFE9',
        color: e ? '#3B4E86' : '#7A6A4A',
      }}
    >
      {name.charAt(0)}
    </span>
  );
}

function ScopeBadge({ scope }) {
  const isCase = scope === 'case';
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{
        background: isCase ? C.warnSoft : '#F1F3F6',
        color: isCase ? C.warn : C.sub,
      }}
    >
      {isCase ? <Building2 size={10} /> : <Video size={10} />}
      {isCase ? 'Whole case' : 'This call only'}
    </span>
  );
}

/**
 * The shared composer. Identical in all three entry points — only the container
 * and the surrounding copy change.
 */
function InviteComposer({ party, compact }) {
  const [draft, setDraft] = useState('');
  const [guests, setGuests] = useState(SEED);
  const [sent, setSent] = useState(false);

  const add = () => {
    const email = draft.trim().toLowerCase();
    if (!email.includes('@') || guests.some((g) => g.email === email)) return;
    setGuests([...guests, { email, name: email.split('@')[0], party }]);
    setDraft('');
    setSent(false);
  };

  const draftScope = draft.includes('@') ? scopeFor(draft) : null;
  const caseLevel = guests.filter((g) => scopeFor(g.email) === 'case');
  const total = IN_CALL.length + guests.length;

  return (
    <div>
      {/* input */}
      <div
        className="flex items-center gap-2 rounded-xl px-3 py-2"
        style={{ background: '#FAFBFC', border: `1px solid ${C.line}` }}
      >
        <Mail size={15} color={C.faint} className="shrink-0" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Email address"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          style={{ color: C.text }}
        />
        {draftScope && <ScopeBadge scope={draftScope} />}
        <button
          onClick={add}
          disabled={!draft.includes('@')}
          className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold"
          style={{
            background: draft.includes('@') ? C.brand : '#EDEFF2',
            color: draft.includes('@') ? '#fff' : C.faint,
          }}
        >
          Add
        </button>
      </div>

      {/* live disclosure — the informed-consent mitigation */}
      {draftScope === 'case' && (
        <div className="mt-1.5 flex items-start gap-1.5 px-1 text-xs" style={{ color: C.warn }}>
          <ShieldQuestion size={12} className="mt-0.5 shrink-0" />
          <span>
            Same company as you — they’ll see this whole case, including consultations held before
            today.
          </span>
        </div>
      )}
      {draftScope === 'meeting' && (
        <div className="mt-1.5 px-1 text-xs" style={{ color: C.faint }}>
          Outside {CLIENT.company} — they’ll only see this call and its recap.
        </div>
      )}

      {/* list */}
      {guests.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          {guests.map((g) => (
            <div
              key={g.email}
              className="flex items-center gap-2.5 rounded-xl px-2.5 py-2"
              style={{ background: '#fff', border: `1px solid ${C.line}` }}
            >
              <Avatar name={g.name} party={g.party} size={26} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm" style={{ color: C.text }}>
                  {g.email}
                </div>
              </div>
              <ScopeBadge scope={scopeFor(g.email)} />
              <button
                onClick={() => setGuests(guests.filter((x) => x.email !== g.email))}
                className="shrink-0"
                style={{ color: C.faint }}
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* summary disclosure — states the grant once, in plain language */}
      {caseLevel.length > 0 && (
        <div
          className="mt-3 flex items-start gap-2 rounded-xl px-3 py-2.5"
          style={{ background: C.warnSoft, border: `1px solid ${C.warnLine}` }}
        >
          <ShieldQuestion size={14} color={C.warn} className="mt-0.5 shrink-0" />
          <span className="text-xs leading-relaxed" style={{ color: '#7A4A12' }}>
            {caseLevel.length === 1
              ? `${caseLevel[0].name} will be able to read every consultation in this case — recaps, transcripts and action items — including ones held before they were invited.`
              : `${caseLevel.length} people will be able to read every consultation in this case, including ones held before they were invited.`}
          </span>
        </div>
      )}

      {!compact && (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs" style={{ color: C.faint }}>
            {total} of {MAX_PARTICIPANTS} · guests don’t change what you pay
          </span>
          <button
            onClick={() => setSent(true)}
            className="rounded-xl px-4 py-2 text-sm font-semibold text-white"
            style={{ background: C.brand }}
          >
            {sent ? 'Invites sent' : 'Send invites'}
          </button>
        </div>
      )}
      {compact && (
        <div className="mt-2.5 text-xs" style={{ color: C.faint }}>
          {total} of {MAX_PARTICIPANTS} · guests don’t change what you pay
        </div>
      )}
    </div>
  );
}

function Panel({ title, sub, children, onClose }) {
  return (
    <div
      className="w-full rounded-3xl px-5 py-4"
      style={{
        maxWidth: 440,
        background: C.card,
        border: `1px solid ${C.line}`,
        boxShadow: '0 1px 2px rgba(16,20,28,0.04), 0 12px 40px rgba(16,20,28,0.06)',
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold" style={{ color: C.text }}>
            {title}
          </h2>
          {sub && (
            <p className="mt-0.5 text-xs leading-relaxed" style={{ color: C.faint }}>
              {sub}
            </p>
          )}
        </div>
        {onClose && (
          <button style={{ color: C.faint }}>
            <X size={16} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export default function App() {
  const [entry, setEntry] = useState('case');
  const [who, setWho] = useState('host');

  const isHost = who === 'host' || who === 'agencyAdmin';
  const party = who === 'client' ? 'client' : 'expert';

  return (
    <div
      className="flex w-full flex-col items-center gap-4 p-4"
      style={{
        background: C.bg,
        fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <div
        className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl px-3 py-2.5"
        style={{ background: C.ink }}
      >
        <Ctl label="Entry point">
          <Seg
            value={entry}
            onChange={setEntry}
            options={[
              { value: 'booking', label: 'Booking' },
              { value: 'case', label: 'Case' },
              { value: 'incall', label: 'In-call' },
            ]}
          />
        </Ctl>
        <Ctl label="You are">
          <Seg
            value={who}
            onChange={setWho}
            options={[
              { value: 'client', label: 'Client' },
              { value: 'host', label: 'Expert (host)' },
              { value: 'agencyAdmin', label: 'Agency admin' },
              { value: 'colleague', label: 'Agency colleague' },
            ]}
          />
        </Ctl>
      </div>

      <div className="flex w-full justify-center">
        {/* ── 1. booking confirm — inline, optional ─────────── */}
        {entry === 'booking' && (
          <Panel
            title="Invite others"
            sub="Optional. They’ll get the join link by email — the same seam as the case surface and the in-call People tab."
          >
            <InviteComposer party={party} compact />
            <div className="mt-4 border-t pt-3" style={{ borderColor: C.line2 }}>
              <button
                className="w-full rounded-xl py-2.5 text-sm font-semibold text-white"
                style={{ background: C.brand }}
              >
                Confirm &amp; book
              </button>
              <p className="mt-2 text-center text-xs" style={{ color: C.faint }}>
                Free until the scheduled start time.
              </p>
            </div>
          </Panel>
        )}

        {/* ── 2. case surface — modal, any time pre-meeting ── */}
        {entry === 'case' && (
          <Panel
            title="Invite a colleague"
            sub="Flow interview stuck on a record-triggered loop · consultation on Tue 4 Aug"
            onClose
          >
            <InviteComposer party={party} />
          </Panel>
        )}

        {/* ── 3. in-call People tab ─────────────────────────── */}
        {entry === 'incall' && (
          <div
            className="w-full rounded-3xl px-5 py-4"
            style={{
              maxWidth: 440,
              background: C.card,
              border: `1px solid ${C.line}`,
              boxShadow: '0 1px 2px rgba(16,20,28,0.04), 0 12px 40px rgba(16,20,28,0.06)',
            }}
          >
            <div className="mb-3 flex items-center gap-2">
              <Users size={16} color={C.sub} />
              <h2 className="text-base font-semibold" style={{ color: C.text }}>
                People
              </h2>
              <span className="ml-auto text-xs" style={{ color: C.faint }}>
                {IN_CALL.length + SEED.length} of {MAX_PARTICIPANTS}
              </span>
            </div>

            {/* waiting to join — host-gated */}
            {WAITING.length > 0 && (
              <div
                className="mb-3 rounded-2xl px-3 py-2.5"
                style={{
                  background: isHost ? C.warnSoft : '#F7F8FA',
                  border: `1px solid ${isHost ? C.warnLine : C.line}`,
                }}
              >
                <div className="mb-2 flex items-center gap-1.5">
                  <Clock size={12} color={isHost ? C.warn : C.faint} />
                  <span
                    className="text-xs font-semibold"
                    style={{ color: isHost ? C.warn : C.sub }}
                  >
                    Waiting to join
                  </span>
                </div>
                {WAITING.map((w) => (
                  <div key={w.name} className="flex items-center gap-2.5">
                    <Avatar name={w.name} party="client" size={26} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm" style={{ color: C.text }}>
                        {w.name}
                      </div>
                      <div className="truncate text-xs" style={{ color: C.faint }}>
                        {w.via}
                      </div>
                    </div>
                    {isHost ? (
                      <div className="flex shrink-0 gap-1.5">
                        <button
                          className="rounded-lg px-2.5 py-1 text-xs font-medium"
                          style={{
                            background: '#fff',
                            border: `1px solid ${C.line}`,
                            color: C.sub,
                          }}
                        >
                          Deny
                        </button>
                        <button
                          className="rounded-lg px-2.5 py-1 text-xs font-semibold text-white"
                          style={{ background: C.brand }}
                        >
                          Admit
                        </button>
                      </div>
                    ) : (
                      <span className="shrink-0 text-xs" style={{ color: C.faint }}>
                        {EXPERT.name} decides
                      </span>
                    )}
                  </div>
                ))}
                {!isHost && (
                  <p className="mt-2 text-xs leading-relaxed" style={{ color: C.faint }}>
                    Only the delivering expert and their agency admins can admit people.
                  </p>
                )}
              </div>
            )}

            {/* in the call */}
            <div className="mb-1 text-xs font-medium" style={{ color: C.sub }}>
              In the call
            </div>
            <div className="flex flex-col gap-2">
              {IN_CALL.map((p) => (
                <div key={p.name} className="flex items-center gap-2.5">
                  <Avatar name={p.name} party={p.party} size={28} />
                  <div className="min-w-0">
                    <div className="truncate text-sm" style={{ color: C.text }}>
                      {p.name}
                    </div>
                    <div className="truncate text-xs" style={{ color: C.faint }}>
                      {p.role}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* invited, not yet joined */}
            <div className="mt-4 mb-1 text-xs font-medium" style={{ color: C.sub }}>
              Invited
            </div>
            <div className="flex flex-col gap-2">
              {SEED.map((g) => (
                <div key={g.email} className="flex items-center gap-2.5">
                  <Avatar name={g.name} party={g.party} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm capitalize" style={{ color: C.text }}>
                      {g.name}
                    </div>
                    <div className="truncate text-xs" style={{ color: C.faint }}>
                      Invited · hasn’t joined
                    </div>
                  </div>
                  <ScopeBadge scope={scopeFor(g.email)} />
                  <button className="shrink-0" style={{ color: C.faint }} title="Remove">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>

            {/* add + link */}
            <div className="mt-4 border-t pt-3" style={{ borderColor: C.line2 }}>
              <div className="mb-2 flex items-center gap-1.5">
                <UserPlus size={13} color={C.sub} />
                <span className="text-xs font-medium" style={{ color: C.sub }}>
                  Add people
                </span>
              </div>
              <InviteComposer party={party} compact />
              <button
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl py-2 text-xs font-medium"
                style={{ background: '#fff', border: `1px solid ${C.line}`, color: C.text }}
              >
                <Link2 size={13} /> Copy join link
              </button>
              <p className="mt-1.5 text-center text-xs leading-relaxed" style={{ color: C.faint }}>
                Emailed guests join straight away. Anyone using the copied link waits to be
                admitted.
              </p>
            </div>
          </div>
        )}
      </div>

      <p className="max-w-lg text-center text-xs leading-relaxed" style={{ color: '#8A94A6' }}>
        Prototype · guest invitation. Type an email to see the access grant change —{' '}
        <strong>@{CLIENT_DOMAIN}</strong> gets the whole case, anything else gets the single call,
        and freemail never gets case-level. Switch <strong>You are</strong> to Agency colleague on
        the in-call tab to see the admit queue lose its controls.
      </p>
    </div>
  );
}
