/**
 * ─────────────────────────────────────────────────────────────────────────────
 * request-file-audience.jsx — design reference for BAL-431
 * Request-stage file audience: share-once to tracks, grants + revoke, audit,
 * promotion lineage. Lives at .claude/design-references/request-file-audience.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS DEMONSTRATES (decisions of 2026-08-07, ticket BAL-431):
 *  1. Client uploads carry an audience: "Everyone invited" (all_live_tracks,
 *     DYNAMIC — evaluated at read time) or explicit per-track grants.
 *  2. Dynamic all-audience: a late-invited expert (Dan, day 7) inherits every
 *     prior share-to-all file the moment the track exists. Toggle "Dan invited".
 *  3. Declined track drops out of FORWARD visibility: new all-shares after the
 *     decline never reach it. Toggle "Wei declines" (day 8) and note the day-9
 *     questionnaire disappears from Wei's lens while day-1/3 files remain.
 *     DECIDED 2026-08-07 — HISTORICAL-READ: decline ends the future, not the
 *     past. A closed track receives nothing new and loses nothing already
 *     delivered. Rationale: revocation cannot unsend a downloadable file, and
 *     instant severance trains pre-decline bulk-downloading; the client keeps
 *     explicit, audited levers (revoke a grant, delete the file) that work
 *     regardless of track state; mirrors the meetings-plane rule (ADR-1046
 *     amendment — declined is never a holder for NEW grants, history stays
 *     anchored). BAL-276 is not contradicted: it revoked live affordances
 *     (lens, canSeeContact), not deliveries. Data-minimisation long tail
 *     belongs to retention policy (out of scope), not instant severance.
 *     Client lens annotates BOTH directions so badge and reality agree:
 *     post-decline shares → "declined — not shared"; pre-decline shares →
 *     "kept access · shared before declining".
 *  4. Expert uploads are hard-fixed to their own track — no picker exists on
 *     the expert side, structurally. Cross-track expert reads resolve false
 *     (invariant test in BAL-431). Sibling candidates never appear.
 *  5. Revoke is SILENT (decided 2026-08-07): the grant row is deleted, the
 *     client sees an audit line, the expert sees nothing — no notification.
 *  6. Share-to-all posts a system message in each live conversation thread
 *     (shown here as the toast copy; wire through the notification engine).
 *  7. Audit: every grant/revoke = attribution + audit_events in the same
 *     transaction (ADR-1030). The client-side "Access history" strip and the
 *     admin lens surface it.
 *  8. Admin lens = the sole all-files read (platform capability, ADR-1035).
 *     Placement undecided — Admin Dashboard Tracker §3.8. Read model only here.
 *  9. Expert-side audience concealment (decided 2026-08-07): the expert lens
 *     renders NO audience metadata on client files — no type, no count, no
 *     grant list. Audience shape reveals competitor count. All client files
 *     look identical to an expert; the expert serializer must not emit the
 *     audience fields at all (negative-assertion test, fee-concealment style).
 * 10. Delete own file (decided 2026-08-07; AMENDED by Ruling 1 + Ruling 3,
 *     2026-08-31, overriding ADR-1048 §4 — the ADR amendment itself is Yomi's):
 *       · RETENTION: soft delete — tombstone + audit_events; **the R2 OBJECT IS
 *         DELETED** (best-effort, prefix-guarded, through the shared
 *         `deletePrefixedObjectFromR2` primitive). The platform file-deletion
 *         rule at meeting-files.ts:22-31 (PR #200, 11 Aug) is NEWER than
 *         ADR-1048 (7 Aug) and stands. Because the bytes are gone, the delete
 *         audit event snapshots the RESOLVED AUDIENCE at delete time — that
 *         snapshot plus the tombstone is the only remaining answer to "who had
 *         access to what, when".
 *       · WHO MAY DELETE: **party-level** on BOTH sides, not uploader-only —
 *         delete right ≡ upload right on that side (the SAME participation
 *         predicate; no `uploaded_by_user_id === actor` check, no new rule).
 *         Attribution survives: uploaded_by AND the deleting actor are both
 *         recorded. A declined/closed expert can neither upload nor delete,
 *         which is exactly what `f.by === viewAs && !declined` (:729) and the
 *         disabled upload button (:750) already show below — the simulation is
 *         UNCHANGED, only this note is new.
 *       Still SILENT like revoke; admin lens shows the tombstone; a deleted
 *       file never follows promotion lineage.
 *
 * OUT OF SCOPE (do not infer UI from absence): AV/quarantine states
 * (BAL-278/292), promotion lineage onto the engagement, retention policy,
 * excluding a single track from an "Everyone" share (not modelled — use
 * explicit grants for that shape).
 *
 * IMPLEMENTATION MAPPING (CC): shadcn primitives — Button, Badge, Card,
 * Dialog (desktop) / full-screen Sheet (mobile) for the share picker,
 * DropdownMenu for row actions. Geist (repo-authoritative). Solid --primary
 * on all actions — dashboard surface, never the blue→violet gradient.
 * Reuse the A4 conversation surface file-row pattern; this panel is the
 * request-level aggregation of those rows plus audience metadata.
 *
 * DATES: "day N" is simulation machinery — a frozen clock (NOW_DAY) that makes
 * event ORDER verifiable at a glance, because every visibility rule is an
 * inequality on order (sharedAt < declineAt, sharedAt < invitedAt). Do NOT
 * ship day-numbers. Product: reuse the repo date-format helper (settled in
 * BAL-355) — relative within the recent window, absolute beyond it, exact
 * timestamp on hover. Access history renders absolute datetimes always
 * (dispute-grade record). No user-facing logic asks anyone to compare dates:
 * the system computes ordering and renders the conclusion as copy
 * ("declined — not shared", "shared before you joined").
 *
 * CONTROLS (dark strip): Lens (Client / Expert / Admin) · Viewing-as selector
 * (expert lens) · Scenario toggles (Dan invited, Wei declines) · Reset.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect } from 'react';
import {
  FileText,
  FileSpreadsheet,
  Upload,
  Users,
  Lock,
  X,
  Eye,
  ShieldCheck,
  RotateCcw,
  Info,
  Check,
  Trash2,
} from 'lucide-react';

const NOW_DAY = 10;
const DECLINE_DAY = 8;

const TRACKS = {
  priya: { id: 'priya', name: 'Priya Sharma', org: 'Northbridge Partners', invitedDay: 2 },
  wei: { id: 'wei', name: 'Wei Zhang', org: 'Clearpath Consulting', invitedDay: 2 },
  dan: { id: 'dan', name: 'Dan Okafor', org: 'Independent expert', invitedDay: 7 },
};

const SEED_FILES = [
  {
    id: 'f1',
    name: 'Requirements-pack-v2.pdf',
    kind: 'pdf',
    size: '2.1 MB',
    day: 1,
    by: 'client',
    audience: { type: 'all' },
  },
  {
    id: 'f2',
    name: 'Salesforce-org-inventory.xlsx',
    kind: 'xlsx',
    size: '340 KB',
    day: 3,
    by: 'client',
    audience: { type: 'all' },
  },
  {
    id: 'f3',
    name: 'Integration-vendor-contract.pdf',
    kind: 'pdf',
    size: '1.4 MB',
    day: 4,
    by: 'client',
    audience: { type: 'grants', to: ['wei'] },
  },
  {
    id: 'f4',
    name: 'Clearpath-EOI-deck.pdf',
    kind: 'pdf',
    size: '5.8 MB',
    day: 5,
    by: 'wei',
    audience: { type: 'own' },
  },
  {
    id: 'f5',
    name: 'Northbridge-approach-note.pdf',
    kind: 'pdf',
    size: '900 KB',
    day: 5,
    by: 'priya',
    audience: { type: 'own' },
  },
  {
    id: 'f6',
    name: 'Security-questionnaire.xlsx',
    kind: 'xlsx',
    size: '120 KB',
    day: 9,
    by: 'client',
    audience: { type: 'all' },
  },
];

const SEED_AUDIT = [
  { id: 'a1', day: 1, text: 'Sarah Chen shared Requirements-pack-v2.pdf with everyone invited' },
  {
    id: 'a2',
    day: 3,
    text: 'Sarah Chen shared Salesforce-org-inventory.xlsx with everyone invited',
  },
  {
    id: 'a3',
    day: 4,
    text: 'Sarah Chen granted access — Integration-vendor-contract.pdf → Wei Zhang',
  },
  { id: 'a4', day: 9, text: 'Sarah Chen shared Security-questionnaire.xlsx with everyone invited' },
];

let uid = 100;

export default function RequestFileAudience() {
  const [lens, setLens] = useState('client');
  const [viewAs, setViewAs] = useState('priya');
  const [danInvited, setDanInvited] = useState(false);
  const [weiDeclined, setWeiDeclined] = useState(false);
  const [files, setFiles] = useState(SEED_FILES);
  const [audit, setAudit] = useState(SEED_AUDIT);
  const [toast, setToast] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareName, setShareName] = useState('Scope-addendum.pdf');
  const [shareMode, setShareMode] = useState('all');
  const [sharePicks, setSharePicks] = useState([]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const trackPresent = (id) => (id === 'dan' ? danInvited : true);
  const trackLive = (id) => trackPresent(id) && !(id === 'wei' && weiDeclined);
  const liveIds = ['priya', 'wei', 'dan'].filter(trackLive);

  function canSee(trackId, file) {
    if (!trackPresent(trackId)) return false;
    if (file.deleted) return false;
    if (file.by === trackId) return true;
    if (file.by !== 'client') return false;
    if (file.audience.type === 'grants') return file.audience.to.includes(trackId);
    if (trackId === 'wei' && weiDeclined) return file.day < DECLINE_DAY;
    return true;
  }

  const visibleChips = (file) =>
    ['priya', 'wei', 'dan'].filter((t) => trackPresent(t) && canSee(t, file));

  function doShare() {
    const name = shareName.trim() || 'Scope-addendum.pdf';
    const audience =
      shareMode === 'all'
        ? { type: 'all' }
        : { type: 'grants', to: sharePicks.length ? sharePicks : [] };
    uid += 1;
    setFiles((f) => [
      ...f,
      {
        id: 'u' + uid,
        name,
        kind: name.endsWith('.xlsx') ? 'xlsx' : 'pdf',
        size: '1.0 MB',
        day: NOW_DAY,
        by: 'client',
        audience,
      },
    ]);
    if (shareMode === 'all') {
      setAudit((a) => [
        ...a,
        {
          id: 'u' + uid + 'a',
          day: NOW_DAY,
          text: `Sarah Chen shared ${name} with everyone invited`,
        },
      ]);
      setToast(
        `Shared with ${liveIds.length} expert${liveIds.length === 1 ? '' : 's'}. A note was posted in each conversation.`
      );
    } else {
      const names = sharePicks.map((t) => TRACKS[t].name).join(', ') || 'no one yet';
      setAudit((a) => [
        ...a,
        {
          id: 'u' + uid + 'a',
          day: NOW_DAY,
          text: `Sarah Chen granted access — ${name} → ${names}`,
        },
      ]);
      setToast(`Shared with ${names}.`);
    }
    setShareOpen(false);
    setSharePicks([]);
    setShareName('Scope-addendum.pdf');
  }

  function revoke(fileId, trackId) {
    const file = files.find((f) => f.id === fileId);
    setFiles((fs) =>
      fs.map((f) =>
        f.id === fileId && f.audience.type === 'grants'
          ? { ...f, audience: { type: 'grants', to: f.audience.to.filter((t) => t !== trackId) } }
          : f
      )
    );
    setAudit((a) => [
      ...a,
      {
        id: fileId + trackId + Math.random(),
        day: NOW_DAY,
        text: `Sarah Chen removed access — ${file.name} → ${TRACKS[trackId].name}`,
      },
    ]);
    setToast(`Access removed. ${TRACKS[trackId].name} is not notified.`);
  }

  function deleteFile(fileId) {
    const file = files.find((f) => f.id === fileId);
    if (!file) return;
    const actor = file.by === 'client' ? 'Sarah Chen' : TRACKS[file.by].name;
    setFiles((fs) =>
      fs.map((f) => (f.id === fileId ? { ...f, deleted: true, deletedDay: NOW_DAY } : f))
    );
    setAudit((a) => [
      ...a,
      {
        id: fileId + '-del-' + Math.random(),
        day: NOW_DAY,
        text: `${actor} removed ${file.name} (file retained for audit)`,
      },
    ]);
    setToast('File removed. No notification is sent.');
  }

  function expertUpload() {
    const t = TRACKS[viewAs];
    uid += 1;
    const name = `${t.name.split(' ')[0]}-proposal-draft.pdf`;
    setFiles((f) => [
      ...f,
      {
        id: 'u' + uid,
        name,
        kind: 'pdf',
        size: '760 KB',
        day: NOW_DAY,
        by: viewAs,
        audience: { type: 'own' },
      },
    ]);
    setToast('Uploaded. Visible to Acme Corp only.');
  }

  function reset() {
    setFiles(SEED_FILES);
    setAudit(SEED_AUDIT);
    setDanInvited(false);
    setWeiDeclined(false);
    setLens('client');
    setViewAs('priya');
    setToast(null);
    setShareOpen(false);
  }

  return (
    <div className="min-h-screen bg-zinc-100 font-sans text-zinc-900">
      <ControlStrip
        lens={lens}
        setLens={setLens}
        viewAs={viewAs}
        setViewAs={setViewAs}
        danInvited={danInvited}
        setDanInvited={setDanInvited}
        weiDeclined={weiDeclined}
        setWeiDeclined={setWeiDeclined}
        reset={reset}
      />

      <div className="mx-auto max-w-3xl px-4 py-6">
        <ContextBar danInvited={danInvited} weiDeclined={weiDeclined} />

        {lens === 'client' && (
          <ClientPanel
            files={files}
            audit={audit}
            liveIds={liveIds}
            weiDeclined={weiDeclined}
            revoke={revoke}
            deleteFile={deleteFile}
            openShare={() => setShareOpen(true)}
            visibleChips={visibleChips}
          />
        )}
        {lens === 'expert' && (
          <ExpertPanel
            files={files}
            viewAs={viewAs}
            canSee={canSee}
            weiDeclined={weiDeclined}
            danInvited={danInvited}
            expertUpload={expertUpload}
            deleteFile={deleteFile}
          />
        )}
        {lens === 'admin' && <AdminPanel files={files} audit={audit} visibleChips={visibleChips} />}
      </div>

      {shareOpen && (
        <ShareSheet
          liveIds={liveIds}
          shareName={shareName}
          setShareName={setShareName}
          shareMode={shareMode}
          setShareMode={setShareMode}
          sharePicks={sharePicks}
          setSharePicks={setSharePicks}
          onClose={() => setShareOpen(false)}
          onShare={doShare}
        />
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm text-zinc-50 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

/* ── control strip (simulation machinery, not product UI) ─────────────────── */

function ControlStrip(p) {
  return (
    <div className="border-b border-zinc-800 bg-zinc-950 px-4 py-3 text-zinc-300">
      <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs tracking-wider text-zinc-500 uppercase">Lens</span>
          <Segmented
            value={p.lens}
            onChange={p.setLens}
            options={[
              { v: 'client', label: 'Client' },
              { v: 'expert', label: 'Expert' },
              { v: 'admin', label: 'Admin' },
            ]}
          />
        </div>

        {p.lens === 'expert' && (
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs tracking-wider text-zinc-500 uppercase">
              Viewing as
            </span>
            <Segmented
              value={p.viewAs}
              onChange={p.setViewAs}
              options={[
                { v: 'priya', label: 'Priya' },
                { v: 'wei', label: 'Wei' },
                { v: 'dan', label: 'Dan', disabled: !p.danInvited },
              ]}
            />
          </div>
        )}

        <div className="flex items-center gap-4">
          <span className="font-mono text-xs tracking-wider text-zinc-500 uppercase">Scenario</span>
          <MiniToggle label="Dan invited · day 7" on={p.danInvited} set={p.setDanInvited} />
          <MiniToggle label="Wei declines · day 8" on={p.weiDeclined} set={p.setWeiDeclined} />
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="font-mono text-xs text-zinc-500">day {NOW_DAY}</span>
          <button
            onClick={p.reset}
            className="flex items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            <RotateCcw size={12} /> Reset
          </button>
        </div>
      </div>
    </div>
  );
}

function Segmented({ value, onChange, options }) {
  return (
    <div className="flex rounded-md border border-zinc-700 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          disabled={o.disabled}
          onClick={() => onChange(o.v)}
          className={
            'rounded px-2.5 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 ' +
            (value === o.v
              ? 'bg-zinc-100 font-medium text-zinc-900'
              : o.disabled
                ? 'cursor-not-allowed text-zinc-600'
                : 'text-zinc-300 hover:bg-zinc-800')
          }
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function MiniToggle({ label, on, set }) {
  return (
    <button
      onClick={() => set(!on)}
      className="flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
    >
      <span
        className={
          'flex h-4 w-7 items-center rounded-full p-0.5 transition-colors ' +
          (on ? 'justify-end bg-emerald-500' : 'justify-start bg-zinc-700')
        }
      >
        <span className="h-3 w-3 rounded-full bg-white" />
      </span>
      <span className="text-xs text-zinc-300">{label}</span>
    </button>
  );
}

/* ── shared context bar ───────────────────────────────────────────────────── */

function ContextBar({ danInvited, weiDeclined }) {
  return (
    <div className="mb-4">
      <div className="text-xs font-medium tracking-wide text-zinc-500 uppercase">
        Project request · Acme Corp
      </div>
      <h1 className="mt-0.5 text-lg font-semibold">CPQ rollout and billing integration</h1>
      <div className="mt-2 flex flex-wrap gap-2">
        <TrackChip t={TRACKS.priya} state="Live" />
        <TrackChip t={TRACKS.wei} state={weiDeclined ? 'Declined' : 'Live'} />
        {danInvited ? (
          <TrackChip t={TRACKS.dan} state="Live" />
        ) : (
          <span className="rounded-full border border-dashed border-zinc-300 px-3 py-1 text-xs text-zinc-400">
            Dan Okafor · not yet invited
          </span>
        )}
      </div>
    </div>
  );
}

function TrackChip({ t, state }) {
  const declined = state === 'Declined';
  return (
    <span
      className={
        'flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ' +
        (declined
          ? 'border-amber-300 bg-amber-50 text-amber-800'
          : 'border-zinc-300 bg-white text-zinc-700')
      }
    >
      <span
        className={'h-1.5 w-1.5 rounded-full ' + (declined ? 'bg-amber-500' : 'bg-emerald-500')}
      />
      {t.name} · {t.org} — {state}
    </span>
  );
}

/* ── client lens ──────────────────────────────────────────────────────────── */

function ClientPanel({
  files,
  audit,
  liveIds,
  weiDeclined,
  revoke,
  deleteFile,
  openShare,
  visibleChips,
}) {
  const ordered = files.filter((f) => !f.deleted).sort((a, b) => b.day - a.day);
  return (
    <div>
      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
          <div>
            <div className="text-sm font-semibold">Files on this request</div>
            <div className="text-xs text-zinc-500">
              You see every file. Experts see only what is shared with them.
            </div>
          </div>
          <button
            onClick={openShare}
            className="flex items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
          >
            <Upload size={14} /> Share a file
          </button>
        </div>

        <ul className="divide-y divide-zinc-100">
          {ordered.map((f) => (
            <li key={f.id} className="flex items-start gap-3 px-4 py-3">
              <FileGlyph kind={f.kind} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{f.name}</div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {f.by === 'client'
                    ? 'Sarah Chen · Acme Corp'
                    : `${TRACKS[f.by].name} · ${TRACKS[f.by].org}`}
                  {' · day '}
                  {f.day}
                  {' · '}
                  {f.size}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <AudienceBadges
                    f={f}
                    liveIds={liveIds}
                    weiDeclined={weiDeclined}
                    revoke={revoke}
                  />
                </div>
              </div>
              {f.by === 'client' && (
                <button
                  onClick={() => deleteFile(f.id)}
                  aria-label={`Remove ${f.name}`}
                  className="mt-0.5 rounded-md p-1 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 rounded-xl border border-zinc-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck size={14} className="text-zinc-400" /> Access history
        </div>
        <div className="mt-1 text-xs text-zinc-500">
          Every share and removal is recorded with who did it and when.
        </div>
        <ul className="mt-2 space-y-1">
          {[...audit]
            .sort((a, b) => b.day - a.day)
            .map((a) => (
              <li key={a.id} className="text-xs text-zinc-600">
                <span className="font-mono text-zinc-400">day {a.day}</span> · {a.text}
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

function AudienceBadges({ f, liveIds, weiDeclined, revoke }) {
  if (f.by !== 'client') {
    return (
      <span className="flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
        <Lock size={10} /> Their conversation only
      </span>
    );
  }
  if (f.audience.type === 'all') {
    return (
      <>
        <span className="flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
          <Users size={10} /> Everyone invited · {liveIds.length} live
        </span>
        {weiDeclined && f.day >= DECLINE_DAY && (
          <span className="text-xs text-zinc-400">Wei Zhang declined — not shared</span>
        )}
        {weiDeclined && f.day < DECLINE_DAY && (
          <span className="text-xs text-zinc-400">
            Wei Zhang kept access · shared before declining
          </span>
        )}
      </>
    );
  }
  if (f.audience.to.length === 0) {
    return (
      <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500">
        No experts have access
      </span>
    );
  }
  return (
    <>
      {f.audience.to.map((t) => (
        <span
          key={t}
          className="flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700"
        >
          {TRACKS[t].name} only
          <button
            onClick={() => revoke(f.id, t)}
            aria-label={`Remove access for ${TRACKS[t].name}`}
            className="rounded-full p-0.5 hover:bg-violet-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
          >
            <X size={10} />
          </button>
        </span>
      ))}
    </>
  );
}

/* ── expert lens ──────────────────────────────────────────────────────────── */

function ExpertPanel({ files, viewAs, canSee, weiDeclined, danInvited, expertUpload, deleteFile }) {
  const me = TRACKS[viewAs];
  const declined = viewAs === 'wei' && weiDeclined;
  const mine = files.filter((f) => canSee(viewAs, f)).sort((a, b) => b.day - a.day);
  const joinedLate = viewAs === 'dan' && danInvited;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="border-b border-zinc-100 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Eye size={14} className="text-zinc-400" />
          Viewing as {me.name} · {me.org}
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          Files shared between you and Acme Corp on this request.
        </div>
      </div>

      {declined && (
        <div className="border-b border-amber-100 bg-amber-50 px-4 py-2.5 text-xs text-amber-800">
          You declined this invitation on day {DECLINE_DAY}. Files shared with you before then stay
          available. New files are not shared with you.
        </div>
      )}

      <ul className="divide-y divide-zinc-100">
        {mine.map((f) => (
          <li key={f.id} className="flex items-start gap-3 px-4 py-3">
            <FileGlyph kind={f.kind} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{f.name}</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                {f.by === 'client' ? 'Shared by Acme Corp' : 'You uploaded'} · day {f.day} ·{' '}
                {f.size}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {f.by !== 'client' && (
                  <span className="flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600">
                    <Lock size={10} /> Visible to Acme Corp only
                  </span>
                )}
                {joinedLate && f.by === 'client' && f.day < TRACKS.dan.invitedDay && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    Shared day {f.day} · before you joined
                  </span>
                )}
              </div>
            </div>
            {f.by === viewAs && !declined && (
              <button
                onClick={() => deleteFile(f.id)}
                aria-label={`Remove ${f.name}`}
                className="mt-0.5 rounded-md p-1 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
              >
                <Trash2 size={14} />
              </button>
            )}
          </li>
        ))}
        {mine.length === 0 && (
          <li className="px-4 py-6 text-center text-sm text-zinc-400">
            No files yet. Upload one to share it with Acme Corp.
          </li>
        )}
      </ul>

      <div className="border-t border-zinc-100 px-4 py-3">
        <button
          onClick={expertUpload}
          disabled={declined}
          className={
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 ' +
            (declined
              ? 'cursor-not-allowed bg-zinc-100 text-zinc-400'
              : 'bg-zinc-900 text-white hover:bg-zinc-800')
          }
        >
          <Upload size={14} /> Upload to this conversation
        </button>
        <div className="mt-1.5 text-xs text-zinc-400">
          Uploads are visible to Acme Corp only. There is no audience to choose.
        </div>
      </div>
    </div>
  );
}

/* ── admin lens ───────────────────────────────────────────────────────────── */

function AdminPanel({ files, audit, visibleChips }) {
  const ordered = [...files].sort((a, b) => b.day - a.day);
  return (
    <div>
      <div className="mb-3 flex items-start gap-2 rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-2.5 text-xs text-zinc-600">
        <Info size={14} className="mt-0.5 shrink-0 text-zinc-400" />
        <span>
          Platform lens — gated by hasPlatformCapability (ADR-1035). The only surface where every
          file and its audience render together. Placement undecided (Admin Tracker §3.8); whether
          an admin download writes an access record is open.
        </span>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white">
        <div className="border-b border-zinc-100 px-4 py-3 text-sm font-semibold">
          All files on this request
        </div>
        <ul className="divide-y divide-zinc-100">
          {ordered.map((f) => (
            <li key={f.id} className="flex items-start gap-3 px-4 py-3">
              <FileGlyph kind={f.kind} />
              <div className="min-w-0 flex-1">
                <div
                  className={
                    'truncate text-sm font-medium' +
                    (f.deleted ? ' text-zinc-400 line-through' : '')
                  }
                >
                  {f.name}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {f.by === 'client'
                    ? 'Sarah Chen · Acme Corp'
                    : `${TRACKS[f.by].name} · ${TRACKS[f.by].org}`}
                  {' · day '}
                  {f.day}
                  {' · '}
                  {f.by !== 'client'
                    ? 'expert upload, own track'
                    : f.audience.type === 'all'
                      ? 'audience: all live tracks (dynamic)'
                      : 'audience: explicit grants'}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {f.deleted && (
                    <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                      Removed · record retained
                    </span>
                  )}
                  <span className="text-xs text-zinc-400">Visible now to:</span>
                  {visibleChips(f).length === 0 && (
                    <span className="text-xs text-zinc-400">no experts</span>
                  )}
                  {visibleChips(f).map((t) => (
                    <span
                      key={t}
                      className="flex items-center gap-1 rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-600"
                    >
                      <Check size={10} className="text-emerald-500" /> {TRACKS[t].name}
                    </span>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-4 rounded-xl border border-zinc-200 bg-white px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck size={14} className="text-zinc-400" /> audit_events
        </div>
        <ul className="mt-2 space-y-1">
          {[...audit]
            .sort((a, b) => b.day - a.day)
            .map((a) => (
              <li key={a.id} className="text-xs text-zinc-600">
                <span className="font-mono text-zinc-400">day {a.day}</span> · {a.text}
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}

/* ── share sheet (Dialog on desktop, full-screen Sheet on mobile) ─────────── */

function ShareSheet(p) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-zinc-900/40 p-4 sm:items-center">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm font-semibold">Share a file</div>
            <div className="mt-0.5 text-xs text-zinc-500">Choose who can see it.</div>
          </div>
          <button
            onClick={p.onClose}
            aria-label="Close"
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            <X size={16} />
          </button>
        </div>

        <label className="mt-4 block text-xs font-medium text-zinc-600">File name</label>
        <input
          value={p.shareName}
          onChange={(e) => p.setShareName(e.target.value)}
          className="mt-1 w-full rounded-md border border-zinc-300 px-3 py-1.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500"
        />

        <div className="mt-4 space-y-2">
          <button
            onClick={() => p.setShareMode('all')}
            className={
              'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 ' +
              (p.shareMode === 'all'
                ? 'border-zinc-900 bg-zinc-50'
                : 'border-zinc-200 hover:border-zinc-300')
            }
          >
            <Users size={15} className="mt-0.5 text-blue-600" />
            <span>
              <span className="block text-sm font-medium">
                Everyone invited · {p.liveIds.length} expert{p.liveIds.length === 1 ? '' : 's'}
              </span>
              <span className="block text-xs text-zinc-500">
                Experts invited later will also see this file.
              </span>
            </span>
          </button>

          <button
            onClick={() => p.setShareMode('grants')}
            className={
              'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 ' +
              (p.shareMode === 'grants'
                ? 'border-zinc-900 bg-zinc-50'
                : 'border-zinc-200 hover:border-zinc-300')
            }
          >
            <Lock size={15} className="mt-0.5 text-violet-600" />
            <span>
              <span className="block text-sm font-medium">Only specific experts</span>
              <span className="block text-xs text-zinc-500">
                For sensitive documents — an NDA-gated contract, for example.
              </span>
            </span>
          </button>

          {p.shareMode === 'grants' && (
            <div className="rounded-lg border border-zinc-200 p-2">
              {p.liveIds.map((t) => {
                const picked = p.sharePicks.includes(t);
                return (
                  <button
                    key={t}
                    onClick={() =>
                      p.setSharePicks(
                        picked ? p.sharePicks.filter((x) => x !== t) : [...p.sharePicks, t]
                      )
                    }
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
                  >
                    <span
                      className={
                        'flex h-4 w-4 items-center justify-center rounded border ' +
                        (picked ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300')
                      }
                    >
                      {picked && <Check size={11} />}
                    </span>
                    {TRACKS[t].name} · {TRACKS[t].org}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={p.onClose}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400"
          >
            Cancel
          </button>
          <button
            onClick={p.onShare}
            disabled={p.shareMode === 'grants' && p.sharePicks.length === 0}
            className={
              'rounded-md px-3 py-1.5 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 ' +
              (p.shareMode === 'grants' && p.sharePicks.length === 0
                ? 'cursor-not-allowed bg-zinc-200 text-zinc-400'
                : 'bg-zinc-900 text-white hover:bg-zinc-800')
            }
          >
            Share
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── bits ─────────────────────────────────────────────────────────────────── */

function FileGlyph({ kind }) {
  return (
    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500">
      {kind === 'xlsx' ? <FileSpreadsheet size={16} /> : <FileText size={16} />}
    </span>
  );
}
